// Package barcode 条码解析链（服务化版 M1.3 双库逻辑，D6 决策）。
//
// 解析顺序：商品档案 → 本地条码字典 → 云端（阿里云市场条码查询）。
//   - 本地命中即返回，永不因为「本地已有」去调云端；
//   - 云端查到 → 永久回填字典层；查无 → 写 not_found 标记（TTL 默认 90 天）；
//   - 云端连续失败达阈值 → 熔断到当日结束（source=blocked，保护配额）。
package barcode

import (
	"fmt"
	"strings"
	"time"

	"github.com/kiddyt00/sdy/server/internal/store"
)

// Config 解析链配置。
type Config struct {
	TTLDays  int // not_found 标记有效期（天）
	MaxFails int // 连续失败熔断阈值
}

// DefaultConfig 默认配置。
func DefaultConfig() Config { return Config{TTLDays: 90, MaxFails: 5} }

// CloudItem 云端返回的商品信息（只取名称与规格，价格/库存绝不自动采用）。
type CloudItem struct {
	Name string
	Spec string
}

// CloudFunc 云端查询函数：found=false 表示「查无此码」（属于正常业务结果，不算失败）。
type CloudFunc func(code string) (item CloudItem, found bool, err error)

// Result 解析结果。
type Result struct {
	Code   string `json:"code"`
	Found  bool   `json:"found"`
	Name   string `json:"name,omitempty"`
	Spec   string `json:"spec,omitempty"`
	Source string `json:"source"` // product / lib / cloud / not_found / cloud_error / blocked
	Error  string `json:"error,omitempty"`
}

// Resolver 解析器（含配额保护状态，需单实例复用）。
type Resolver struct {
	st    *store.Store
	cfg   Config
	cloud CloudFunc
	now   func() time.Time

	fails        int
	circuitUntil time.Time
}

// New 创建解析器；cloud 传 nil 表示纯本地模式（离线可用）。
func New(st *store.Store, cfg Config, cloud CloudFunc) *Resolver {
	if cfg.TTLDays <= 0 {
		cfg.TTLDays = DefaultConfig().TTLDays
	}
	if cfg.MaxFails <= 0 {
		cfg.MaxFails = DefaultConfig().MaxFails
	}
	return &Resolver{st: st, cfg: cfg, cloud: cloud, now: time.Now}
}

// SetClock 注入时钟（仅测试用）。
func (r *Resolver) SetClock(now func() time.Time) { r.now = now }

// Resolve 执行解析链。
func (r *Resolver) Resolve(code string) (Result, error) {
	code = strings.TrimSpace(code)
	if code == "" {
		return Result{}, fmt.Errorf("%w: 条码不能为空", store.ErrBadInput)
	}

	// ① 商品档案层（本店已有经营数据的商品）
	if p, err := r.st.GetProduct(code); err == nil {
		r.st.TouchLib(code)
		return Result{Code: code, Found: true, Name: p.Name, Spec: p.Spec, Source: "product"}, nil
	}

	// ② 本地条码字典层（永久缓存；not_found 标记按注入时钟判断是否过期）
	if e, ok := r.st.GetLibAt(code, r.now()); ok {
		if e.Status == "not_found" {
			return Result{Code: code, Found: false, Source: "not_found"}, nil
		}
		r.st.TouchLib(code)
		return Result{Code: code, Found: true, Name: e.Name, Spec: e.Spec, Source: "lib"}, nil
	}

	// ③ 云端（熔断保护）
	if r.now().Before(r.circuitUntil) {
		return Result{Code: code, Found: false, Source: "blocked",
			Error: "云端查询已熔断（连续失败过多），今日不再调用，可手动建档"}, nil
	}
	if r.cloud == nil {
		return Result{Code: code, Found: false, Source: "cloud_error",
			Error: "云端未配置（纯本地模式）"}, nil
	}

	item, found, err := r.cloud(code)
	if err != nil {
		r.fails++
		if r.fails >= r.cfg.MaxFails {
			r.circuitUntil = endOfDay(r.now())
		}
		return Result{Code: code, Found: false, Source: "cloud_error", Error: err.Error()}, nil
	}
	r.fails = 0

	if !found {
		// 查无：写 TTL 标记，避免短期内反复消耗配额（业务 400 同样消耗配额）
		_ = r.st.UpsertLib(store.LibEntry{
			Code: code, Source: "cloud", Status: "not_found",
			ExpiresAt: r.now().AddDate(0, 0, r.cfg.TTLDays).Format(time.RFC3339),
		})
		return Result{Code: code, Found: false, Source: "not_found"}, nil
	}

	// 查到：永久回填字典层（下次本地直接命中）
	if err := r.st.UpsertLib(store.LibEntry{
		Code: code, Name: item.Name, Spec: item.Spec, Source: "cloud", Status: "found",
	}); err != nil {
		return Result{}, err
	}
	r.st.TouchLib(code)
	return Result{Code: code, Found: true, Name: item.Name, Spec: item.Spec, Source: "cloud"}, nil
}

// Fails 当前连续失败次数（供 /healthz 诊断）。
func (r *Resolver) Fails() int { return r.fails }

// CircuitOpen 熔断是否生效。
func (r *Resolver) CircuitOpen() bool { return r.now().Before(r.circuitUntil) }

func endOfDay(t time.Time) time.Time {
	y, m, d := t.Date()
	return time.Date(y, m, d, 23, 59, 59, 0, t.Location())
}

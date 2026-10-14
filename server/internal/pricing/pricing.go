// Package pricing 价格与配送规则（M2 规则的 Go 实现，与 web/pricing.js 语义一致）。
package pricing

import (
	"fmt"
	"math"
)

// Config 规则配置（门店可调；默认值见 DefaultConfig）。
type Config struct {
	PickupFee        float64 // 自提费用（通常 0）
	MinFree          float64 // 配送免运费门槛
	DeliveryFee      float64 // 未达门槛时的配送费
	MaxRetailRatio   float64 // 零售价 ≤ 牵牛花参考价 × 该系数（默认 0.95，即低 5%）
	ExcludeWholesale bool    // 批发商品跳过比价防线
}

// DefaultConfig 默认规则（对应 M1.1 起沿用的占位规则）。
func DefaultConfig() Config {
	return Config{PickupFee: 0, MinFree: 30, DeliveryFee: 3, MaxRetailRatio: 0.95, ExcludeWholesale: true}
}

// Normalize 补齐零值，避免漏配导致规则失效。
// 注意：MinFree 刻意**不**在这里兜底。第 27 轮起 `MinFree <= 0` 是明确语义
// ——「永不包邮」（门槛 0 元意味着任何金额都达不到，所以永远收配送费）。
// 以前把 0 强制改回默认 30，导致老板在管理端配「0 元门槛」时服务端反而收钱，
// 三端口径对不上。是否包邮只由 MinFree 一个值决定，缺省 30 由 DefaultConfig 给。
func (c Config) Normalize() Config {
	d := DefaultConfig()
	if c.MaxRetailRatio <= 0 {
		c.MaxRetailRatio = d.MaxRetailRatio
	}
	return c
}

// DeliveryFee 计算运费：自提取 PickupFee；配送满 MinFree 免运费，否则 DeliveryFee。
// 比较前先把小计 round2，与前端 web/pricing.js、miniprogram/utils/rules.js 同口径——
// 否则 29.995 这类边界会「页面显示免运费、服务端实收 3 元」（第 27 轮修的钱错）。
// 未知配送方式按 delivery 处理（以前直接 400，前端传脏值时顾客端会白屏/静默 0 元）。
func DeliveryFee(kind string, subtotal float64, cfg Config) (float64, error) {
	cfg = cfg.Normalize()
	if kind != "pickup" {
		kind = "delivery"
	}
	s := Round2(subtotal)
	switch kind {
	case "pickup":
		return cfg.PickupFee, nil
	default:
		// MinFree <= 0＝「不免运费」：注意不能写成 s >= cfg.MinFree——那样门槛 0 会让
		// 任何金额都免运费，正好把语义搞反。必须显式要求门槛为正。
		if cfg.MinFree > 0 && s >= cfg.MinFree {
			return 0, nil
		}
		return cfg.DeliveryFee, nil
	}
}

// 订单状态中文文案（第 27 轮收敛为服务端唯一真源）：前端不再各自硬编码一份，
// 显示时读响应里的 statusText。这样改文案只改这一处。
const (
	StatusPending    = "pending"
	StatusDelivering = "delivering"
	StatusReady      = "ready"
	StatusDone       = "done"
	StatusCancelled  = "cancelled"
)

var statusLabels = map[string]string{
	StatusPending:    "待备货",
	StatusDelivering: "配送中",
	StatusReady:      "待取货",
	StatusDone:       "已完成",
	StatusCancelled:  "已取消",
}

// StatusText 订单状态的中文文案；未知状态原样返回（不吞掉脏值，便于排查）。
func StatusText(status string) string {
	if s, ok := statusLabels[status]; ok {
		return s
	}
	return status
}

// Result 比价检查结果。
type Result struct {
	OK      bool    `json:"ok"`
	Skip    string  `json:"skip,omitempty"`    // wholesale / no_ref
	Cap     float64 `json:"cap,omitempty"`     // 合规上限
	DiffPct float64 `json:"diffPct,omitempty"` // 相对参考价的偏离百分比
	Msg     string  `json:"msg,omitempty"`
}

// CheckRetailPrice 零售价比价防线：售价不得超过参考价的 MaxRetailRatio（防止平台比价处罚）。
func CheckRetailPrice(salePrice, refPrice float64, wholesale bool, cfg Config) Result {
	cfg = cfg.Normalize()
	if wholesale && cfg.ExcludeWholesale {
		return Result{OK: true, Skip: "wholesale"}
	}
	if refPrice <= 0 {
		return Result{OK: true, Skip: "no_ref"}
	}
	capPrice := Round2(refPrice * cfg.MaxRetailRatio)
	if salePrice > capPrice {
		return Result{
			OK: false, Cap: capPrice,
			DiffPct: round1((salePrice - refPrice) / refPrice * 100),
			Msg: fmt.Sprintf("售价 %.2f 超过比价防线 %.2f（牵牛花参考价 %.2f 的 -%.0f%% 内），存在平台比价处罚风险",
				salePrice, capPrice, refPrice, (1-cfg.MaxRetailRatio)*100),
		}
	}
	return Result{OK: true, Cap: capPrice}
}

// 顾客等级（任务池⑦，D24）：同一件商品按顾客等级显示不同价。
// 等级按手机号归档（无账号体系，手机号即身份，延续 D18）。
const (
	TierRetail    = "retail"    // 零售（默认）
	TierWholesale = "wholesale" // 批发
	TierVIP       = "vip"       // 白名单
)

// ValidTier 校验等级取值；空串按零售处理（缺字段视为旧行为，延续 D23）。
func ValidTier(t string) bool {
	return t == "" || t == TierRetail || t == TierWholesale || t == TierVIP
}

// NormalizeTier 把空串与**未知等级**都归一成零售，避免库里的脏值（如 'foo'）透出到
// 响应里让前端 label 查不到文案。写路径 ValidTier 仍会拒绝非法值，这里兜的是读路径。
func NormalizeTier(t string) string {
	if t == TierWholesale || t == TierVIP {
		return t
	}
	return TierRetail
}

// IsWholesaleTier 非零售等级（批发 / 白名单）：取批发价，且不参与零售比价防线。
func IsWholesaleTier(t string) bool {
	return t == TierWholesale || t == TierVIP
}

// EffectivePrice 按顾客等级取有效价：非零售等级且批发价大于 0 时用批发价，否则用零售价。
// 服务端与前端调同一个函数语义（web/pricing.js 的 effectivePrice），保证页面显示与订单入库同价。
func EffectivePrice(tier string, salePrice, wholesalePrice float64) float64 {
	if IsWholesaleTier(tier) && wholesalePrice > 0 {
		return Round2(wholesalePrice)
	}
	return Round2(salePrice)
}

// Round2 取两位小数（与 JS Math.round(v*100)/100 同口径）。
// 导出给 HTTP 层与 store 层共用，避免各处再抄一份取整实现（第 27 轮单一真源）。
func Round2(v float64) float64 { return math.Floor(v*100+0.5) / 100 }

// MinOrderGap 起送价差额：goods 未达 minOrder 时返回还差多少（已 round2），
// 达标或 minOrder<=0（不限起送）时返回 0。返回 0 即「可以下单」。
func MinOrderGap(goods, minOrder float64) float64 {
	if minOrder <= 0 {
		return 0
	}
	if goods >= minOrder {
		return 0
	}
	return Round2(minOrder - goods)
}

// Item 参与巡检的商品。
type Item struct {
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	SalePrice   float64 `json:"salePrice"`
	RefPrice    float64 `json:"refPrice"`
	IsWholesale bool    `json:"isWholesale"`
}

// Violation 违规条目。
type Violation struct {
	Code   string `json:"code"`
	Name   string `json:"name"`
	Result Result `json:"result"`
}

// PricingCheck 批量巡检（返回总数与违规清单）。
func PricingCheck(items []Item, cfg Config) (int, []Violation) {
	violations := []Violation{}
	for _, it := range items {
		r := CheckRetailPrice(it.SalePrice, it.RefPrice, it.IsWholesale, cfg)
		if !r.OK {
			violations = append(violations, Violation{Code: it.Code, Name: it.Name, Result: r})
		}
	}
	return len(items), violations
}

// round2 / round1 与 JS Math.round 行为一致（四舍五入，负数取更接近值）。
func round2(f float64) float64 { return math.Floor(f*100+0.5) / 100 }
func round1(f float64) float64 { return math.Floor(f*10+0.5) / 10 }

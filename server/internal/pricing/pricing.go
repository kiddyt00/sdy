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
func (c Config) Normalize() Config {
	d := DefaultConfig()
	if c.MaxRetailRatio <= 0 {
		c.MaxRetailRatio = d.MaxRetailRatio
	}
	if c.MinFree <= 0 {
		c.MinFree = d.MinFree
	}
	return c
}

// DeliveryFee 计算运费：自提取 PickupFee；配送满 MinFree 免运费，否则 DeliveryFee。
func DeliveryFee(kind string, subtotal float64, cfg Config) (float64, error) {
	cfg = cfg.Normalize()
	switch kind {
	case "pickup":
		return cfg.PickupFee, nil
	case "delivery":
		if subtotal >= cfg.MinFree {
			return 0, nil
		}
		return cfg.DeliveryFee, nil
	default:
		return 0, fmt.Errorf("未知配送方式：%s", kind)
	}
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
	capPrice := round2(refPrice * cfg.MaxRetailRatio)
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

// NormalizeTier 把空串归一成零售，避免各处各写一遍判定。
func NormalizeTier(t string) string {
	if t == "" {
		return TierRetail
	}
	return t
}

// IsWholesaleTier 非零售等级（批发 / 白名单）：取批发价，且不参与零售比价防线。
func IsWholesaleTier(t string) bool {
	return t == TierWholesale || t == TierVIP
}

// EffectivePrice 按顾客等级取有效价：非零售等级且批发价大于 0 时用批发价，否则用零售价。
// 服务端与前端调同一个函数语义（web/pricing.js 的 effectivePrice），保证页面显示与订单入库同价。
func EffectivePrice(tier string, salePrice, wholesalePrice float64) float64 {
	if IsWholesaleTier(tier) && wholesalePrice > 0 {
		return round2(wholesalePrice)
	}
	return round2(salePrice)
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

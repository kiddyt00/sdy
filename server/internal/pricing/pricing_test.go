package pricing

import "testing"

func TestDeliveryFee(t *testing.T) {
	cfg := DefaultConfig()
	cases := []struct {
		kind     string
		subtotal float64
		want     float64
	}{
		{"pickup", 0, 0},
		{"pickup", 100, 0},
		{"delivery", 29.99, 3},
		{"delivery", 30, 0},
		{"delivery", 55.5, 0},
	}
	for _, c := range cases {
		got, err := DeliveryFee(c.kind, c.subtotal, cfg)
		if err != nil {
			t.Fatalf("DeliveryFee(%s,%v) 报错: %v", c.kind, c.subtotal, err)
		}
		if got != c.want {
			t.Errorf("DeliveryFee(%s,%v)=%v，期望 %v", c.kind, c.subtotal, got, c.want)
		}
	}
	if _, err := DeliveryFee("drone", 100, cfg); err == nil {
		t.Error("未知配送方式应当报错")
	}
}

func TestDeliveryFeeCustomConfig(t *testing.T) {
	cfg := Config{PickupFee: 2, MinFree: 50, DeliveryFee: 5, MaxRetailRatio: 0.9, ExcludeWholesale: true}
	if got, _ := DeliveryFee("delivery", 49.99, cfg); got != 5 {
		t.Errorf("49.99 期望 5，实际 %v", got)
	}
	if got, _ := DeliveryFee("delivery", 50, cfg); got != 0 {
		t.Errorf("50 期望 0，实际 %v", got)
	}
	if got, _ := DeliveryFee("pickup", 10, cfg); got != 2 {
		t.Errorf("自提期望 2，实际 %v", got)
	}
}

func TestCheckRetailPrice(t *testing.T) {
	cfg := DefaultConfig()

	r := CheckRetailPrice(5, 5.2, false, cfg)
	if r.OK {
		t.Fatal("5 元 vs 参考价 5.2 应判超价（上限 4.94）")
	}
	if r.Cap != 4.94 {
		t.Errorf("上限期望 4.94，实际 %v", r.Cap)
	}
	if r.DiffPct != -3.8 {
		t.Errorf("偏离期望 -3.8%%，实际 %v", r.DiffPct)
	}

	if r := CheckRetailPrice(4.94, 5.2, false, cfg); !r.OK {
		t.Error("正好压线应合规")
	}
	if r := CheckRetailPrice(4.0, 5.2, false, cfg); !r.OK {
		t.Error("低于上限应合规")
	}
	if r := CheckRetailPrice(9, 10, false, cfg); !r.OK {
		t.Error("9 vs 10 应合规（上限 9.5）")
	}
	if r := CheckRetailPrice(5, 0, false, cfg); !r.OK || r.Skip != "no_ref" {
		t.Error("无参考价应跳过")
	}
	if r := CheckRetailPrice(99, 10, true, cfg); !r.OK || r.Skip != "wholesale" {
		t.Error("批发应跳过比价防线")
	}
	if r := CheckRetailPrice(9.01, 10, false, Config{MaxRetailRatio: 0.9, MinFree: 30, DeliveryFee: 3}); r.OK {
		t.Error("比例 0.9 时 9.01 应超价")
	}
}

func TestPricingCheck(t *testing.T) {
	items := []Item{
		{Code: "6901", Name: "可乐", SalePrice: 2.5, RefPrice: 3.0},
		{Code: "6902", Name: "农夫", SalePrice: 2.0, RefPrice: 2.0}, // 超价（上限 1.9）
		{Code: "6903", Name: "抽纸", SalePrice: 4.0, RefPrice: 0},   // 无参考价跳过
	}
	total, vs := PricingCheck(items, DefaultConfig())
	if total != 3 {
		t.Errorf("总数期望 3，实际 %d", total)
	}
	if len(vs) != 1 || vs[0].Code != "6902" {
		t.Errorf("违规清单期望仅 6902，实际 %+v", vs)
	}
	if _, vs := PricingCheck([]Item{}, DefaultConfig()); len(vs) != 0 {
		t.Error("空列表应无违规")
	}
}

// 任务池⑦ / D24：等级 → 有效价的取价口径。
func TestEffectivePrice(t *testing.T) {
	cases := []struct {
		tier        string
		sale, whole float64
		want        float64
	}{
		{TierRetail, 60, 52, 60},
		{"", 60, 52, 60}, // 缺字段视为零售（老库 / 老前端）
		{TierWholesale, 60, 52, 52},
		{TierVIP, 60, 52, 52}, // 白名单同批发口径
		{TierWholesale, 60, 0, 60},
		{TierWholesale, 60.005, 0, 60.01},  // 一律 round2，与订单入库同口径
		{TierWholesale, 60, 52.005, 52.01}, // 批发价同样 round2
	}
	for _, c := range cases {
		if got := EffectivePrice(c.tier, c.sale, c.whole); got != c.want {
			t.Errorf("EffectivePrice(%q,%v,%v) = %v，期望 %v", c.tier, c.sale, c.whole, got, c.want)
		}
	}
	if !ValidTier("") || !ValidTier(TierRetail) || !ValidTier(TierWholesale) || !ValidTier(TierVIP) {
		t.Error("已知等级都应合法（含空串）")
	}
	if ValidTier("gold") {
		t.Error("未知等级应不合法")
	}
	if NormalizeTier("") != TierRetail || NormalizeTier(TierVIP) != TierVIP {
		t.Error("NormalizeTier 应把空串归一成零售")
	}
	if IsWholesaleTier(TierRetail) || !IsWholesaleTier(TierWholesale) || !IsWholesaleTier(TierVIP) {
		t.Error("IsWholesaleTier 判定不对")
	}
}

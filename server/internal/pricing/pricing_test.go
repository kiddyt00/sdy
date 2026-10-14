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
	if _, err := DeliveryFee("drone", 100, cfg); err != nil {
		t.Errorf("第 27 轮起未知配送方式按 delivery 处理，不应报错: %v", err)
	}
}

// 第 27 轮：免运费门槛必须先 round2 再比较（与 web/pricing.js、小程序 rules.js 同口径），
// 否则 29.999 这类金额会出现「前端显示免运费、服务端实收 3 元」。
func TestDeliveryFeeRoundsBeforeCompare(t *testing.T) {
	cfg := DefaultConfig() // MinFree=30, DeliveryFee=3
	cases := []struct {
		subtotal float64
		want     float64
	}{
		{29.994, 3}, // round2 → 29.99，仍差 1 分钱
		{29.995, 0}, // round2 → 30（与 JS Math.round(29.995*100)/100 同口径）
		{29.999, 0}, // round2 → 30，正好达标
		{30, 0},
	}
	for _, c := range cases {
		got, err := DeliveryFee("delivery", c.subtotal, cfg)
		if err != nil {
			t.Fatalf("DeliveryFee(delivery,%v) 报错: %v", c.subtotal, err)
		}
		if got != c.want {
			t.Errorf("DeliveryFee(delivery,%v)=%v，期望 %v（round2=%v）",
				c.subtotal, got, c.want, Round2(c.subtotal))
		}
	}
	if Round2(29.999) != 30 {
		t.Errorf("Round2(29.999) 期望 30，实际 %v", Round2(29.999))
	}
}

// 第 27 轮：MinFree<=0 表示「永不包邮」（不再被 Normalize 强制改回 30）。
func TestDeliveryFeeMinFreeZeroMeansNeverFree(t *testing.T) {
	cfg := Config{PickupFee: 0, MinFree: 0, DeliveryFee: 3, MaxRetailRatio: 0.95, ExcludeWholesale: true}
	if got := cfg.Normalize().MinFree; got != 0 {
		t.Fatalf("Normalize 不应把 MinFree=0 改回 30，实际 %v", got)
	}
	if got, _ := DeliveryFee("delivery", 1000, cfg); got != 3 {
		t.Errorf("MinFree=0 时应始终收配送费 3，实际 %v", got)
	}
	if got, _ := DeliveryFee("delivery", 0, cfg); got != 3 {
		t.Errorf("MinFree=0、货款 0 时应收配送费 3，实际 %v", got)
	}
	neg := Config{MinFree: -1, DeliveryFee: 3}
	if got, _ := DeliveryFee("delivery", 999, neg); got != 3 {
		t.Errorf("MinFree<0 同样表示永不包邮，实际 %v", got)
	}
	if got := DefaultConfig().Normalize().MinFree; got != 30 {
		t.Errorf("默认配置的 30 应保留，实际 %v", got)
	}
}

// 第 27 轮：未知配送方式按 delivery 处理（不再 400），自提仍取 PickupFee。
func TestDeliveryFeeUnknownKindFallsBackToDelivery(t *testing.T) {
	cfg := DefaultConfig()
	if got, _ := DeliveryFee("express", 10, cfg); got != 3 {
		t.Errorf("未知方式应按配送计费 3，实际 %v", got)
	}
	if got, _ := DeliveryFee("", 10, cfg); got != 3 {
		t.Errorf("空方式应按配送计费 3，实际 %v", got)
	}
	if got, _ := DeliveryFee("pickup", 10, cfg); got != 0 {
		t.Errorf("自提应取 PickupFee=0，实际 %v", got)
	}
}

// 第 27 轮：起送价差额（POST /api/orders 的「还差 X 元起送」）。
func TestMinOrderGap(t *testing.T) {
	cases := []struct {
		goods, minOrder, want float64
	}{
		{10, 0, 0},      // 不限起送
		{10, -5, 0},     // 负数同样表示不限
		{10, 30, 20},    // 还差 20
		{30, 30, 0},     // 正好达标
		{31, 30, 0},     // 超出
		{29.999, 30, 0}, // 先 round2 → 30，正好达标
		{29.994, 30, 0.01},
	}
	for _, c := range cases {
		if got := MinOrderGap(c.goods, c.minOrder); got != c.want {
			t.Errorf("MinOrderGap(%v,%v)=%v，期望 %v", c.goods, c.minOrder, got, c.want)
		}
	}
}

// 第 27 轮：状态中文文案集中一处（真源=Go）。
func TestStatusText(t *testing.T) {
	cases := map[string]string{
		StatusPending:    "待备货",
		StatusDelivering: "配送中",
		StatusReady:      "待取货",
		StatusDone:       "已完成",
		StatusCancelled:  "已取消",
	}
	for status, want := range cases {
		if got := StatusText(status); got != want {
			t.Errorf("StatusText(%q)=%q，期望 %q", status, got, want)
		}
	}
	if got := StatusText("weird"); got != "weird" {
		t.Errorf("未知状态应原样返回，实际 %q", got)
	}
	// 常量本身也必须是稳定字符串（三端按它对齐）
	if StatusPending != "pending" || StatusDelivering != "delivering" || StatusReady != "ready" ||
		StatusDone != "done" || StatusCancelled != "cancelled" {
		t.Error("订单状态常量取值被改了（三端契约会断）")
	}
}

// 第 27 轮：脏 tier 一律归零售（不再原样透出）。
func TestNormalizeTierDirtyValues(t *testing.T) {
	for _, in := range []string{"", "foo", "GOLD", "retailX", "  ", "gold"} {
		if got := NormalizeTier(in); got != TierRetail {
			t.Errorf("NormalizeTier(%q)=%q，期望 retail", in, got)
		}
	}
	if got := NormalizeTier(TierWholesale); got != TierWholesale {
		t.Errorf("批发等级应保留，实际 %q", got)
	}
	if got := NormalizeTier(TierVIP); got != TierVIP {
		t.Errorf("白名单等级应保留，实际 %q", got)
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

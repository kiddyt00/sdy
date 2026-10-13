package store

import (
	"errors"
	"strings"
	"testing"

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

func newTestStore(t *testing.T) *Store {
	t.Helper()
	st, err := Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	return st
}

func seed(t *testing.T, st *Store) {
	t.Helper()
	items := []Product{
		{Code: "6901", Name: "可乐", Category: "饮料", Unit: "罐", SalePrice: 2.5, Stock: 120, SyncStatus: "synced"},
		{Code: "6902", Name: "农夫", Category: "饮料", Unit: "瓶", SalePrice: 1.8, Stock: 3, SyncStatus: "synced"},
	}
	for _, p := range items {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品失败: %v", err)
		}
	}
}

func TestUpsertAndGetProduct(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	p, err := st.GetProduct("6901")
	if err != nil {
		t.Fatalf("取商品失败: %v", err)
	}
	if p.Name != "可乐" || p.Stock != 120 {
		t.Errorf("商品字段不正确: %+v", p)
	}
	// 建档自动沉淀进条码字典层（D6）
	if e, ok := st.GetLib("6901"); !ok || e.Source != "product" || e.Status != "found" {
		t.Errorf("建档未写入字典层: %+v ok=%v", e, ok)
	}
	// 覆盖更新
	if _, err := st.UpsertProduct(Product{Code: "6901", Name: "可口可乐", SalePrice: 2.6, Stock: 100}); err != nil {
		t.Fatal(err)
	}
	p, _ = st.GetProduct("6901")
	if p.Name != "可口可乐" || p.SalePrice != 2.6 || p.Stock != 100 {
		t.Errorf("覆盖更新未生效: %+v", p)
	}
	if _, err := st.GetProduct("9999"); !errors.Is(err, ErrNotFound) {
		t.Error("不存在的商品应返回 ErrNotFound")
	}
	if _, err := st.UpsertProduct(Product{}); !errors.Is(err, ErrBadInput) {
		t.Error("空条码应返回 ErrBadInput")
	}
}

func TestListProductsFilter(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	if list, _ := st.ListProducts("", ""); len(list) != 2 {
		t.Errorf("全量期望 2，实际 %d", len(list))
	}
	if list, _ := st.ListProducts("可乐", ""); len(list) != 1 {
		t.Errorf("关键字过滤期望 1，实际 %d", len(list))
	}
	if list, _ := st.ListProducts("", "饮料"); len(list) != 2 {
		t.Errorf("分类过滤期望 2，实际 %d", len(list))
	}
	if list, _ := st.ListProducts("", "酒水"); len(list) != 0 {
		t.Errorf("无匹配期望 0，实际 %d", len(list))
	}
}

func TestSetStockMarksPending(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	p, err := st.SetStock("6901", 88)
	if err != nil {
		t.Fatal(err)
	}
	if p.Stock != 88 || p.SyncStatus != "pending" {
		t.Errorf("改数后期望 pending，实际 %+v", p)
	}
	if _, err := st.SetStock("6901", -1); !errors.Is(err, ErrBadInput) {
		t.Error("负库存应被拒绝")
	}
	if _, err := st.SetStock("9999", 1); !errors.Is(err, ErrNotFound) {
		t.Error("不存在的商品应报 ErrNotFound")
	}
}

func TestCreateOrderPickup(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	o, err := st.CreateOrder(NewOrderInput{
		CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 5}},
	})
	if err != nil {
		t.Fatalf("下单失败: %v", err)
	}
	if o.Status != "pending" {
		t.Errorf("新单状态期望 pending，实际 %s", o.Status)
	}
	if o.Subtotal != 12.5 || o.DeliveryFee != 0 || o.Total != 12.5 {
		t.Errorf("金额计算错误: %+v", o)
	}
	if len(o.Items) != 1 || o.Items[0].Name != "可乐" || o.Items[0].Price != 2.5 {
		t.Errorf("明细错误: %+v", o.Items)
	}
	p, _ := st.GetProduct("6901")
	if p.Stock != 115 {
		t.Errorf("库存期望 115，实际 %v", p.Stock)
	}
	if got, err := st.GetOrder(o.ID); err != nil || got.ID != o.ID {
		t.Errorf("回读订单失败: %v", err)
	}
}

func TestCreateOrderDeliveryFee(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	// 未达 30 元门槛 → 3 元运费
	o, err := st.CreateOrder(NewOrderInput{
		CustomerName: "李四", Phone: "13800002222", Address: "某某路 1 号", DeliveryType: "delivery",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 2}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if o.Subtotal != 5 || o.DeliveryFee != 3 || o.Total != 8 {
		t.Errorf("未达门槛运费错误: %+v", o)
	}
	// 达门槛 → 免运费
	o2, err := st.CreateOrder(NewOrderInput{
		CustomerName: "李四", Phone: "13800002222", Address: "某某路 1 号", DeliveryType: "delivery",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 12}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if o2.Subtotal != 30 || o2.DeliveryFee != 0 || o2.Total != 30 {
		t.Errorf("达门槛应免运费: %+v", o2)
	}
}

func TestCreateOrderValidation(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	base := NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}

	cases := []struct {
		name  string
		patch func(in *NewOrderInput)
	}{
		{"配送方式非法", func(in *NewOrderInput) { in.DeliveryType = "drone" }},
		{"缺姓名", func(in *NewOrderInput) { in.CustomerName = "" }},
		{"缺手机号", func(in *NewOrderInput) { in.Phone = "" }},
		{"配送缺地址", func(in *NewOrderInput) { in.DeliveryType = "delivery"; in.Address = "" }},
		{"购物车为空", func(in *NewOrderInput) { in.Items = nil }},
		{"数量非正", func(in *NewOrderInput) { in.Items = []NewOrderInputItem{{Code: "6901", Qty: 0}} }},
		{"商品不存在", func(in *NewOrderInput) { in.Items = []NewOrderInputItem{{Code: "9999", Qty: 1}} }},
	}
	for _, c := range cases {
		in := base
		c.patch(&in)
		if _, err := st.CreateOrder(in); err == nil {
			t.Errorf("%s：应当报错", c.name)
		}
	}
	if list, _ := st.ListOrders(""); len(list) != 0 {
		t.Errorf("校验失败不应产生订单，实际 %d 单", len(list))
	}
}

func TestCreateOrderInsufficientStock(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	// 6902 只有 3 件，一次要 4 件 → 整单拦截，库存不动
	_, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6902", Qty: 4}}})
	if !errors.Is(err, ErrStockLess) {
		t.Fatalf("期望 ErrStockLess，实际 %v", err)
	}
	p, _ := st.GetProduct("6902")
	if p.Stock != 3 {
		t.Errorf("被拦截的订单不应扣库存，实际 %v", p.Stock)
	}
	// 多商品场景：第一件有货、第二件不足 → 整单回滚
	_, err = st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}, {Code: "6902", Qty: 9}}})
	if !errors.Is(err, ErrStockLess) {
		t.Fatalf("期望整单拦截，实际 %v", err)
	}
	p1, _ := st.GetProduct("6901")
	if p1.Stock != 120 {
		t.Errorf("整单应回滚，6901 库存实际 %v", p1.Stock)
	}
}

func TestAdvanceOrderStateMachine(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	o, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 5}}})
	if err != nil {
		t.Fatal(err)
	}
	// 非法流转 pending → done
	if _, err := st.AdvanceOrder(o.ID, "done"); !errors.Is(err, ErrConflict) {
		t.Errorf("pending→done 应被拒绝，实际 %v", err)
	}
	// 合法 pending → delivering
	o, err = st.AdvanceOrder(o.ID, "delivering")
	if err != nil || o.Status != "delivering" {
		t.Fatalf("pending→delivering 失败: %v status=%s", err, o.Status)
	}
	// 非法 delivering → ready
	if _, err := st.AdvanceOrder(o.ID, "ready"); !errors.Is(err, ErrConflict) {
		t.Error("delivering→ready 应被拒绝")
	}
	o, err = st.AdvanceOrder(o.ID, "done")
	if err != nil || o.Status != "done" {
		t.Fatalf("delivering→done 失败: %v", err)
	}
	// 终态不可再流转
	if _, err := st.AdvanceOrder(o.ID, "cancelled"); !errors.Is(err, ErrConflict) {
		t.Error("done 为终态，不应再流转")
	}
	if _, err := st.AdvanceOrder("M404", "done"); !errors.Is(err, ErrNotFound) {
		t.Error("不存在的订单应报 ErrNotFound")
	}
}

func TestCancelOrderRestoresStock(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	o, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 10}}})
	if err != nil {
		t.Fatal(err)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 110 {
		t.Fatalf("下单后库存期望 110，实际 %v", p.Stock)
	}
	o, err = st.AdvanceOrder(o.ID, "cancelled")
	if err != nil || o.Status != "cancelled" {
		t.Fatalf("取消失败: %v", err)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 120 {
		t.Errorf("取消应回补库存到 120，实际 %v", p.Stock)
	}
	// 已发货订单不可取消
	o2, _ := st.CreateOrder(NewOrderInput{CustomerName: "李四", Phone: "13800003333", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}})
	if _, err := st.AdvanceOrder(o2.ID, "delivering"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AdvanceOrder(o2.ID, "cancelled"); !errors.Is(err, ErrConflict) {
		t.Error("配送中订单不可取消")
	}
}

func TestListOrdersAndCustomer(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	for i := 0; i < 3; i++ {
		if _, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
			Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}); err != nil {
			t.Fatal(err)
		}
	}
	if list, _ := st.ListOrders(""); len(list) != 3 {
		t.Errorf("全量订单期望 3，实际 %d", len(list))
	}
	if list, _ := st.ListOrders("pending"); len(list) != 3 {
		t.Errorf("pending 订单期望 3，实际 %d", len(list))
	}
	if list, _ := st.ListOrders("done"); len(list) != 0 {
		t.Errorf("done 订单期望 0，实际 %d", len(list))
	}
	// 下单自动建顾客档案（同手机号不重复）
	var n int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM customer WHERE phone='13800001111'`).Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("顾客档案期望 1 条，实际 %d", n)
	}
	if err := st.RecordSyncBatch("reconcile", "牵牛花导出.csv", 10, 8, 2); err != nil {
		t.Fatal(err)
	}
}

func TestListLib(t *testing.T) {
	st := newTestStore(t)
	seed(t, st) // 建档即沉淀字典层 → 2 条
	if err := st.UpsertLib(LibEntry{Code: "6909", Source: "cloud", Status: "not_found",
		ExpiresAt: "2027-01-01T00:00:00+08:00"}); err != nil {
		t.Fatal(err)
	}
	all, err := st.ListLib(0)
	if err != nil {
		t.Fatalf("ListLib 失败: %v", err)
	}
	if len(all) != 3 {
		t.Fatalf("期望 3 条字典项，实际 %d：%+v", len(all), all)
	}
	codes := map[string]string{}
	for _, e := range all {
		codes[e.Code] = e.Source
	}
	if codes["6901"] != "product" {
		t.Errorf("建档应沉淀 source=product 的字典项，实际 %q", codes["6901"])
	}
	if codes["6909"] != "cloud" {
		t.Errorf("期望云端字典项 source=cloud，实际 %q", codes["6909"])
	}
	one, err := st.ListLib(1)
	if err != nil {
		t.Fatal(err)
	}
	if len(one) != 1 {
		t.Errorf("limit 未生效：期望 1 条，实际 %d", len(one))
	}
}

// TestUpsertProductValidation 商品建档/编辑入参校验（表单第一道防线在服务端）。
func TestUpsertProductValidation(t *testing.T) {
	st := newTestStore(t)
	cases := []struct {
		name string
		in   Product
	}{
		{"空条码", Product{Name: "可乐"}},
		{"空名称", Product{Code: "6901"}},
		{"名称为空白", Product{Code: "6901", Name: "   "}},
		{"售价为负", Product{Code: "6901", Name: "可乐", SalePrice: -1}},
		{"进价为负", Product{Code: "6901", Name: "可乐", CostPrice: -0.5}},
		{"参考价为负", Product{Code: "6901", Name: "可乐", RefPrice: -2}},
		{"库存为负", Product{Code: "6901", Name: "可乐", SalePrice: 2, Stock: -3}},
	}
	for _, c := range cases {
		if _, err := st.UpsertProduct(c.in); !errors.Is(err, ErrBadInput) {
			t.Errorf("%s 应返回 ErrBadInput，实际 %v", c.name, err)
		}
	}

	// 归一化：单位/分类留空 → 件 / 未分类；条码两侧空白被去掉
	p, err := st.UpsertProduct(Product{Code: "  6903  ", Name: "散装花生", SalePrice: 8})
	if err != nil {
		t.Fatal(err)
	}
	if p.Code != "6903" || p.Unit != "件" || p.Category != "未分类" {
		t.Errorf("归一化失败: %+v", p)
	}
	if err := st.DeleteProduct("6903"); err != nil {
		t.Fatalf("库存为 0 的商品应可删除: %v", err)
	}
}

// TestUpsertProductPriceGuard 价格防线：零售价 > 参考价 ×0.95 一律拒绝，批发商品豁免。
func TestUpsertProductPriceGuard(t *testing.T) {
	st := newTestStore(t)
	// 参考价 4.00 → 上限 3.80
	if _, err := st.UpsertProduct(Product{Code: "6901", Name: "可乐", SalePrice: 3.8, RefPrice: 4}); err != nil {
		t.Fatalf("恰好压线应通过: %v", err)
	}
	_, err := st.UpsertProduct(Product{Code: "6902", Name: "雪碧", SalePrice: 3.81, RefPrice: 4})
	if !errors.Is(err, ErrBadInput) {
		t.Fatalf("超价应被拒绝，实际 %v", err)
	}
	if err == nil || !strings.Contains(err.Error(), "比价防线") {
		t.Errorf("错误信息应说明比价防线，实际 %v", err)
	}
	// 批发商品跳过防线（默认 ExcludeWholesale=true）
	if _, err := st.UpsertProduct(Product{Code: "6902", Name: "雪碧", SalePrice: 3.81, RefPrice: 4, IsWholesale: true}); err != nil {
		t.Fatalf("批发商品应豁免比价防线: %v", err)
	}
	// 无参考价 → 不做比价
	if _, err := st.UpsertProduct(Product{Code: "6904", Name: "口香糖", SalePrice: 99}); err != nil {
		t.Fatalf("无参考价不应拦截: %v", err)
	}
}

// TestDeleteProductGuard 删除约束：库存非 0、进行中订单引用都要拦。
func TestDeleteProductGuard(t *testing.T) {
	st := newTestStore(t)
	seed(t, st) // 6901 库存 120、6902 库存 3

	if err := st.DeleteProduct("9999"); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在的商品应 ErrNotFound，实际 %v", err)
	}
	err := st.DeleteProduct("6901")
	if !errors.Is(err, ErrConflict) {
		t.Fatalf("库存非 0 应拒绝删除，实际 %v", err)
	}
	if err == nil || !strings.Contains(err.Error(), "盘点为 0") {
		t.Errorf("错误信息应提示先盘点为 0，实际 %v", err)
	}
	// 先下单再清零：验证「库存已是 0、但有进行中订单」仍会拦住删除
	if _, err := st.CreateOrder(NewOrderInput{
		DeliveryType: "pickup",
		CustomerName: "张三",
		Phone:        "13800000000",
		Items:        []NewOrderInputItem{{Code: "6902", Qty: 1}},
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.SetStock("6902", 0); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteProduct("6902"); !errors.Is(err, ErrConflict) {
		t.Fatalf("有进行中订单应拒绝删除，实际 %v", err)
	} else if !strings.Contains(err.Error(), "进行中") {
		t.Errorf("错误信息应提示进行中订单，实际 %v", err)
	}
	// 订单完成 → 可以删除
	orders, _ := st.ListOrders("")
	if len(orders) != 1 {
		t.Fatalf("期望 1 个订单，实际 %d", len(orders))
	}
	if _, err := st.AdvanceOrder(orders[0].ID, "ready"); err != nil {
		t.Fatal(err)
	}
	if _, err := st.AdvanceOrder(orders[0].ID, "done"); err != nil {
		t.Fatal(err)
	}
	if err := st.DeleteProduct("6902"); err != nil {
		t.Fatalf("订单已完成后应可删除: %v", err)
	}
	if _, err := st.GetProduct("6902"); !errors.Is(err, ErrNotFound) {
		t.Errorf("删除后应查不到，实际 %v", err)
	}
	// 字典层保留（D6 永久沉淀），扫码仍能认出条码
	if e, ok := st.GetLib("6902"); !ok || e.Source != "product" {
		t.Errorf("字典层应保留该条码，实际 %+v ok=%v", e, ok)
	}
}

// TestAddressBook 顾客收货地址簿（D18）：默认地址规则、校验、删除顶替、按手机号隔离。
func TestAddressBook(t *testing.T) {
	st := newTestStore(t)

	list, err := st.ListAddresses("13800000001")
	if err != nil || len(list) != 0 || list == nil {
		t.Fatalf("空地址簿应为空数组，实际 %v err=%v", list, err)
	}
	if _, err := st.ListAddresses("  "); !errors.Is(err, ErrBadInput) {
		t.Errorf("空手机号应 ErrBadInput，实际 %v", err)
	}

	// 第一条自动成为默认地址
	first, err := st.SaveAddress(Address{Phone: "13800000001", Contact: " 张三 ", Address: " 幸福路 1 号 "})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID == 0 || !first.IsDefault || first.Contact != "张三" || first.Address != "幸福路 1 号" {
		t.Fatalf("第一条地址应自动默认且去掉首尾空格，实际 %+v", first)
	}
	if first.CreatedAt == "" || first.UpdatedAt == "" {
		t.Errorf("应补上创建/更新时间，实际 %+v", first)
	}

	// 第二条默认不抢默认位，列表默认地址在前
	second, err := st.SaveAddress(Address{Phone: "13800000001", Contact: "张三", Address: "幸福路 2 号"})
	if err != nil {
		t.Fatal(err)
	}
	if second.IsDefault {
		t.Errorf("第二条不应自动成为默认，实际 %+v", second)
	}
	list, _ = st.ListAddresses("13800000001")
	if len(list) != 2 || list[0].ID != first.ID {
		t.Fatalf("列表应默认地址在前，实际 %+v", list)
	}

	// 显式设默认：旧的默认被摘掉
	second.IsDefault = true
	if _, err := st.SaveAddress(second); err != nil {
		t.Fatal(err)
	}
	list, _ = st.ListAddresses("13800000001")
	if !list[0].IsDefault || list[0].ID != second.ID {
		t.Fatalf("显式设默认后应换人，实际 %+v", list)
	}
	if list[1].IsDefault {
		t.Errorf("旧默认应被摘掉，实际 %+v", list[1])
	}

	// 编辑不带 is_default：不改默认标记，只改内容
	defaults := list[0]
	defaults.Contact = "李四"
	defaults.Address = "幸福路 2 号 3 单元"
	saved, err := st.SaveAddress(defaults)
	if err != nil {
		t.Fatal(err)
	}
	if !saved.IsDefault || saved.Address != "幸福路 2 号 3 单元" || saved.Contact != "李四" {
		t.Errorf("编辑应保默认标记并更新内容，实际 %+v", saved)
	}
	if saved.CreatedAt != defaults.CreatedAt {
		t.Errorf("编辑不应改创建时间，实际 %q vs %q", saved.CreatedAt, defaults.CreatedAt)
	}

	// 校验
	bad := []Address{
		{Contact: "张三", Address: "幸福路"},
		{Phone: "13800000001", Address: "幸福路"},
		{Phone: "13800000001", Contact: "张三"},
		{Phone: "13800000001", Contact: strings.Repeat("张", 21), Address: "幸福路"},
		{Phone: "13800000001", Contact: "张三", Address: strings.Repeat("路", 121)},
	}
	for i, a := range bad {
		if _, err := st.SaveAddress(a); !errors.Is(err, ErrBadInput) {
			t.Errorf("第 %d 个非法地址应 ErrBadInput，实际 %v", i+1, err)
		}
	}
	if _, err := st.SaveAddress(Address{ID: 9999, Phone: "13800000001", Contact: "张三", Address: "幸福路"}); !errors.Is(err, ErrNotFound) {
		t.Errorf("改不存在的地址应 ErrNotFound，实际 %v", err)
	}

	// 删除：不存在的地址 / 非法编号
	if err := st.DeleteAddress("13800000001", 9999); !errors.Is(err, ErrNotFound) {
		t.Errorf("删不存在的地址应 ErrNotFound，实际 %v", err)
	}
	if err := st.DeleteAddress("13800000001", 0); !errors.Is(err, ErrBadInput) {
		t.Errorf("编号 0 应 ErrBadInput，实际 %v", err)
	}
	if err := st.DeleteAddress("", 1); !errors.Is(err, ErrBadInput) {
		t.Errorf("空手机号应 ErrBadInput，实际 %v", err)
	}

	// 删掉默认地址 → 剩下最早的一条顶为默认
	if err := st.DeleteAddress("13800000001", second.ID); err != nil {
		t.Fatal(err)
	}
	list, _ = st.ListAddresses("13800000001")
	if len(list) != 1 || list[0].ID != first.ID || !list[0].IsDefault {
		t.Fatalf("删掉默认后剩下的一条应变默认，实际 %+v", list)
	}

	// 按手机号隔离
	if _, err := st.SaveAddress(Address{Phone: "13800000002", Contact: "王五", Address: "和平路 9 号"}); err != nil {
		t.Fatal(err)
	}
	other, _ := st.ListAddresses("13800000002")
	if len(other) != 1 || other[0].Contact != "王五" {
		t.Fatalf("另一个手机号的地址簿应独立，实际 %+v", other)
	}
	if mine, _ := st.ListAddresses("13800000001"); len(mine) != 1 {
		t.Errorf("本机号地址簿不应被影响，实际 %+v", mine)
	}

	// 删光
	if err := st.DeleteAddress("13800000001", first.ID); err != nil {
		t.Fatal(err)
	}
	if mine, _ := st.ListAddresses("13800000001"); len(mine) != 0 {
		t.Errorf("删光后应为空，实际 %+v", mine)
	}
}

/* --------- 任务池⑥：上下架（D23） --------- */

func TestProductOnSaleSemantics(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	// 新建商品默认上架
	p, err := st.GetProduct("6901")
	if err != nil {
		t.Fatalf("取商品失败: %v", err)
	}
	if !p.OnSale {
		t.Fatalf("新建商品应默认上架，实际 %+v", p)
	}

	// 下架：重复条码与空白会被归一化，只算一次
	changed, err := st.SetProductsOnSale([]string{"6901", " 6901 ", ""}, false)
	if err != nil {
		t.Fatalf("下架失败: %v", err)
	}
	if len(changed) != 1 || changed[0] != "6901" {
		t.Fatalf("下架应只改动 6901，实际 %v", changed)
	}
	if p, _ = st.GetProduct("6901"); p.OnSale {
		t.Fatalf("下架后 OnSale 应为 false")
	}

	// 顾客端列表不含下架商品；管理端全量仍含（否则无法再上架）
	onSale, err := st.ListOnSaleProducts("", "")
	if err != nil {
		t.Fatalf("顾客端列表失败: %v", err)
	}
	if len(onSale) != 1 || onSale[0].Code != "6902" {
		t.Fatalf("顾客端应只剩 6902，实际 %+v", onSale)
	}
	all, _ := st.ListProducts("", "")
	if len(all) != 2 {
		t.Fatalf("管理端应看到 2 条，实际 %d", len(all))
	}

	// 幂等：重复下架不写库
	again, err := st.SetProductsOnSale([]string{"6901"}, false)
	if err != nil {
		t.Fatalf("重复下架失败: %v", err)
	}
	if len(again) != 0 {
		t.Fatalf("重复下架应无变化，实际 %v", again)
	}

	// 编辑档案不改变上下架状态（与库存同理）
	if _, err := st.UpsertProduct(Product{
		Code: "6901", Name: "可乐（新）", Category: "饮料", Unit: "罐", SalePrice: 2.5, Stock: 120,
	}); err != nil {
		t.Fatalf("编辑档案失败: %v", err)
	}
	p, _ = st.GetProduct("6901")
	if p.OnSale {
		t.Fatalf("编辑档案不应把商品恢复上架")
	}
	if p.Name != "可乐（新）" {
		t.Fatalf("编辑档案应生效，实际 name=%q", p.Name)
	}

	// 下架商品不能下单，且失败要回滚（库存不动）
	order := NewOrderInput{CustomerName: "王阿姨", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}
	if _, err := st.CreateOrder(order); !errors.Is(err, ErrConflict) {
		t.Fatalf("下架商品下单应报 ErrConflict，实际 %v", err)
	}
	if p, _ = st.GetProduct("6901"); p.Stock != 120 {
		t.Fatalf("下单失败应回滚库存，实际 %v", p.Stock)
	}

	// 重新上架后可以下单
	if _, err := st.SetProductsOnSale([]string{"6901"}, true); err != nil {
		t.Fatalf("上架失败: %v", err)
	}
	if _, err := st.CreateOrder(order); err != nil {
		t.Fatalf("上架后应能下单: %v", err)
	}

	// 边界：未知条码 / 空清单
	if _, err := st.SetProductsOnSale([]string{"6901", "不存在"}, false); !errors.Is(err, ErrNotFound) {
		t.Fatalf("未知条码应报 ErrNotFound，实际 %v", err)
	}
	if _, err := st.SetProductsOnSale(nil, false); !errors.Is(err, ErrBadInput) {
		t.Fatalf("空清单应报 ErrBadInput，实际 %v", err)
	}
}

// 老库升级：product 表没有 on_sale 时，Open 的补列逻辑要能补上且幂等。
func TestOnSaleColumnMigration(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	if _, err := st.DB().Exec(`ALTER TABLE product DROP COLUMN on_sale`); err != nil {
		t.Fatalf("模拟老库删列失败（需要 SQLite ≥ 3.35）: %v", err)
	}
	for i := 0; i < 2; i++ { // 跑两次，验证幂等
		if err := ensureColumn(st.DB(), "product", "on_sale", "INTEGER NOT NULL DEFAULT 1"); err != nil {
			t.Fatalf("第 %d 次补列失败: %v", i+1, err)
		}
	}
	p, err := st.GetProduct("6901")
	if err != nil {
		t.Fatalf("补列后取商品失败: %v", err)
	}
	if !p.OnSale {
		t.Fatalf("补列后老数据应视为上架，实际 %+v", p)
	}
}

// 任务池⑦ / D24：批发价随档案存取，顾客等级决定下单有效价。
func TestCustomerTierWholesalePrice(t *testing.T) {
	st := newTestStore(t)
	// 6901 设了批发价，6902 没设（0 表示批发客户也按零售价）
	for _, p := range []Product{
		{Code: "6901", Name: "可乐", Category: "饮料", Unit: "箱", SalePrice: 60, WholesalePrice: 52, Stock: 10},
		{Code: "6902", Name: "农夫", Category: "饮料", Unit: "箱", SalePrice: 48, Stock: 10},
	} {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品失败: %v", err)
		}
	}
	if p, _ := st.GetProduct("6901"); p.WholesalePrice != 52 {
		t.Fatalf("批发价应随档案存下，实际 %v", p.WholesalePrice)
	}

	// 没有档案的顾客 = 零售（不报错）
	if tier, err := st.GetCustomerTier("13900000000"); err != nil || tier != pricing.TierRetail {
		t.Fatalf("陌生手机号应为零售，实际 %q err=%v", tier, err)
	}

	if c, err := st.SetCustomerTier("13800001111", "王老板", pricing.TierWholesale); err != nil || c.Tier != pricing.TierWholesale {
		t.Fatalf("设批发等级失败: %+v err=%v", c, err)
	}

	// 批发顾客下单：有批发价走批发价，没设批发价仍走零售价
	o, err := st.CreateOrder(NewOrderInput{
		CustomerName: "王老板", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 2}, {Code: "6902", Qty: 1}},
	})
	if err != nil {
		t.Fatalf("批发顾客下单失败: %v", err)
	}
	if o.Items[0].Price != 52 || o.Items[1].Price != 48 {
		t.Fatalf("批发顾客价格不对: %+v", o.Items)
	}
	if o.Subtotal != 152 { // 52×2 + 48
		t.Fatalf("小计应为 152，实际 %v", o.Subtotal)
	}

	// 零售顾客：一律零售价
	o2, err := st.CreateOrder(NewOrderInput{
		CustomerName: "路人", Phone: "13900000000", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}},
	})
	if err != nil {
		t.Fatalf("零售顾客下单失败: %v", err)
	}
	if o2.Items[0].Price != 60 {
		t.Fatalf("零售顾客应走零售价，实际 %v", o2.Items[0].Price)
	}

	// 改等级：只影响之后的单，旧单价格是下单当时的快照；只改等级不抹姓名
	if c, err := st.SetCustomerTier("13800001111", "", pricing.TierRetail); err != nil || c.Name != "王老板" {
		t.Fatalf("改回零售失败（姓名应保留）: %+v err=%v", c, err)
	}
	o3, err := st.CreateOrder(NewOrderInput{
		CustomerName: "王老板", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 1}},
	})
	if err != nil {
		t.Fatalf("改等级后下单失败: %v", err)
	}
	if o3.Items[0].Price != 60 {
		t.Fatalf("改回零售后应按零售价，实际 %v", o3.Items[0].Price)
	}
	if old, err := st.GetOrder(o.ID); err != nil || old.Items[0].Price != 52 {
		t.Fatalf("历史订单价格不该被改等级改写: %+v err=%v", old.Items, err)
	}

	// 白名单与批发同一价格口径
	if c, err := st.SetCustomerTier("13700002222", "李姐", pricing.TierVIP); err != nil || c.Tier != pricing.TierVIP {
		t.Fatalf("设白名单失败: %+v err=%v", c, err)
	}
	if p, _ := st.GetProduct("6901"); pricing.EffectivePrice(pricing.TierVIP, p.SalePrice, p.WholesalePrice) != 52 {
		t.Fatalf("白名单应取批发价")
	}

	// 边界：非法等级 / 空手机号 / 负批发价
	if _, err := st.SetCustomerTier("13700003333", "", "gold"); !errors.Is(err, ErrBadInput) {
		t.Fatalf("非法等级应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SetCustomerTier("", "", pricing.TierRetail); !errors.Is(err, ErrBadInput) {
		t.Fatalf("空手机号应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.UpsertProduct(Product{Code: "6903", Name: "负批发价", SalePrice: 10, WholesalePrice: -1, Stock: 1}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("负批发价应报 ErrBadInput，实际 %v", err)
	}
	// 顾客列表：两单下单时自动建档 + 白名单共 3 人
	if list, err := st.ListCustomers(); err != nil || len(list) != 3 {
		t.Fatalf("顾客列表应有 3 人，实际 %d err=%v", len(list), err)
	}
}

// 老库升级：product.wholesale_price 与 customer.tier 缺失时也能补上且幂等（D24）。
func TestTierColumnMigration(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	if _, err := st.DB().Exec(`ALTER TABLE product DROP COLUMN wholesale_price`); err != nil {
		t.Fatalf("模拟老库删列失败（需要 SQLite ≥ 3.35）: %v", err)
	}
	if _, err := st.DB().Exec(`ALTER TABLE customer DROP COLUMN tier`); err != nil {
		t.Fatalf("模拟老库删列失败（需要 SQLite ≥ 3.35）: %v", err)
	}
	for i := 0; i < 2; i++ { // 跑两次，验证幂等
		if err := ensureColumn(st.DB(), "product", "wholesale_price", "REAL NOT NULL DEFAULT 0"); err != nil {
			t.Fatalf("第 %d 次补批发价列失败: %v", i+1, err)
		}
		if err := ensureColumn(st.DB(), "customer", "tier", "TEXT NOT NULL DEFAULT 'retail'"); err != nil {
			t.Fatalf("第 %d 次补等级列失败: %v", i+1, err)
		}
	}
	p, err := st.GetProduct("6901")
	if err != nil {
		t.Fatalf("补列后取商品失败: %v", err)
	}
	if p.WholesalePrice != 0 {
		t.Fatalf("老库补列后批发价应为 0（视为未设），实际 %v", p.WholesalePrice)
	}
	if _, err := st.SetCustomerTier("13800001111", "王阿姨", pricing.TierWholesale); err != nil {
		t.Fatalf("补列后设等级失败: %v", err)
	}
	if tier, _ := st.GetCustomerTier("13800001111"); tier != pricing.TierWholesale {
		t.Fatalf("补列后等级应生效，实际 %q", tier)
	}
}

// ---- 任务池⑧（D25）：库存流水 / 配送员 / 门店抬头 / 顾客备注 落库 ----

// 库存变更必须在一个事务里同时改库存 + 写流水；失败不留痕（审计可信的前提）。
func TestStockChangeAudit(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	// 入库 +30：可乐 120 → 150
	e, err := st.ChangeStock("6901", StockKindIn, 30, "整箱到货", "老板")
	if err != nil {
		t.Fatalf("入库失败: %v", err)
	}
	if e.Kind != StockKindIn || e.Before != 120 || e.After != 150 || e.Delta != 30 {
		t.Fatalf("入库流水不正确: %+v", e)
	}
	if e.Name != "可乐" || e.Unit != "罐" || e.Reason != "整箱到货" || e.By != "老板" || e.At == 0 || e.TS == "" {
		t.Fatalf("流水快照字段不全: %+v", e)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 150 {
		t.Fatalf("入库后库存应为 150，实际 %v", p.Stock)
	}

	// 改数 -6：150 → 144
	e, err = st.ChangeStock("6901", StockKindAdjust, -6, "整箱到货", "老板")
	if err != nil {
		t.Fatalf("改数失败: %v", err)
	}
	if e.Delta != -6 || e.Before != 150 || e.After != 144 {
		t.Fatalf("改数流水不正确: %+v", e)
	}

	// 盘点 140：144 → 140（qty 是实盘数，不是增量）
	e, err = st.ChangeStock("6901", StockKindTake, 140, "", "")
	if err != nil {
		t.Fatalf("盘点失败: %v", err)
	}
	if e.Delta != -4 || e.Before != 144 || e.After != 140 {
		t.Fatalf("盘点流水不正确: %+v", e)
	}
	if e.By != "老板" {
		t.Fatalf("操作人留空时应回落到老板，实际 %q", e.By)
	}

	// 非法输入：类型 / 数量 / 商品，一条都不许落下流水
	bad := []struct {
		code, kind string
		qty        float64
	}{
		{"6901", "nope", 1},
		{"6901", StockKindIn, 0},
		{"6901", StockKindIn, -1},
		{"6901", StockKindAdjust, 0},
		{"6901", StockKindTake, -1},
		{"6901", StockKindAdjust, -1000}, // 改完为负
		{"", StockKindIn, 1},
		{"9999", StockKindIn, 1},
	}
	for _, c := range bad {
		if _, err := st.ChangeStock(c.code, c.kind, c.qty, "", ""); err == nil {
			t.Fatalf("非法库存变更应报错: %+v", c)
		}
	}
	logs, err := st.ListStockLog(0)
	if err != nil {
		t.Fatalf("读流水失败: %v", err)
	}
	if len(logs) != 3 {
		t.Fatalf("非法操作不该留流水，期望 3 条，实际 %d", len(logs))
	}
	if logs[0].Kind != StockKindTake || logs[2].Kind != StockKindIn {
		t.Fatalf("流水应按时间倒序（最新在前）: %+v", logs)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 140 {
		t.Fatalf("非法操作不该改库存，实际 %v", p.Stock)
	}

	// 直接改数（绝对值）也走审计：值没变不写流水，变了写一条
	if _, err := st.SetStock("6901", 140); err != nil {
		t.Fatalf("SetStock 同值失败: %v", err)
	}
	if logs, _ := st.ListStockLog(0); len(logs) != 3 {
		t.Fatalf("同值改数不该写流水，实际 %d 条", len(logs))
	}
	if p, err := st.SetStock("6901", 200); err != nil || p.Stock != 200 {
		t.Fatalf("直接改数失败: %v %+v", err, p)
	}
	logs, _ = st.ListStockLog(0)
	if len(logs) != 4 || logs[0].Kind != StockKindAdjust || logs[0].Delta != 60 || logs[0].Reason != "直接改数" {
		t.Fatalf("直接改数流水不正确: %+v", logs[0])
	}
	if _, err := st.SetStock("6901", -1); err == nil {
		t.Fatalf("负库存应被拦下")
	}
	if _, err := st.SetStock("9999", 1); !errors.Is(err, ErrNotFound) {
		t.Fatalf("不存在的商品应报 ErrNotFound，实际 %v", err)
	}
}

// 流水只留最近 500 条：审计够用，库不会无限长大。
func TestStockLogCap(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	if _, err := st.SetStock("6901", 0); err != nil {
		t.Fatalf("清零失败: %v", err)
	}
	for i := 0; i < 505; i++ {
		if _, err := st.ChangeStock("6901", StockKindIn, 1, "压力测试", "老板"); err != nil {
			t.Fatalf("第 %d 次入库失败: %v", i+1, err)
		}
	}
	logs, err := st.ListStockLog(0)
	if err != nil {
		t.Fatalf("读流水失败: %v", err)
	}
	if len(logs) != 500 {
		t.Fatalf("流水上限应为 500，实际 %d", len(logs))
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 505 {
		t.Fatalf("库存应累计到 505，实际 %v", p.Stock)
	}
	if logs, _ := st.ListStockLog(3); len(logs) != 3 {
		t.Fatalf("limit 应生效，实际 %d 条", len(logs))
	}
}

// 配送员名单落库：首次有 4 人雏形种子，可增删改，删空到 1 人会被拦（没法派单）。
func TestCouriersPersist(t *testing.T) {
	st := newTestStore(t)
	list, err := st.ListCouriers()
	if err != nil {
		t.Fatalf("读配送员失败: %v", err)
	}
	if len(list) != 4 || list[0].Name != "老张" {
		t.Fatalf("首次应有 4 人雏形（老张…），实际 %+v", list)
	}
	// 改手机号
	if _, err := st.SaveCourier("老张", "13800000000", false); err != nil {
		t.Fatalf("改配送员失败: %v", err)
	}
	list, _ = st.ListCouriers()
	if len(list) != 4 || list[0].Phone != "13800000000" {
		t.Fatalf("配送员手机号未更新: %+v", list)
	}
	// 加人
	list, err = st.SaveCourier("阿明", "13900000000", false)
	if err != nil || len(list) != 5 {
		t.Fatalf("新增配送员失败: %v %+v", err, list)
	}
	// 删人
	list, err = st.SaveCourier("阿明", "", true)
	if err != nil || len(list) != 4 {
		t.Fatalf("删除配送员失败: %v %+v", err, list)
	}
	if _, err := st.SaveCourier("阿明", "", true); !errors.Is(err, ErrNotFound) {
		t.Fatalf("删不存在的配送员应报 ErrNotFound，实际 %v", err)
	}
	if _, err := st.SaveCourier("  ", "", false); !errors.Is(err, ErrBadInput) {
		t.Fatalf("空姓名应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SaveCourier(strings.Repeat("名", 13), "", false); !errors.Is(err, ErrBadInput) {
		t.Fatalf("超长姓名应报 ErrBadInput，实际 %v", err)
	}
	// 删到只剩 1 人后不许再删
	for _, n := range []string{"小李", "阿强", "小美"} {
		if _, err := st.SaveCourier(n, "", true); err != nil {
			t.Fatalf("删 %s 失败: %v", n, err)
		}
	}
	if _, err := st.SaveCourier("老张", "", true); !errors.Is(err, ErrConflict) {
		t.Fatalf("只剩一位时应报 ErrConflict，实际 %v", err)
	}
	// 重新 Open 同一库不该复活名单（种子只种一次）——用文件库验证更真实，这里退而验证标记位
	var v string
	if err := st.DB().QueryRow(`SELECT v FROM setting WHERE k='seed:courier'`).Scan(&v); err != nil || v != "1" {
		t.Fatalf("种子标记位缺失: %v %q", err, v)
	}
}

// 门店抬头落库（小票表头）。
func TestStoreSettings(t *testing.T) {
	st := newTestStore(t)
	s, err := st.GetSettings()
	if err != nil {
		t.Fatalf("读门店设置失败: %v", err)
	}
	if s.Name != "家庭超市" || s.Footer != "谢谢惠顾，欢迎再来！" || s.Phone != "" || s.Address != "" {
		t.Fatalf("默认门店抬头不正确: %+v", s)
	}
	if _, err := st.SaveSettings(Settings{Name: "  "}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("空店名应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SaveSettings(Settings{Name: strings.Repeat("店", 21)}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("超长店名应报 ErrBadInput，实际 %v", err)
	}
	saved, err := st.SaveSettings(Settings{Name: "水东洋便利店", Phone: "0571-8888", Address: "水东洋小区 1 幢", Footer: "  "})
	if err != nil {
		t.Fatalf("保存门店设置失败: %v", err)
	}
	if saved.Name != "水东洋便利店" || saved.Phone != "0571-8888" || saved.Address != "水东洋小区 1 幢" {
		t.Fatalf("保存结果不正确: %+v", saved)
	}
	if saved.Footer != "谢谢惠顾，欢迎再来！" {
		t.Fatalf("页脚留空应回到默认，实际 %q", saved.Footer)
	}
	again, _ := st.GetSettings()
	if again != saved {
		t.Fatalf("回读不一致: %+v vs %+v", again, saved)
	}
}

// 顾客备注与标签：手机号即身份，建档 / 更新都不该动到等级。
func TestCustomerNote(t *testing.T) {
	st := newTestStore(t)
	if _, err := st.SetCustomerNote("", "王阿姨", "", ""); !errors.Is(err, ErrBadInput) {
		t.Fatalf("空手机号应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SetCustomerNote("13800001111", "", "", strings.Repeat("备", 201)); !errors.Is(err, ErrBadInput) {
		t.Fatalf("超长备注应报 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SetCustomerNote("13800001111", "", strings.Repeat("签", 61), ""); !errors.Is(err, ErrBadInput) {
		t.Fatalf("超长标签应报 ErrBadInput，实际 %v", err)
	}
	c, err := st.SetCustomerNote("13800001111", "王阿姨", "老客户,3 号楼", "喜欢整箱买")
	if err != nil {
		t.Fatalf("写备注失败: %v", err)
	}
	if c.Phone != "13800001111" || c.Name != "王阿姨" || c.Tags != "老客户,3 号楼" || c.Note != "喜欢整箱买" {
		t.Fatalf("顾客档案不正确: %+v", c)
	}
	if c.Tier != pricing.TierRetail {
		t.Fatalf("新档顾客等级应为零售，实际 %q", c.Tier)
	}
	if _, err := st.SetCustomerTier("13800001111", "", pricing.TierWholesale); err != nil {
		t.Fatalf("设等级失败: %v", err)
	}
	// 只改备注（姓名留空）不许抹掉姓名与等级
	c, err = st.SetCustomerNote("13800001111", "", "老客户", "改成送货上门")
	if err != nil {
		t.Fatalf("改备注失败: %v", err)
	}
	if c.Name != "王阿姨" || c.Tier != pricing.TierWholesale || c.Note != "改成送货上门" || c.Tags != "老客户" {
		t.Fatalf("改备注不应动姓名/等级: %+v", c)
	}
	list, err := st.ListCustomers()
	if err != nil || len(list) != 1 {
		t.Fatalf("顾客列表不正确: %v %+v", err, list)
	}
	if list[0].Note != "改成送货上门" || list[0].Tags != "老客户" {
		t.Fatalf("列表未带出备注/标签: %+v", list[0])
	}
}

// TestWxUserBind 微信登录档案（第 23 轮 / D28）：手机号校验、openid 幂等、绑手机号不提权。
func TestWxUserBind(t *testing.T) {
	st := newTestStore(t)

	// 手机号校验：11 位、1 开头、全数字
	for _, bad := range []string{"", "1380000111", "138000011112", "23800001111", "1380000111a", "138 0001111"} {
		if ValidPhone(bad) {
			t.Errorf("%q 不该被判为合法手机号", bad)
		}
	}
	for _, good := range []string{"13800001111", "19912345678", "15000000000"} {
		if !ValidPhone(good) {
			t.Errorf("%q 应判为合法手机号", good)
		}
	}

	// 首次登录：只有 openid，没有手机号
	u, err := st.BindWxUser("o_1", "u_1", "", "")
	if err != nil {
		t.Fatalf("首次登录失败: %v", err)
	}
	if u.OpenID != "o_1" || u.Phone != "" || u.CreatedAt == "" || u.LastLogin == "" {
		t.Fatalf("首次登录档案不对: %+v", u)
	}

	// 再登录（新时间）仍然是同一条记录
	if _, err := st.BindWxUser("o_1", "u_1", "", ""); err != nil {
		t.Fatalf("重复登录失败: %v", err)
	}
	list, err := st.ListWxUsers(50)
	if err != nil || len(list) != 1 {
		t.Fatalf("openid 应幂等（只一条）: %v %+v", err, list)
	}

	// 绑手机号：等级仍是顾客档案里的零售（老板还没设批发）
	if _, err := st.BindWxUser("o_1", "u_1", "13800001111", "阿明"); err != nil {
		t.Fatalf("绑手机号失败: %v", err)
	}
	if tier, err := st.GetCustomerTier("13800001111"); err != nil || tier != pricing.TierRetail {
		t.Fatalf("绑定不该提权: %v %q", err, tier)
	}
	if _, err := st.SetCustomerTier("13800001111", "王阿姨", pricing.TierWholesale); err != nil {
		t.Fatalf("设等级失败: %v", err)
	}

	// 再登录不带手机号：绑定保留（不许被空手机号抹掉）
	u, err = st.BindWxUser("o_1", "u_1", "", "")
	if err != nil || u.Phone != "13800001111" || u.Nickname != "阿明" {
		t.Fatalf("空手机号不该抹掉已有绑定: %v %+v", err, u)
	}

	// 坏手机号：报错且不动原绑定
	if _, err := st.BindWxUser("o_1", "u_1", "12345", ""); err == nil ||
		!strings.Contains(err.Error(), "手机号格式不对") {
		t.Fatalf("坏手机号应报错: %v", err)
	}
	if u, _, _ := st.GetWxUser("o_1"); u.Phone != "13800001111" {
		t.Fatalf("坏手机号不该改绑定: %+v", u)
	}

	// 超长昵称截断到 20 字；换绑另一台微信到同一手机号互不影响
	long := strings.Repeat("名", 30)
	if u, err = st.BindWxUser("o_2", "u_2", "13900002222", long); err != nil {
		t.Fatalf("第二台微信绑定失败: %v", err)
	}
	if len([]rune(u.Nickname)) != 20 {
		t.Fatalf("昵称应截断到 20 字: %q(%d)", u.Nickname, len([]rune(u.Nickname)))
	}
	list, err = st.ListWxUsers(50)
	if err != nil || len(list) != 2 {
		t.Fatalf("应有两条微信档案: %v %+v", err, list)
	}
	if list[0].LastLogin < list[1].LastLogin {
		t.Errorf("列表应按最近登录倒序: %+v", list)
	}

	// 不存在 / 非法 openid
	if _, ok, _ := st.GetWxUser("o_none"); ok {
		t.Errorf("不存在的 openid 不该返回 ok")
	}
	if _, _, err := st.GetWxUser(""); err == nil {
		t.Errorf("空 openid 应报错")
	}

	// EnsureCustomer：建档不覆盖已有姓名与等级
	c, err := st.EnsureCustomer("13800001111", "别的名字")
	if err != nil {
		t.Fatalf("EnsureCustomer 失败: %v", err)
	}
	if c.Name != "王阿姨" || c.Tier != pricing.TierWholesale {
		t.Fatalf("EnsureCustomer 不该覆盖姓名/等级: %+v", c)
	}
	// 新手机号：用昵称建档，默认零售
	c2, err := st.EnsureCustomer("13700003333", "小陈")
	if err != nil || c2.Name != "小陈" || c2.Tier != pricing.TierRetail {
		t.Fatalf("新顾客建档不对: %v %+v", err, c2)
	}
	if _, err := st.EnsureCustomer("12345", ""); err == nil {
		t.Errorf("坏手机号不该建档")
	}
}

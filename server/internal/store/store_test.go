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

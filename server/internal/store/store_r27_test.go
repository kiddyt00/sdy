package store

// 第 27 轮新增行为的 store 层单测：下单幂等 / 原子扣减 / 起送价 / 取消回补写流水 /
// 订单过滤分页 / 地址簿能力令牌 / 示例商品标记 / 规则参数落库。
// 全部用内存库，不碰任何真实数据。

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

// stockOf 读某商品当前库存。
func stockOf(t *testing.T, st *Store, code string) float64 {
	t.Helper()
	p, err := st.GetProduct(code)
	if err != nil {
		t.Fatalf("取商品 %s 失败: %v", code, err)
	}
	return p.Stock
}

// countLogs 统计满足条件的流水条数（kind + reason 片段）。
func countLogs(t *testing.T, st *Store, kind, reasonLike string) int {
	t.Helper()
	var n int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM stock_log WHERE kind=? AND reason LIKE ?`,
		kind, "%"+reasonLike+"%").Scan(&n); err != nil {
		t.Fatalf("统计库存流水失败: %v", err)
	}
	return n
}

// TestR27CreateOrderClientTokenIdempotent 同一个 clientToken 第二次下单：
// 必须报 ErrDuplicated、库存只扣一次、两次拿到的是同一张单。
func TestR27CreateOrderClientTokenIdempotent(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	in := NewOrderInput{CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		ClientToken: "tok-abc", Items: []NewOrderInputItem{{Code: "6901", Qty: 10}}}
	first, err := st.CreateOrder(in)
	if err != nil {
		t.Fatalf("首次下单失败: %v", err)
	}
	if got := stockOf(t, st, "6901"); got != 110 {
		t.Fatalf("首次下单后库存期望 110，实际 %v", got)
	}
	if _, err := st.CreateOrder(in); !errors.Is(err, ErrDuplicated) {
		t.Fatalf("重复 clientToken 期望 ErrDuplicated，实际 %v", err)
	}
	if got := stockOf(t, st, "6901"); got != 110 {
		t.Errorf("重复下单不得再扣库存：期望仍是 110，实际 %v", got)
	}
	prev, err := st.GetOrderByClientToken("tok-abc")
	if err != nil {
		t.Fatalf("按 clientToken 取原单失败: %v", err)
	}
	if prev.ID != first.ID {
		t.Errorf("幂等应返回原单 %s，实际 %s", first.ID, prev.ID)
	}
	if n, _ := st.ListOrders(""); len(n) != 1 {
		t.Errorf("重复下单不得多出订单：期望 1 张，实际 %d", len(n))
	}
	// 空 clientToken 不参与幂等：同一部手机连下两单都该成功。
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}); err != nil {
		t.Fatalf("空 clientToken 不应被当成重复：%v", err)
	}
	if _, err := st.GetOrderByClientToken("no-such-token"); !errors.Is(err, ErrNotFound) {
		t.Errorf("未知 clientToken 期望 ErrNotFound，实际 %v", err)
	}
	if _, err := st.GetOrderByClientToken("  "); !errors.Is(err, ErrBadInput) {
		t.Errorf("空 clientToken 期望 ErrBadInput，实际 %v", err)
	}
}

// TestR27CreateOrderMergesDuplicateCodes 购物车里同一商品出现两行：
// 必须合并数量成一行，而不是撞 order_item 复合主键报 500（审计 C11）。
func TestR27CreateOrderMergesDuplicateCodes(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	o, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{
			{Code: "6901", Qty: 1}, {Code: "6901", Qty: 2}, {Code: "6902", Qty: 1},
		}})
	if err != nil {
		t.Fatalf("重复条码下单应成功，实际 %v", err)
	}
	if len(o.Items) != 2 {
		t.Fatalf("期望合并成 2 行，实际 %d 行：%+v", len(o.Items), o.Items)
	}
	if o.Items[0].Code != "6901" || o.Items[0].Qty != 3 {
		t.Errorf("6901 应合并为 3 件，实际 %+v", o.Items[0])
	}
	if got := stockOf(t, st, "6901"); got != 117 {
		t.Errorf("6901 库存期望 117，实际 %v", got)
	}
	// 空条码 / 非正数量仍是参数错误，不该走到写库。
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}, {Code: "6901", Qty: 0}}}); !errors.Is(err, ErrBadInput) {
		t.Errorf("数量 0 期望 ErrBadInput，实际 %v", err)
	}
}

// TestR27CreateOrderAtomicRollback 一张单里任一商品库存不足：
// 整单回滚——前面已扣的行不得留下痕迹，也不得有订单落库。
func TestR27CreateOrderAtomicRollback(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	_, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{
			{Code: "6901", Qty: 1}, {Code: "6902", Qty: 99},
		}})
	if !errors.Is(err, ErrStockLess) {
		t.Fatalf("库存不足期望 ErrStockLess，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "库存不足：农夫（还剩 3 件）") {
		t.Errorf("库存不足文案不对：%v", err)
	}
	if got := stockOf(t, st, "6901"); got != 120 {
		t.Errorf("整单应回滚：6901 期望 120，实际 %v", got)
	}
	if got := stockOf(t, st, "6902"); got != 3 {
		t.Errorf("6902 期望仍是 3，实际 %v", got)
	}
	if list, _ := st.ListOrders(""); len(list) != 0 {
		t.Errorf("回滚后不该有订单，实际 %d", len(list))
	}
}

// TestR27CreateOrderMinOrder 起送价：货款不够拒单并说明还差多少；设 0 表示不限。
func TestR27CreateOrderMinOrder(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	if _, err := st.SaveSettings(Settings{Name: "家庭超市", MinOrder: 50}); err != nil {
		t.Fatalf("设置起送价失败: %v", err)
	}
	cfg, err := st.GetSettings()
	if err != nil || cfg.MinOrder != 50 {
		t.Fatalf("起送价应落库为 50，实际 %v err=%v", cfg.MinOrder, err)
	}
	if cfg.LowStock != LowStockThreshold {
		t.Errorf("未改低库存阈值时应保持默认 %v，实际 %v", LowStockThreshold, cfg.LowStock)
	}

	_, err = st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}})
	if !errors.Is(err, ErrBadInput) {
		t.Fatalf("未达起送价期望 ErrBadInput，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "还差 47.5 元起送") {
		t.Errorf("起送价文案不对：%v", err)
	}
	if got := stockOf(t, st, "6901"); got != 120 {
		t.Errorf("拒单不得扣库存：期望 120，实际 %v", got)
	}
	// 刚好够起送就能下单（边界包含）。
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 20}}}); err != nil {
		t.Fatalf("货款 50 应达起送价：%v", err)
	}
	// 改成 0 表示不限起送。
	if _, err := st.SaveSettings(Settings{Name: "家庭超市", MinOrder: 0}); err != nil {
		t.Fatal(err)
	}
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "李四", Phone: "13800002222",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}); err != nil {
		t.Fatalf("起送价 0（不限）时应能下单：%v", err)
	}
}

// TestR27CancelOrderWritesStockLog 取消回补必须写流水（D25），且重复取消不重复回补。
func TestR27CancelOrderWritesStockLog(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	o, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 10}}})
	if err != nil {
		t.Fatal(err)
	}
	if n := countLogs(t, st, StockKindOrder, "下单扣减"); n != 1 {
		t.Errorf("下单扣减应写 1 条流水，实际 %d", n)
	}

	cancelled, err := st.CancelOrder(o.ID, "小美")
	if err != nil || cancelled.Status != "cancelled" {
		t.Fatalf("取消失败: %v status=%s", err, cancelled.Status)
	}
	if got := stockOf(t, st, "6901"); got != 120 {
		t.Errorf("取消应回补到 120，实际 %v", got)
	}
	if n := countLogs(t, st, StockKindCancel, "取消订单回补"); n != 1 {
		t.Fatalf("取消回补应写 1 条流水，实际 %d", n)
	}
	var delta, before, after float64
	var operator, orderID string
	if err := st.DB().QueryRow(`SELECT delta,before_qty,after_qty,operator,order_id FROM stock_log
		WHERE kind=? ORDER BY id DESC LIMIT 1`, StockKindCancel).
		Scan(&delta, &before, &after, &operator, &orderID); err != nil {
		t.Fatal(err)
	}
	if delta != 10 || before != 110 || after != 120 {
		t.Errorf("回补流水数值不对: delta=%v before=%v after=%v", delta, before, after)
	}
	if operator != "小美" || orderID != o.ID {
		t.Errorf("回补流水应记操作人与订单号: operator=%q orderID=%q", operator, orderID)
	}
	// 下单流水也要挂到订单上（第 27 轮回填）。
	var orderRefs int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM stock_log WHERE kind=? AND order_id=?`,
		StockKindOrder, o.ID).Scan(&orderRefs); err != nil {
		t.Fatal(err)
	}
	if orderRefs != 1 {
		t.Errorf("下单扣减流水应回填订单号，实际 %d 条", orderRefs)
	}

	// 幂等：再取消一次不报错、不回补第二次、不多写流水。
	again, err := st.CancelOrder(o.ID, "小美")
	if err != nil || again.Status != "cancelled" {
		t.Fatalf("重复取消应幂等成功: %v status=%s", err, again.Status)
	}
	if got := stockOf(t, st, "6901"); got != 120 {
		t.Errorf("重复取消不得再回补：期望 120，实际 %v", got)
	}
	if n := countLogs(t, st, StockKindCancel, "取消订单回补"); n != 1 {
		t.Errorf("重复取消不得多写流水，实际 %d 条", n)
	}
	if _, err := st.CancelOrder("M404", "小美"); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在的订单取消应报 ErrNotFound，实际 %v", err)
	}
}

// TestR27CancelOrderDeletedProduct 商品已被删除时取消订单：订单照常取消，
// 回补记一条 delta=0 的异常流水，绝不因回补无处可去而失败（审计 C3）。
func TestR27CancelOrderDeletedProduct(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	o, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6902", Qty: 3}}})
	if err != nil {
		t.Fatal(err)
	}
	// DeleteProduct 会挡住「有进行中订单」的商品，所以直接删行模拟历史脏库。
	if _, err := st.DB().Exec(`DELETE FROM product WHERE code=?`, "6902"); err != nil {
		t.Fatal(err)
	}
	cancelled, err := st.CancelOrder(o.ID, "顾客")
	if err != nil {
		t.Fatalf("商品已删除时取消不应失败: %v", err)
	}
	if cancelled.Status != "cancelled" {
		t.Errorf("订单应变成 cancelled，实际 %s", cancelled.Status)
	}
	if n := countLogs(t, st, StockKindCancel, "商品已删除"); n != 1 {
		t.Errorf("回补丢失应记 1 条异常流水，实际 %d", n)
	}
	var delta float64
	if err := st.DB().QueryRow(`SELECT delta FROM stock_log WHERE kind=? ORDER BY id DESC LIMIT 1`,
		StockKindCancel).Scan(&delta); err != nil {
		t.Fatal(err)
	}
	if delta != 0 {
		t.Errorf("回补丢失的流水 delta 应为 0，实际 %v", delta)
	}
}

// TestR27OrderFilterPageAndTotal total 必须是「符合条件的总数」，items 才是当前页。
func TestR27OrderFilterPageAndTotal(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	for i := 0; i < 3; i++ {
		if _, err := st.CreateOrder(NewOrderInput{CustomerName: "张三", Phone: "13800001111",
			DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}}); err != nil {
			t.Fatal(err)
		}
	}
	other, err := st.CreateOrder(NewOrderInput{CustomerName: "李四", Phone: "13800002222",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901", Qty: 1}}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := st.AdvanceOrder(other.ID, "delivering"); err != nil {
		t.Fatal(err)
	}

	// 不带 phone = 全量（员工/管理员视角）
	list, total, err := st.ListOrdersFiltered(OrderFilter{})
	if err != nil || total != 4 || len(list) != 4 {
		t.Fatalf("全量期望 4/4，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	// 按手机号过滤：只回自己的单
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800001111"})
	if err != nil || total != 3 || len(list) != 3 {
		t.Fatalf("按手机号过滤期望 3/3，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	// 分页：total 仍是总数，items 是当页
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800001111", Limit: 2, Offset: 0})
	if err != nil || total != 3 || len(list) != 2 {
		t.Fatalf("第一页期望 total=3 len=2，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800001111", Limit: 2, Offset: 2})
	if err != nil || total != 3 || len(list) != 1 {
		t.Fatalf("第二页期望 total=3 len=1，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800001111", Limit: 2, Offset: 9})
	if err != nil || total != 3 || len(list) != 0 {
		t.Fatalf("越界页期望 total=3 len=0，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	// 状态 + 手机号一起过滤
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800002222", Status: "delivering"})
	if err != nil || total != 1 || len(list) != 1 {
		t.Fatalf("状态过滤期望 1/1，实际 total=%d len=%d err=%v", total, len(list), err)
	}
	list, total, err = st.ListOrdersFiltered(OrderFilter{Phone: "13800002222", Status: "pending"})
	if err != nil || total != 0 || len(list) != 0 {
		t.Fatalf("状态过滤期望 0/0，实际 total=%d len=%d err=%v", total, len(list), err)
	}
}

// TestR27AddressKey 地址簿能力令牌：首发生成、复用、校验、未发放不放行。
func TestR27AddressKey(t *testing.T) {
	st := newTestStore(t)

	if key, err := st.GetAddressKey("13800001111"); err != nil || key != "" {
		t.Fatalf("没发过令牌应回空串，实际 %q err=%v", key, err)
	}
	if ok, err := st.CheckAddressKey("13800001111", "whatever"); err != nil || ok {
		t.Fatalf("没发过令牌时任何 key 都不该通过，实际 ok=%v err=%v", ok, err)
	}
	key, err := st.EnsureAddressKey("13800001111")
	if err != nil {
		t.Fatalf("生成令牌失败: %v", err)
	}
	if len(key) != 32 {
		t.Errorf("令牌应为 32 位 hex，实际 %q（%d 位）", key, len(key))
	}
	again, err := st.EnsureAddressKey("13800001111")
	if err != nil || again != key {
		t.Errorf("同一手机号应复用同一枚令牌：%q vs %q err=%v", key, again, err)
	}
	if ok, _ := st.CheckAddressKey("13800001111", key); !ok {
		t.Error("正确的手机号+令牌应通过")
	}
	if ok, _ := st.CheckAddressKey("13800001111", key+"0"); ok {
		t.Error("错误的令牌不该通过")
	}
	if ok, _ := st.CheckAddressKey("13900000000", key); ok {
		t.Error("令牌不能跨手机号使用")
	}
	if ok, _ := st.CheckAddressKey("13800001111", ""); ok {
		t.Error("空令牌不该通过")
	}
	if _, err := st.EnsureAddressKey("  "); !errors.Is(err, ErrBadInput) {
		t.Errorf("空手机号期望 ErrBadInput，实际 %v", err)
	}
}

// TestR27ProductIsDemo 示例商品标记：落库、读回、编辑档案不抹标记。
func TestR27ProductIsDemo(t *testing.T) {
	st := newTestStore(t)
	demo := Product{Code: "6901", Name: "可乐", SalePrice: 2.5, Stock: 10, IsDemo: true}
	if _, err := st.UpsertProduct(demo); err != nil {
		t.Fatal(err)
	}
	demo = Product{Code: "6902", Name: "雪碧", SalePrice: 2.5, Stock: 10}
	if _, err := st.UpsertProduct(demo); err != nil {
		t.Fatal(err)
	}
	p, err := st.GetProduct("6901")
	if err != nil || !p.IsDemo {
		t.Errorf("GET 单个商品应带 isDemo=true，实际 %+v err=%v", p, err)
	}
	if p, _ := st.GetProduct("6902"); p.IsDemo {
		t.Error("真实商品 isDemo 应为 false")
	}
	list, err := st.ListProducts("", "")
	if err != nil || len(list) != 2 {
		t.Fatalf("列表期望 2 条，实际 %d err=%v", len(list), err)
	}
	for _, it := range list {
		if it.Code == "6901" && !it.IsDemo {
			t.Error("列表里的示例商品应带 isDemo=true")
		}
	}
	// 编辑档案（is_demo 不在写入列里）不得把演示标记抹掉。
	if _, err := st.UpsertProduct(Product{Code: "6901", Name: "可口可乐", SalePrice: 2.6, Stock: 10}); err != nil {
		t.Fatal(err)
	}
	if p, _ := st.GetProduct("6901"); !p.IsDemo {
		t.Error("编辑档案不应抹掉 isDemo 标记")
	}
	// 老库升级路径：列必须存在且默认 0。
	var def int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM product WHERE is_demo=1`).Scan(&def); err != nil {
		t.Fatalf("is_demo 列不存在: %v", err)
	}
	if def != 1 {
		t.Errorf("is_demo=1 的商品期望 1 条，实际 %d", def)
	}
}

// TestR27SettingsLowStockMinOrder 规则参数（低库存阈值 / 起送价）随设置一起落库下发。
func TestR27SettingsLowStockMinOrder(t *testing.T) {
	st := newTestStore(t)
	cfg, err := st.GetSettings()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LowStock != LowStockThreshold || cfg.MinOrder != 0 {
		t.Errorf("默认值期望 lowStock=%v minOrder=0，实际 %v/%v", LowStockThreshold, cfg.LowStock, cfg.MinOrder)
	}
	if cfg.DeliveryFee != 3 || cfg.MinFree != 30 {
		t.Errorf("配送费/免运费门槛应由 pricing.Config 下发：实际 %v/%v", cfg.DeliveryFee, cfg.MinFree)
	}
	saved, err := st.SaveSettings(Settings{Name: "家庭超市", LowStock: 8, MinOrder: 20})
	if err != nil {
		t.Fatal(err)
	}
	if saved.LowStock != 8 || saved.MinOrder != 20 {
		t.Errorf("保存后期望 8/20，实际 %v/%v", saved.LowStock, saved.MinOrder)
	}
	// 重新读一次确认真的落库（不是只改了返回值）
	cfg, _ = st.GetSettings()
	if cfg.LowStock != 8 || cfg.MinOrder != 20 {
		t.Errorf("重新读取期望 8/20，实际 %v/%v", cfg.LowStock, cfg.MinOrder)
	}
	// 传 0 = 回默认：低库存阈值回 5，起送价回不限
	cfg, err = st.SaveSettings(Settings{Name: "家庭超市"})
	if err != nil {
		t.Fatal(err)
	}
	if cfg.LowStock != LowStockThreshold || cfg.MinOrder != 0 {
		t.Errorf("传 0 应回默认 5/0，实际 %v/%v", cfg.LowStock, cfg.MinOrder)
	}
	if _, err := st.SaveSettings(Settings{Name: "家庭超市", MinOrder: -1}); !errors.Is(err, ErrBadInput) {
		t.Errorf("负起送价期望 ErrBadInput，实际 %v", err)
	}
	if _, err := st.SaveSettings(Settings{Name: "家庭超市", LowStock: -1}); !errors.Is(err, ErrBadInput) {
		t.Errorf("负阈值期望 ErrBadInput，实际 %v", err)
	}
}

// TestR27OpenMigratesPreR27Database 老库升级路径（第 27 轮生产事故的回归锁）。
//
// 事故现场：生产库是第 26 轮的 orders 表（没有 client_token），而
// `CREATE UNIQUE INDEX idx_orders_client_token` 当时放在 schemaStmts 里，
// 老库的 CREATE TABLE IF NOT EXISTS 是空操作 → 建索引报
// `建表失败: SQL logic error: no such column: client_token (1)` → 容器反复重启。
// 所以这里手工造一个第 26 轮形状的库，要求 Open 能补列、补索引、且一行数据都不丢。
func TestR27OpenMigratesPreR27Database(t *testing.T) {
	path := filepath.Join(t.TempDir(), "r26.db")

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开老库失败: %v", err)
	}
	oldSchema := []string{
		`CREATE TABLE orders (
			id TEXT PRIMARY KEY,
			customer_name TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			address TEXT NOT NULL DEFAULT '',
			delivery_type TEXT NOT NULL DEFAULT 'pickup',
			subtotal REAL NOT NULL DEFAULT 0,
			delivery_fee REAL NOT NULL DEFAULT 0,
			total REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE wx_user (
			openid TEXT PRIMARY KEY,
			unionid TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			nickname TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			last_login_at TEXT NOT NULL DEFAULT ''
		)`,
	}
	for _, s := range oldSchema {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造老库失败: %v", err)
		}
	}
	if _, err := db.Exec(`INSERT INTO orders (id,customer_name,phone,total,status,created_at)
		VALUES ('M_OLD','老张','13800000000',12.5,'pending','2026-10-01 08:00:00')`); err != nil {
		t.Fatalf("写老单失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO wx_user (openid,phone,nickname) VALUES ('o_old','13800000000','老张')`); err != nil {
		t.Fatalf("写老微信用户失败: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("关闭老库失败: %v", err)
	}

	st, err := Open(path, pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("老库升级失败（第 27 轮生产事故重现）: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// ① 老数据一行不丢，新列有默认值
	old, err := st.GetOrder("M_OLD")
	if err != nil {
		t.Fatalf("升级后读老单失败: %v", err)
	}
	if old.Phone != "13800000000" || old.Total != 12.5 {
		t.Errorf("老单内容被改动: %+v", old)
	}
	// ② 新列确实补上了（幂等键 + 补列索引）
	var tok string
	if err := st.DB().QueryRow(`SELECT client_token FROM orders WHERE id='M_OLD'`).Scan(&tok); err != nil {
		t.Fatalf("client_token 未补上: %v", err)
	}
	if tok != "" {
		t.Errorf("老单 client_token 应为空串，实际 %q", tok)
	}
	var idxCount int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM sqlite_master
		WHERE type='index' AND name IN ('idx_orders_client_token','idx_wx_user_staff_token')`).Scan(&idxCount); err != nil {
		t.Fatalf("查索引失败: %v", err)
	}
	if idxCount != 2 {
		t.Errorf("补列后的两个索引都应建好，实际只建了 %d 个", idxCount)
	}
	// ③ 老用户补上 role/staff_token，员工令牌查得到（走新索引）
	u, _, err := st.GetWxUser("o_old")
	if err != nil {
		t.Fatalf("升级后读老微信用户失败: %v", err)
	}
	if u.Role != RoleCustomer {
		t.Errorf("老用户 role 应为 customer，实际 %q", u.Role)
	}
	if _, ok, err := st.GetStaffByToken("nope"); err != nil || ok {
		t.Errorf("无此令牌应查不到，实际 ok=%v err=%v", ok, err)
	}
	// ④ 部分唯一索引：老单（client_token=''）与新的空 token 单可以共存，
	//    但相同 token 的第二单会被幂等拦住
	if _, err := st.UpsertProduct(Product{Code: "6901000000001", Name: "迁移测试品", SalePrice: 2,
		Stock: 20, OnSale: true, Unit: "件"}); err != nil {
		t.Fatalf("建测试商品失败: %v", err)
	}
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "李四", Phone: "13800000001",
		DeliveryType: "pickup", Items: []NewOrderInputItem{{Code: "6901000000001", Qty: 1}}}); err != nil {
		t.Fatalf("空 token 的新单不该被老单挡住: %v", err)
	}
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "王五", Phone: "13800000002",
		DeliveryType: "pickup", ClientToken: "tk-dup",
		Items: []NewOrderInputItem{{Code: "6901000000001", Qty: 1}}}); err != nil {
		t.Fatalf("首单写入失败: %v", err)
	}
	if _, err := st.CreateOrder(NewOrderInput{CustomerName: "王五", Phone: "13800000002",
		DeliveryType: "pickup", ClientToken: "tk-dup",
		Items: []NewOrderInputItem{{Code: "6901000000001", Qty: 1}}}); !errors.Is(err, ErrDuplicated) {
		t.Errorf("同 clientToken 第二单应 ErrDuplicated，实际 %v", err)
	}
}

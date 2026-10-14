package store

// 第 28 轮 store 层单测（§7.2 排序/分页/total、§7.3–§7.4 热销与替代推荐、
// §7.5 订单筛选、§7.7 索引与老库升级）。
//
// 与第 27 轮测试文件分开：本轮只新增，不改 store_r27_test.go。

import (
	"database/sql"
	"errors"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

/* ------------------------------ 测试夹具 ------------------------------ */

// r28SeedSortProducts 造三个商品，让四种排序的期望顺序互不相同，且价格档位换口径可观测：
//
//	7001 甲：零售 3，批发 1（**批发价比零售价低**），库存 5，销量 3
//	7002 乙：零售 2，批发 9（**批发价比零售价高**），库存 50，销量 10
//	7003 丙：零售 4，无批发价，库存 20，**销量 0**（必须仍出现在结果里，只是排最后）
func r28SeedSortProducts(t *testing.T, st *Store) {
	t.Helper()
	prods := []Product{
		{Code: "7001", Name: "甲", Category: "饮料", SalePrice: 3, WholesalePrice: 1, Stock: 5},
		{Code: "7002", Name: "乙", Category: "饮料", SalePrice: 2, WholesalePrice: 9, Stock: 50},
		{Code: "7003", Name: "丙", Category: "日杂", SalePrice: 4, Stock: 20},
	}
	for _, p := range prods {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品 %s 失败: %v", p.Code, err)
		}
	}
	for _, in := range []NewOrderInput{
		{CustomerName: "乙客", Phone: "13900000002", DeliveryType: "pickup",
			Items: []NewOrderInputItem{{Code: "7002", Qty: 10}}},
		{CustomerName: "甲客", Phone: "13900000001", DeliveryType: "pickup",
			Items: []NewOrderInputItem{{Code: "7001", Qty: 3}}},
	} {
		if _, err := st.CreateOrder(in); err != nil {
			t.Fatalf("造销量单失败: %v", err)
		}
	}
}

func r28Codes(list []Product) string {
	codes := make([]string, 0, len(list))
	for _, p := range list {
		codes = append(codes, p.Code)
	}
	return strings.Join(codes, ",")
}

func r28List(t *testing.T, st *Store, f ProductFilter) ([]Product, int) {
	t.Helper()
	out, total, err := st.ListProductsFiltered(f)
	if err != nil {
		t.Fatalf("查商品失败: %v", err)
	}
	return out, total
}

/* ------------------------------ §7.2 排序 ------------------------------ */

func TestR28ProductSorts(t *testing.T) {
	st := newTestStore(t)
	r28SeedSortProducts(t, st)

	cases := []struct {
		name string
		f    ProductFilter
		want string
	}{
		{"default 保持 R27 的按 code", ProductFilter{}, "7001,7002,7003"},
		{"零售价升序", ProductFilter{Sort: ProductSortPriceAsc}, "7002,7001,7003"},
		{"零售价降序", ProductFilter{Sort: ProductSortPriceDesc}, "7003,7001,7002"},
		{"批发价升序（甲1 < 丙4 < 乙9，和零售档顺序完全不同）",
			ProductFilter{Sort: ProductSortPriceAsc, Tier: pricing.TierWholesale}, "7001,7003,7002"},
		{"批发价降序", ProductFilter{Sort: ProductSortPriceDesc, Tier: pricing.TierWholesale}, "7002,7003,7001"},
		{"库存降序", ProductFilter{Sort: ProductSortStockDesc}, "7002,7003,7001"},
		{"热销降序（无销量的丙排在最后，不被排除）", ProductFilter{Sort: ProductSortHot}, "7002,7001,7003"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, total := r28List(t, st, c.f)
			if r28Codes(got) != c.want {
				t.Fatalf("顺序不对：期望 %s，实际 %s", c.want, r28Codes(got))
			}
			if total != 3 {
				t.Fatalf("total 应是过滤后总数 3，实际 %d", total)
			}
		})
	}

	// 直接证明「价格排序按顾客有效价」：批发档首件是甲（批发价 1），零售档首件是乙（零售价 2）。
	wholesale, _ := r28List(t, st, ProductFilter{Sort: ProductSortPriceAsc, Tier: pricing.TierWholesale})
	retail, _ := r28List(t, st, ProductFilter{Sort: ProductSortPriceAsc})
	if wholesale[0].Code != "7001" || retail[0].Code != "7002" {
		t.Fatalf("价格排序没换口径：批发档首件 %s、零售档首件 %s", wholesale[0].Code, retail[0].Code)
	}
	if wholesale[0].WholesalePrice != 1 {
		t.Fatalf("夹具失效：7001 批发价应为 1，实际 %v", wholesale[0].WholesalePrice)
	}

	// 未知排序 → ErrBadInput（HTTP 层据此回 400）。
	if _, _, err := st.ListProductsFiltered(ProductFilter{Sort: "bogus"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("未知 sort 应报 ErrBadInput，实际 %v", err)
	}
}

/* ------------------------------ §7.2 分页与 total ------------------------------ */

func TestR28ProductPagingAndTotal(t *testing.T) {
	st := newTestStore(t)
	r28SeedSortProducts(t, st)

	page1, total := r28List(t, st, ProductFilter{Limit: 2})
	if len(page1) != 2 || total != 3 {
		t.Fatalf("第一页应 2 条、total=3，实际 %d 条 / total=%d", len(page1), total)
	}
	page2, total := r28List(t, st, ProductFilter{Limit: 2, Offset: 2})
	if len(page2) != 1 || page2[0].Code != "7003" || total != 3 {
		t.Fatalf("第二页应只剩丙、total 仍是 3，实际 %v / total=%d", r28Codes(page2), total)
	}
	if beyond, total := r28List(t, st, ProductFilter{Limit: 2, Offset: 9}); len(beyond) != 0 || total != 3 {
		t.Fatalf("翻过尾页应 0 条但 total 仍为 3，实际 %d 条 / total=%d", len(beyond), total)
	}
	// limit=0 = 不限
	if all, total := r28List(t, st, ProductFilter{}); len(all) != 3 || total != 3 {
		t.Fatalf("limit=0 应全量 3 条，实际 %d 条 / total=%d", len(all), total)
	}
	// total 是**过滤后**的总数：keyword 只命中 1 件时 total 必须是 1，不是当前页条数
	if hit, total := r28List(t, st, ProductFilter{Keyword: "甲", Limit: 1}); len(hit) != 1 || total != 1 {
		t.Fatalf("过滤后 total 应为 1，实际 %d 条 / total=%d", len(hit), total)
	}
	// 与「不带条件」的 total 不同，证明 total 不是写死的全表数
	if _, total := r28List(t, st, ProductFilter{OnSaleOnly: true, Category: "饮料"}); total != 2 {
		t.Fatalf("饮料分类过滤后 total 应为 2，实际 %d", total)
	}
}

/* ------------------------------ §7.4 替代推荐 ------------------------------ */

func TestR28ProductAlternatives(t *testing.T) {
	st := newTestStore(t)
	prods := []Product{
		{Code: "7101", Name: "缺货的主商品", Category: "饮料", SalePrice: 3, Stock: 0},
		{Code: "7102", Name: "同分类无销", Category: "饮料", SalePrice: 2, Stock: 5},
		{Code: "7103", Name: "同分类热销", Category: "饮料", SalePrice: 2.5, Stock: 8},
		// 库存给足：下面那张销量单要卖 5 件，卖完必须还剩货，否则它会被「有库存」条件过滤掉
		{Code: "7104", Name: "他类热销", Category: "日杂", SalePrice: 4, Stock: 20},
		{Code: "7105", Name: "他类缺货", Category: "日杂", SalePrice: 4, Stock: 0},
	}
	for _, p := range prods {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品 %s 失败: %v", p.Code, err)
		}
	}
	// 销量故意做成「他类 5 件 > 同分类 2 件」：如果实现忘了同分类优先，顺序会变成 7104 开头。
	for _, in := range []NewOrderInput{
		{CustomerName: "他类客", Phone: "13900000004", DeliveryType: "pickup",
			Items: []NewOrderInputItem{{Code: "7104", Qty: 5}}},
		{CustomerName: "同类客", Phone: "13900000003", DeliveryType: "pickup",
			Items: []NewOrderInputItem{{Code: "7103", Qty: 2}}},
	} {
		if _, err := st.CreateOrder(in); err != nil {
			t.Fatalf("造销量单失败: %v", err)
		}
	}

	items, total, err := st.ListProductAlternatives("7101", 5)
	if err != nil {
		t.Fatalf("替代推荐失败: %v", err)
	}
	if total != 3 {
		t.Fatalf("候选总数应为 3（排除自身 7101 与缺货 7105），实际 %d", total)
	}
	if got := r28Codes(items); got != "7103,7102,7104" {
		t.Fatalf("同分类优先 + 全店热销补足的顺序应为 7103,7102,7104，实际 %s", got)
	}
	seen := map[string]bool{}
	for _, p := range items {
		if seen[p.Code] {
			t.Fatalf("替代推荐出现重复商品: %s", p.Code)
		}
		seen[p.Code] = true
	}
	for _, banned := range []string{"7101", "7105"} {
		if seen[banned] {
			t.Fatalf("%s 不该出现在替代推荐里（自身/缺货）", banned)
		}
	}

	// limit 截断只影响返回条数，不影响候选总数
	items, total, err = st.ListProductAlternatives("7101", 2)
	if err != nil {
		t.Fatalf("替代推荐失败: %v", err)
	}
	if got := r28Codes(items); got != "7103,7102" || total != 3 {
		t.Fatalf("limit=2 应返回 7103,7102 且 total=3，实际 %s / total=%d", got, total)
	}

	// code 缺失或商品不存在 → 空列表 + 0，且**不报错**（页面安静降级）
	for _, code := range []string{"", "   ", "9999"} {
		items, total, err = st.ListProductAlternatives(code, 5)
		if err != nil {
			t.Fatalf("code=%q 不该报错，实际 %v", code, err)
		}
		if len(items) != 0 || total != 0 {
			t.Fatalf("code=%q 应回空列表 + total=0，实际 %d 条 / total=%d", code, len(items), total)
		}
	}
}

/* ------------------------------ §7.5 订单筛选 ------------------------------ */

// r28SeedOrders 造三张单，并把 created_at/status 直接改成确定值
// （这两个字段没有公开写入接口，而日期筛选必须能被精确断言）。
func r28SeedOrders(t *testing.T, st *Store) (a, b, c, phoneA, phoneB string) {
	t.Helper()
	if _, err := st.UpsertProduct(Product{Code: "7201", Name: "可乐", SalePrice: 2, Stock: 200}); err != nil {
		t.Fatalf("写入商品失败: %v", err)
	}
	phoneA, phoneB, phoneC := "13800001111", "13800002222", "13800003333"
	mk := func(name, phone, typ string) string {
		o, err := st.CreateOrder(NewOrderInput{CustomerName: name, Phone: phone, DeliveryType: typ,
			Address: "测试路 1 号",
			Items:   []NewOrderInputItem{{Code: "7201", Qty: 1}}})
		if err != nil {
			t.Fatalf("造单失败: %v", err)
		}
		return o.ID
	}
	a = mk("张三", phoneA, "pickup")
	b = mk("李四", phoneB, "delivery")
	c = mk("王五", phoneC, "pickup")
	for _, row := range []struct{ id, at, status string }{
		{a, "2026-10-01 08:00:00", "pending"},
		{b, "2026-10-05 09:30:00", "delivering"},
		{c, "2026-10-10 20:00:00", "done"},
	} {
		if _, err := st.db.Exec(`UPDATE orders SET created_at=?, status=? WHERE id=?`, row.at, row.status, row.id); err != nil {
			t.Fatalf("改订单时间/状态失败: %v", err)
		}
	}
	return a, b, c, phoneA, phoneB
}

func TestR28OrderFilters(t *testing.T) {
	st := newTestStore(t)
	a, b, c, phoneA, phoneB := r28SeedOrders(t, st)

	count := func(f OrderFilter) int {
		t.Helper()
		list, total, err := st.ListOrdersFiltered(f)
		if err != nil {
			t.Fatalf("查订单失败（%+v）: %v", f, err)
		}
		if f.Limit == 0 && total != len(list) {
			t.Fatalf("不分页时 total(%d) 应与 items(%d) 一致", total, len(list))
		}
		return total
	}

	cases := []struct {
		name string
		f    OrderFilter
		want int
	}{
		{"无筛选=全量", OrderFilter{}, 3},
		{"q 命中顾客名", OrderFilter{Q: "李四"}, 1},
		{"q 模糊命中手机号", OrderFilter{Q: "138000022"}, 1},
		{"q 命中订单号", OrderFilter{Q: b}, 1},
		{"status 单值（R27 语义不变）", OrderFilter{Status: "pending"}, 1},
		{"status 逗号多值", OrderFilter{Status: "pending,delivering"}, 2},
		{"status 带空项也能工作", OrderFilter{Status: "pending, ,done"}, 2},
		{"date 单日", OrderFilter{Date: "2026-10-05"}, 1},
		{"from/to 含端点", OrderFilter{From: "2026-10-01", To: "2026-10-05"}, 2},
		{"from/to 同一天含端点", OrderFilter{From: "2026-10-05", To: "2026-10-05"}, 1},
		{"date 与 from/to 同给时 date 优先", OrderFilter{Date: "2026-10-05", From: "2026-10-10", To: "2026-10-10"}, 1},
		{"type=delivery", OrderFilter{Type: "delivery"}, 1},
		{"type=pickup", OrderFilter{Type: "pickup"}, 2},
		{"多条件叠加", OrderFilter{Type: "pickup", Status: "done"}, 1},
		// 先归属过滤再筛选：顾客 A 的单里筛别人，一条都筛不出来
		{"顾客 A + q=别人的名字", OrderFilter{Phone: phoneA, Q: "李四"}, 0},
		{"顾客 A + q=别人的手机号", OrderFilter{Phone: phoneA, Q: phoneB}, 0},
		{"顾客 A + q=自己的名字", OrderFilter{Phone: phoneA, Q: "张三"}, 1},
		{"顾客 A + status 不属于自己", OrderFilter{Phone: phoneA, Status: "done"}, 0},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := count(tc.f); got != tc.want {
				t.Fatalf("%+v 期望 %d 条，实际 %d", tc.f, tc.want, got)
			}
		})
	}

	// 归属过滤本身仍然生效
	if got := count(OrderFilter{Phone: phoneA}); got != 1 {
		t.Fatalf("顾客 A 只该看到自己的 1 单，实际 %d", got)
	}
	_ = a

	// 非法日期 → ErrBadInput（HTTP 层映射成 400 `日期格式应为 YYYY-MM-DD`）
	for _, f := range []OrderFilter{
		{Date: "2026-1-5"}, {Date: "20261005"}, {Date: "2026/10/05"},
		{From: "2026-13-01"}, {To: "不是日期"},
	} {
		if _, _, err := st.ListOrdersFiltered(f); !errors.Is(err, ErrBadInput) {
			t.Fatalf("非法日期 %+v 应报 ErrBadInput，实际 %v", f, err)
		}
	}
	// 非法日期不会因为 date 被 from/to 覆盖而漏检：date 非法就直接报错
	if _, _, err := st.ListOrdersFiltered(OrderFilter{Date: "2026-1-5", From: "2026-10-01", To: "2026-10-01"}); !errors.Is(err, ErrBadInput) {
		t.Fatalf("date 非法时应报 ErrBadInput，实际 %v", err)
	}
	_ = c
}

/* ------------------------------ §7.7 索引与老库升级 ------------------------------ */

func TestR28SchemaIndexes(t *testing.T) {
	st := newTestStore(t)
	for _, idx := range []string{"idx_product_onsale_category", "idx_order_item_code"} {
		var name string
		if err := st.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&name); err != nil {
			t.Fatalf("第 28 轮索引 %s 缺失: %v", idx, err)
		}
	}
}

// TestR28OpenMigratesPreR28Database 覆盖 §8.3 的老库升级回归（R27 测试文件不许改，
// 所以这里另起一个同口径的用例）：R28 之前的老库连 product.on_sale 都没有，
// 升级后必须能起来，补列与四个索引（含本轮新增两个）都要齐备。
// 这个用例同时是「新索引不能建在 ensureColumn 补列之前」的回归哨兵。
func TestR28OpenMigratesPreR28Database(t *testing.T) {
	path := filepath.Join(t.TempDir(), "pre28.db")
	raw, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开老库失败: %v", err)
	}
	stmts := []string{
		`CREATE TABLE product (
			code TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', brand TEXT NOT NULL DEFAULT '',
			spec TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '', img TEXT NOT NULL DEFAULT '',
			cost_price REAL NOT NULL DEFAULT 0, sale_price REAL NOT NULL DEFAULT 0,
			wholesale_price REAL NOT NULL DEFAULT 0, ref_price REAL NOT NULL DEFAULT 0,
			unit TEXT NOT NULL DEFAULT '', stock REAL NOT NULL DEFAULT 0,
			is_wholesale INTEGER NOT NULL DEFAULT 0, is_demo INTEGER NOT NULL DEFAULT 0,
			sync_status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE orders (
			id TEXT PRIMARY KEY, customer_name TEXT NOT NULL DEFAULT '', phone TEXT NOT NULL DEFAULT '',
			address TEXT NOT NULL DEFAULT '', delivery_type TEXT NOT NULL DEFAULT '',
			subtotal REAL NOT NULL DEFAULT 0, delivery_fee REAL NOT NULL DEFAULT 0, total REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE order_item (
			order_id TEXT NOT NULL, code TEXT NOT NULL, name TEXT NOT NULL DEFAULT '',
			price REAL NOT NULL DEFAULT 0, qty REAL NOT NULL DEFAULT 0, PRIMARY KEY(order_id,code)
		)`,
		`INSERT INTO product (code,name,sale_price,stock,created_at,updated_at)
			VALUES ('7001','老可乐',2,10,'2026-01-01 00:00:00','2026-01-01 00:00:00')`,
	}
	for _, s := range stmts {
		if _, err := raw.Exec(s); err != nil {
			raw.Close()
			t.Fatalf("造老库失败: %v", err)
		}
	}
	raw.Close()

	st, err := Open(path, pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("老库升级失败（新索引是不是建在补列之前了？）: %v", err)
	}
	defer st.Close()

	p, err := st.GetProduct("7001")
	if err != nil {
		t.Fatalf("老库商品读不出来: %v", err)
	}
	if !p.OnSale {
		t.Fatalf("补列后老商品应视为上架，实际 %+v", p)
	}
	for _, idx := range []string{
		"idx_product_onsale_category", "idx_order_item_code", // 第 28 轮新增
		"idx_orders_client_token", "idx_wx_user_staff_token", // 第 27 轮存量
	} {
		var name string
		if err := st.db.QueryRow(`SELECT name FROM sqlite_master WHERE type='index' AND name=?`, idx).Scan(&name); err != nil {
			t.Fatalf("老库升级后索引 %s 缺失: %v", idx, err)
		}
	}
	// 索引确实被优化器用得上（存在性之外再确认一次可用）
	if _, _, err := st.ListProductsFiltered(ProductFilter{OnSaleOnly: true, Category: "饮料", Sort: ProductSortHot}); err != nil {
		t.Fatalf("升级后的老库跑不动商品列表查询: %v", err)
	}
}

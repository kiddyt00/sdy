package main

// 第 28 轮 HTTP 层单测（§7.2 排序/分页、§7.3 /hot、§7.4 /alternatives、
// §7.5 订单筛选与越权、§7.6 CSV 导出）。
//
// 与第 27 轮测试文件分开：本轮只新增，不改 main_r27_test.go。
// 复用 newR27Server / r27Req（它们只建库不起数据，自带夹具）。
//
// 注意两处设计使然的坑：
//   - ADMIN_PASSWORD 未设置时 adminOK 恒为 true，所以「全店筛选/导出」这类管理端
//     视角必须靠**不带 phone** 请求（走灰度放行分支）；
//   - 「顾客身份下 q 筛不到别人的单」必须显式 t.Setenv("ADMIN_PASSWORD", ...) 关掉
//     灰度放行，否则 ?phone= 会被管理端分支短路成管理员。

import (
	"bytes"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

/* ------------------------------ 响应解析助手 ------------------------------ */

type r28ProductJSON struct {
	Code  string  `json:"code"`
	Price float64 `json:"price"`
	Tier  string  `json:"tier"`
}

type r28ProductsResp struct {
	Items   []r28ProductJSON `json:"items"`
	Total   int              `json:"total"`
	Limit   int              `json:"limit"`
	Offset  int              `json:"offset"`
	HasMore bool             `json:"hasMore"`
	Tier    string           `json:"tier"`
}

type r28OrderJSON struct {
	ID           string `json:"id"`
	CustomerName string `json:"customerName"`
	Phone        string `json:"phone"`
	DeliveryType string `json:"deliveryType"`
	Status       string `json:"status"`
}

type r28OrdersResp struct {
	Items  []r28OrderJSON `json:"items"`
	Total  int            `json:"total"`
	Limit  int            `json:"limit"`
	Offset int            `json:"offset"`
}

func r28GetProducts(t *testing.T, ts *httptest.Server, path string) r28ProductsResp {
	t.Helper()
	code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, path, "", nil)
	if code != 200 {
		t.Fatalf("GET %s 期望 200，实际 %d：%s", path, code, body)
	}
	var out r28ProductsResp
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("解析 %s 响应失败: %v（%s）", path, err, body)
	}
	return out
}

func r28GetOrders(t *testing.T, ts *httptest.Server, path string) r28OrdersResp {
	t.Helper()
	code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, path, "", nil)
	if code != 200 {
		t.Fatalf("GET %s 期望 200，实际 %d：%s", path, code, body)
	}
	var out r28OrdersResp
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("解析 %s 响应失败: %v（%s）", path, err, body)
	}
	return out
}

// r28Raw 发 GET 并把响应头一起返回（CSV 要验 Content-Type / Content-Disposition / BOM）。
func r28Raw(t *testing.T, ts *httptest.Server, path string) (int, http.Header, []byte) {
	t.Helper()
	res, err := http.Get(ts.URL + path)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("读响应失败: %v", err)
	}
	return res.StatusCode, res.Header, raw
}

func r28CodesOf(items []r28ProductJSON) string {
	codes := make([]string, 0, len(items))
	for _, p := range items {
		codes = append(codes, p.Code)
	}
	return strings.Join(codes, ",")
}

func r28Q(s string) string { return url.QueryEscape(s) }

/* ------------------------------ 测试夹具 ------------------------------ */

// r28SeedSort 造三个商品，四种排序的期望顺序互不相同、价格档位换口径可观测：
//
//	7001 甲：零售 3，批发 1（批发价低于零售），库存 5，销量 3
//	7002 乙：零售 2，批发 9（批发价高于零售），库存 50，销量 10
//	7003 丙：零售 4，无批发价，库存 20，销量 0（必须仍出现，只排最后）
func r28SeedSort(t *testing.T, st *store.Store) {
	t.Helper()
	for _, p := range []store.Product{
		{Code: "7001", Name: "甲", Category: "饮料", SalePrice: 3, WholesalePrice: 1, Stock: 5},
		{Code: "7002", Name: "乙", Category: "饮料", SalePrice: 2, WholesalePrice: 9, Stock: 50},
		{Code: "7003", Name: "丙", Category: "日杂", SalePrice: 4, Stock: 20},
	} {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品 %s 失败: %v", p.Code, err)
		}
	}
	for _, in := range []store.NewOrderInput{
		{CustomerName: "乙客", Phone: "13900000002", DeliveryType: "pickup",
			Items: []store.NewOrderInputItem{{Code: "7002", Qty: 10}}},
		{CustomerName: "甲客", Phone: "13900000001", DeliveryType: "pickup",
			Items: []store.NewOrderInputItem{{Code: "7001", Qty: 3}}},
	} {
		if _, err := st.CreateOrder(in); err != nil {
			t.Fatalf("造销量单失败: %v", err)
		}
	}
}

// r28AltCodes 替代推荐夹具：7101 是缺货主商品，7102/7103 同分类，7104/7105 他类（7105 缺货）。
// 销量故意做成「他类 7104（5 件）> 同分类 7103（2 件）」。
func r28SeedAlternatives(t *testing.T, st *store.Store) {
	t.Helper()
	for _, p := range []store.Product{
		{Code: "7101", Name: "缺货的主商品", Category: "饮料", SalePrice: 3, Stock: 0},
		{Code: "7102", Name: "同分类无销", Category: "饮料", SalePrice: 2, Stock: 5},
		{Code: "7103", Name: "同分类热销", Category: "饮料", SalePrice: 2.5, Stock: 8},
		// 库存给足：下面那张销量单要卖 5 件，卖完必须还剩货，否则会被「有库存」条件过滤掉
		{Code: "7104", Name: "他类热销", Category: "日杂", SalePrice: 4, Stock: 20},
		{Code: "7105", Name: "他类缺货", Category: "日杂", SalePrice: 4, Stock: 0},
	} {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品 %s 失败: %v", p.Code, err)
		}
	}
	for _, in := range []store.NewOrderInput{
		{CustomerName: "他类客", Phone: "13900000004", DeliveryType: "pickup",
			Items: []store.NewOrderInputItem{{Code: "7104", Qty: 5}}},
		{CustomerName: "同类客", Phone: "13900000003", DeliveryType: "pickup",
			Items: []store.NewOrderInputItem{{Code: "7103", Qty: 2}}},
	} {
		if _, err := st.CreateOrder(in); err != nil {
			t.Fatalf("造销量单失败: %v", err)
		}
	}
}

/* ------------------------------ §7.2 排序 ------------------------------ */

func TestR28ProductsSortHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	r28SeedSort(t, st)
	// 批发顾客：甲(7001) 有效价 1 元、乙(7002) 有效价 9 元——与零售档顺序完全不同。
	if _, err := st.SetCustomerTier("13800009999", "批发客", pricing.TierWholesale); err != nil {
		t.Fatalf("设顾客等级失败: %v", err)
	}

	cases := []struct{ path, want string }{
		{"/api/products", "7001,7002,7003"}, // default 保持 R27 的按 code
		{"/api/products?sort=default", "7001,7002,7003"},
		{"/api/products?sort=price_asc", "7002,7001,7003"}, // 零售价 2 < 3 < 4
		{"/api/products?sort=price_desc", "7003,7001,7002"},
		{"/api/products?sort=stock_desc", "7002,7003,7001"},                  // 50 > 20 > 5
		{"/api/products?sort=hot", "7002,7001,7003"},                         // 销量 10 > 3 > 0（0 的排后面，不排除）
		{"/api/products?sort=price_asc&phone=13800009999", "7001,7003,7002"}, // 批发价 1 < 4 < 9
		{"/api/products?sort=price_desc&phone=13800009999", "7002,7003,7001"},
	}
	for _, c := range cases {
		if got := r28CodesOf(r28GetProducts(t, ts, c.path).Items); got != c.want {
			t.Fatalf("%s 顺序应为 %s，实际 %s", c.path, c.want, got)
		}
	}

	// 批发档下条目上的 price/tier 也是批发口径（页面只读 price，不自己换算）
	res := r28GetProducts(t, ts, "/api/products?sort=price_asc&phone=13800009999")
	if res.Tier != pricing.TierWholesale {
		t.Fatalf("批发档 tier 应为 wholesale，实际 %q", res.Tier)
	}
	if res.Items[0].Code != "7001" || res.Items[0].Price != 1 {
		t.Fatalf("批发档首件应是 7001/1 元，实际 %s/%v", res.Items[0].Code, res.Items[0].Price)
	}

	// 老调用方形状不变：不带 phone 时价格是零售价、条目没有 tier 字段
	res = r28GetProducts(t, ts, "/api/products")
	if res.Tier != pricing.TierRetail {
		t.Fatalf("不带 phone 时 tier 应为 retail，实际 %q", res.Tier)
	}
	if res.Items[0].Code != "7001" || res.Items[0].Price != 3 || res.Items[0].Tier != "" {
		t.Fatalf("不带 phone 时首件应是 7001/3 元且无条目级 tier，实际 %+v", res.Items[0])
	}

	// 热销排序里无销量商品必须还在（丙 7003 在最后一名，不是被排除）
	hot := r28GetProducts(t, ts, "/api/products?sort=hot")
	if hot.Total != 3 || r28CodesOf(hot.Items) != "7002,7001,7003" {
		t.Fatalf("热销应保留无销量商品：total=%d items=%s", hot.Total, r28CodesOf(hot.Items))
	}
}

/* ------------------------------ §7.2 分页与 400 ------------------------------ */

func TestR28ProductsPagingHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	r28SeedSort(t, st)

	p1 := r28GetProducts(t, ts, "/api/products?limit=2&offset=0")
	if p1.Total != 3 || len(p1.Items) != 2 || p1.Limit != 2 || p1.Offset != 0 || !p1.HasMore {
		t.Fatalf("第一页应 2/3 条且 hasMore=true，实际 %+v", p1)
	}
	if r28CodesOf(p1.Items) != "7001,7002" {
		t.Fatalf("第一页应是 7001,7002，实际 %s", r28CodesOf(p1.Items))
	}
	p2 := r28GetProducts(t, ts, "/api/products?limit=2&offset=2")
	if p2.Total != 3 || len(p2.Items) != 1 || p2.Offset != 2 || p2.HasMore {
		t.Fatalf("第二页应 1/3 条且 hasMore=false，实际 %+v", p2)
	}
	// total 是过滤后的总数，不是当前页条数
	filtered := r28GetProducts(t, ts, "/api/products?keyword=7001&limit=1")
	if filtered.Total != 1 || len(filtered.Items) != 1 || filtered.HasMore {
		t.Fatalf("keyword 过滤后 total 应为 1，实际 %+v", filtered)
	}
	// limit=0 = 不限
	unlimited := r28GetProducts(t, ts, "/api/products")
	if unlimited.Limit != 0 || unlimited.Total != 3 || len(unlimited.Items) != 3 || unlimited.HasMore {
		t.Fatalf("limit=0 应全量 3 条且 hasMore=false，实际 %+v", unlimited)
	}
	// limit>200 夹到 200
	if capped := r28GetProducts(t, ts, "/api/products?limit=500"); capped.Limit != 200 {
		t.Fatalf("limit=500 应夹到 200，实际 %d", capped.Limit)
	}

	for _, path := range []string{
		"/api/products?limit=-1",
		"/api/products?offset=-1",
		"/api/products?limit=abc",
		"/api/products?offset=1.5",
		"/api/products?sort=bogus",
	} {
		code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, path, "", nil)
		if code != 400 {
			t.Fatalf("%s 期望 400，实际 %d：%s", path, code, body)
		}
	}
	// 未知排序的文案要说清是哪个值
	_, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, "/api/products?sort=bogus", "", nil)
	if !strings.Contains(body, "排序方式不支持：bogus") {
		t.Fatalf("未知 sort 文案不对：%s", body)
	}
}

/* ------------------------------ §7.3 /hot ------------------------------ */

func TestR28ProductsHotHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	for i := 0; i < 25; i++ {
		code := fmt.Sprintf("73%02d", i)
		if _, err := st.UpsertProduct(store.Product{Code: code, Name: "热销品" + code, SalePrice: 2, Stock: 100}); err != nil {
			t.Fatalf("写入商品 %s 失败: %v", code, err)
		}
	}
	// 只有 7301 有销量
	if _, err := st.CreateOrder(store.NewOrderInput{CustomerName: "买家", Phone: "13900000009",
		DeliveryType: "pickup", Items: []store.NewOrderInputItem{{Code: "7301", Qty: 3}}}); err != nil {
		t.Fatalf("造销量单失败: %v", err)
	}

	def := r28GetProducts(t, ts, "/api/products/hot")
	if len(def.Items) != 8 || def.Total != 25 {
		t.Fatalf("默认 limit 应为 8、total=25，实际 %d 条 / total=%d", len(def.Items), def.Total)
	}
	if def.Items[0].Code != "7301" {
		t.Fatalf("有销量的 7301 应排第一，实际 %s", def.Items[0].Code)
	}
	big := r28GetProducts(t, ts, "/api/products/hot?limit=99")
	if len(big.Items) != 20 || big.Total != 25 {
		t.Fatalf("limit 最大应夹到 20，实际 %d 条 / total=%d", len(big.Items), big.Total)
	}
	// 只回上架商品：下架一个后再看
	if _, err := st.SetProductsOnSale([]string{"7300"}, false); err != nil {
		t.Fatalf("下架失败: %v", err)
	}
	after := r28GetProducts(t, ts, "/api/products/hot?limit=20")
	if after.Total != 24 {
		t.Fatalf("下架 1 件后 total 应为 24，实际 %d", after.Total)
	}
	for _, p := range after.Items {
		if p.Code == "7300" {
			t.Fatalf("/hot 不该包含下架商品 7300")
		}
	}
	// 非法/负数 limit → 400
	for _, path := range []string{"/api/products/hot?limit=-1", "/api/products/hot?limit=abc"} {
		if code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, path, "", nil); code != 400 {
			t.Fatalf("%s 期望 400，实际 %d：%s", path, code, body)
		}
	}
}

/* ------------------------------ §7.4 /alternatives ------------------------------ */

func TestR28ProductsAlternativesHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	r28SeedAlternatives(t, st)

	// code 缺失 / 为空 / 商品不存在 → 200 空列表（页面要能安静降级，不是 400）
	for _, path := range []string{
		"/api/products/alternatives",
		"/api/products/alternatives?code=",
		"/api/products/alternatives?code=9999",
	} {
		res := r28GetProducts(t, ts, path)
		if res.Total != 0 || len(res.Items) != 0 {
			t.Fatalf("%s 应回空列表 + total=0，实际 %d 条 / total=%d", path, len(res.Items), res.Total)
		}
	}

	res := r28GetProducts(t, ts, "/api/products/alternatives?code=7101")
	if res.Total != 3 {
		t.Fatalf("候选总数应为 3（排除自身 7101 与缺货 7105），实际 %d", res.Total)
	}
	if got := r28CodesOf(res.Items); got != "7103,7102,7104" {
		t.Fatalf("同分类优先 + 全店热销补足应为 7103,7102,7104，实际 %s", got)
	}
	seen := map[string]bool{}
	for _, p := range res.Items {
		if seen[p.Code] {
			t.Fatalf("替代推荐出现重复商品：%s", p.Code)
		}
		seen[p.Code] = true
	}
	for _, banned := range []string{"7101", "7105"} {
		if seen[banned] {
			t.Fatalf("%s 不该出现在替代推荐里（自身/缺货）", banned)
		}
	}
	// limit 截断只影响条数，不影响 total
	res = r28GetProducts(t, ts, "/api/products/alternatives?code=7101&limit=2")
	if got := r28CodesOf(res.Items); got != "7103,7102" || res.Total != 3 {
		t.Fatalf("limit=2 应返回 7103,7102 且 total=3，实际 %s / total=%d", got, res.Total)
	}
	// 缺货商品自己也能查（页面在商品详情页也会调）
	if res := r28GetProducts(t, ts, "/api/products/alternatives?code=7105"); res.Total != 3 {
		t.Fatalf("缺货商品 7105 的候选应为 3，实际 %d", res.Total)
	}
	if code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, "/api/products/alternatives?code=7101&limit=-1", "", nil); code != 400 {
		t.Fatalf("负数 limit 期望 400，实际 %d：%s", code, body)
	}
}

/* ------------------------------ §7.5 订单筛选 ------------------------------ */

func TestR28OrdersFiltersHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	if _, err := st.UpsertProduct(store.Product{Code: "7201", Name: "可乐", SalePrice: 2, Stock: 100}); err != nil {
		t.Fatalf("写入商品失败: %v", err)
	}
	phoneA, phoneB := "13800001111", "13800002222"
	a, err := st.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: phoneA, DeliveryType: "pickup",
		Items: []store.NewOrderInputItem{{Code: "7201", Qty: 2}}})
	if err != nil {
		t.Fatalf("造单失败: %v", err)
	}
	b, err := st.CreateOrder(store.NewOrderInput{CustomerName: "李四", Phone: phoneB, DeliveryType: "delivery",
		Address: "测试路 2 号", Items: []store.NewOrderInputItem{{Code: "7201", Qty: 1}}})
	if err != nil {
		t.Fatalf("造单失败: %v", err)
	}
	today := time.Now().Format("2006-01-02")
	// 用真实接口把 B 的单取消掉，让 status 筛选有区分度（归属人取消 + 库存回补是第 27 轮
	// /cancel 的语义，本轮没动）。
	if code, body := r27Req(t, http.DefaultClient, ts, http.MethodPost,
		"/api/orders/"+b.ID+"/cancel?phone="+phoneB, "", nil); code != 200 {
		t.Fatalf("取消订单失败: %d %s", code, body)
	}

	// 不带 phone = 管理端视角（灰度放行），能看到全店
	if got := r28GetOrders(t, ts, "/api/orders"); got.Total != 2 || len(got.Items) != 2 {
		t.Fatalf("无筛选应看到 2 单，实际 %d 条 / total=%d", len(got.Items), got.Total)
	}
	cases := []struct {
		name, path, wantID string
		want               int
	}{
		{"q 命中顾客名", "/api/orders?q=" + r28Q("李四"), b.ID, 1},
		{"q 模糊命中手机号", "/api/orders?q=138000011", a.ID, 1},
		{"q 命中订单号", "/api/orders?q=" + r28Q(b.ID), b.ID, 1},
		{"status 单值命中 A", "/api/orders?status=pending", a.ID, 1},
		{"status 单值命中 B（已取消）", "/api/orders?status=cancelled", b.ID, 1},
		{"status 逗号多值", "/api/orders?status=pending,cancelled", "", 2},
		{"status 多值里带不命中的值", "/api/orders?status=pending,delivering", a.ID, 1},
		{"status 不命中", "/api/orders?status=done", "", 0},
		{"type=pickup", "/api/orders?type=pickup", a.ID, 1},
		{"type=delivery", "/api/orders?type=delivery", b.ID, 1},
		{"date=今天", "/api/orders?date=" + today, "", 2},
		{"date=过去某天", "/api/orders?date=1999-01-01", "", 0},
		{"from/to 含端点", "/api/orders?from=" + today + "&to=" + today, "", 2},
		{"排除今天（from 只在未来）", "/api/orders?from=2999-01-01&to=2999-12-31", "", 0},
		{"date 与 from/to 同给时 date 优先", "/api/orders?date=" + today + "&from=2999-01-01&to=2999-12-31", "", 2},
		{"筛选叠加", "/api/orders?type=pickup&q=" + r28Q("张三"), a.ID, 1},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := r28GetOrders(t, ts, c.path)
			if got.Total != c.want {
				t.Fatalf("%s 期望 %d 单，实际 %d", c.path, c.want, got.Total)
			}
			if c.wantID != "" && (len(got.Items) != 1 || got.Items[0].ID != c.wantID) {
				t.Fatalf("%s 应命中 %s，实际 %+v", c.path, c.wantID, got.Items)
			}
		})
	}

	// 非法日期 → 400，文案固定
	for _, path := range []string{
		"/api/orders?date=2026-13-99",
		"/api/orders?date=2026/10/05",
		"/api/orders?from=20261005",
		"/api/orders?to=不是日期",
	} {
		code, body := r27Req(t, http.DefaultClient, ts, http.MethodGet, path, "", nil)
		if code != 400 {
			t.Fatalf("%s 期望 400，实际 %d：%s", path, code, body)
		}
		if !strings.Contains(body, "日期格式应为 YYYY-MM-DD") {
			t.Fatalf("%s 文案应为「日期格式应为 YYYY-MM-DD」，实际 %s", path, body)
		}
	}

	// 顾客身份下：q 只能在**自己的单**里再筛，绝不允许靠 q 拿到别人的单
	t.Run("顾客身份下 q 越权不可得", func(t *testing.T) {
		t.Setenv("ADMIN_PASSWORD", "r28-secret") // 关掉灰度放行，?phone= 才代表顾客
		own := r28GetOrders(t, ts, "/api/orders?phone="+phoneA)
		if own.Total != 1 || own.Items[0].ID != a.ID {
			t.Fatalf("顾客 A 只该看到自己的 1 单，实际 %+v", own)
		}
		for _, q := range []string{phoneB, "李四", b.ID} {
			got := r28GetOrders(t, ts, "/api/orders?phone="+phoneA+"&q="+r28Q(q))
			if got.Total != 0 || len(got.Items) != 0 {
				t.Fatalf("顾客 A 用 q=%q 筛到了别人的单：%+v", q, got.Items)
			}
		}
		// 自己的单还能正常筛出来（不是把 q 整个忽略掉）
		got := r28GetOrders(t, ts, "/api/orders?phone="+phoneA+"&q="+r28Q("张三"))
		if got.Total != 1 || got.Items[0].ID != a.ID {
			t.Fatalf("顾客 A 用自己名字应筛到 1 单，实际 %+v", got)
		}
		// openid 身份同理
		if _, err := st.BindWxUser("o_r28A", "", phoneA, "张三", ""); err != nil {
			t.Fatalf("绑 openid 失败: %v", err)
		}
		got = r28GetOrders(t, ts, "/api/orders?openid=o_r28A&q="+r28Q(phoneB))
		if got.Total != 0 {
			t.Fatalf("openid 身份用 q=别人手机号应筛到 0 单，实际 %d", got.Total)
		}
	})
}

/* ------------------------------ §7.6 CSV 导出 ------------------------------ */

func TestR28OrdersExportCSVHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	if _, err := st.UpsertProduct(store.Product{Code: "7201", Name: "可乐", SalePrice: 2, Stock: 100}); err != nil {
		t.Fatalf("写入商品失败: %v", err)
	}
	weird := `张,三"老板` // 同时含逗号与双引号，逼出 RFC4180 转义
	o, err := st.CreateOrder(store.NewOrderInput{CustomerName: weird, Phone: "13800001111",
		DeliveryType: "pickup", Items: []store.NewOrderInputItem{{Code: "7201", Qty: 2}}})
	if err != nil {
		t.Fatalf("造单失败: %v", err)
	}

	code, hdr, body := r28Raw(t, ts, "/api/orders/export.csv")
	if code != 200 {
		t.Fatalf("导出期望 200，实际 %d：%s", code, body)
	}
	if len(body) < 3 || !bytes.Equal(body[:3], []byte{0xEF, 0xBB, 0xBF}) {
		t.Fatalf("CSV 首三字节必须是 EF BB BF，实际 % X", body)
	}
	if ct := hdr.Get("Content-Type"); ct != "text/csv; charset=utf-8" {
		t.Fatalf("Content-Type 应为 text/csv; charset=utf-8，实际 %q", ct)
	}
	disp := hdr.Get("Content-Disposition")
	if !regexp.MustCompile(`^attachment; filename="orders-\d{8}-\d{4}\.csv"$`).MatchString(disp) {
		t.Fatalf("Content-Disposition 形状不对：%q", disp)
	}

	// 用标准库按 RFC4180 读回来：含逗号与引号的顾客名也必须还是 12 列
	rows, err := csv.NewReader(bytes.NewReader(body[3:])).ReadAll()
	if err != nil {
		t.Fatalf("CSV 解析失败: %v", err)
	}
	if len(rows) != 2 {
		t.Fatalf("应有表头 + 1 行数据，实际 %d 行", len(rows))
	}
	if len(rows[0]) != 12 {
		t.Fatalf("表头应 12 列，实际 %d 列：%v", len(rows[0]), rows[0])
	}
	wantHeader := strings.Join([]string{"订单号", "下单时间", "状态", "顾客", "手机号", "配送方式",
		"商品明细", "件数", "商品金额", "配送费", "合计", "备注"}, ",")
	if got := strings.Join(rows[0], ","); got != wantHeader {
		t.Fatalf("表头不对：\n期望 %s\n实际 %s", wantHeader, got)
	}
	row := rows[1]
	if len(row) != 12 {
		t.Fatalf("数据行应 12 列（逗号/引号必须被转义），实际 %d 列：%v", len(row), row)
	}
	if row[0] != o.ID {
		t.Fatalf("订单号应为 %s，实际 %q", o.ID, row[0])
	}
	if row[3] != weird {
		t.Fatalf("顾客名应原样回读 %q，实际 %q", weird, row[3])
	}
	if row[4] != "13800001111" {
		t.Fatalf("手机号不对：%q", row[4])
	}
	if row[5] != "到店自提" {
		t.Fatalf("配送方式应中文，实际 %q", row[5])
	}
	if row[6] != "可乐×2;" {
		t.Fatalf("明细应为「可乐×2;」，实际 %q", row[6])
	}
	if row[7] != "2" {
		t.Fatalf("件数应为 2，实际 %q", row[7])
	}
	if row[8] != "4.00" {
		t.Fatalf("商品金额应为 4.00（2×2），实际 %q", row[8])
	}
	for _, idx := range []int{9, 10} {
		if !regexp.MustCompile(`^\d+\.\d{2}$`).MatchString(row[idx]) {
			t.Fatalf("金额列 %d 应为 2 位小数，实际 %q", idx, row[idx])
		}
	}
	if row[11] != "" {
		t.Fatalf("备注列本轮应为空，实际 %q", row[11])
	}
	if !regexp.MustCompile(`^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$`).MatchString(row[1]) {
		t.Fatalf("下单时间应为 YYYY-MM-DD HH:MM:SS，实际 %q", row[1])
	}
	// 原文里必须是 RFC4180 的 "" 转义，而不是别的花样
	if !strings.Contains(string(body), `"张,三""老板"`) {
		t.Fatalf("CSV 原文没有按 RFC4180 转义顾客名：%s", body)
	}

	// 同一套筛选参数：筛不到就只剩表头
	_, _, onlyHeader := r28Raw(t, ts, "/api/orders/export.csv?q="+r28Q("李四"))
	rows2, err := csv.NewReader(bytes.NewReader(onlyHeader[3:])).ReadAll()
	if err != nil {
		t.Fatalf("CSV 解析失败: %v", err)
	}
	if len(rows2) != 1 {
		t.Fatalf("带 q=李四 时应只剩表头，实际 %d 行", len(rows2))
	}
	// limit 也能用（负数/非法 → 400）
	if code, _, _ := r28Raw(t, ts, "/api/orders/export.csv?limit=-1"); code != 400 {
		t.Fatalf("负数 limit 期望 400，实际 %d", code)
	}
	if code, _, _ := r28Raw(t, ts, "/api/orders/export.csv?date=2026-13-99"); code != 400 {
		t.Fatalf("非法日期期望 400，实际 %d", code)
	}
	// 身份走 adminGate 形状：配了 ADMIN_PASSWORD 后无 Cookie 必须 401
	t.Run("配了 ADMIN_PASSWORD 后未登录 401", func(t *testing.T) {
		t.Setenv("ADMIN_PASSWORD", "r28-secret")
		if code, _, _ := r28Raw(t, ts, "/api/orders/export.csv"); code != 401 {
			t.Fatalf("未登录导出应 401，实际 %d", code)
		}
	})
}

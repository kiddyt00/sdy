package main

// 第 27 轮 HTTP 层单测：身份解析四态、订单归属与越权、分页与真实 total、
// advance/cancel 的权限、下单幂等与库存不足回滚、地址簿能力令牌、
// 管理端鉴权通道（ADMIN_PASSWORD 未设置=全放行；设置后未登录=401）。
//
// 注意：ADMIN_PASSWORD 未设置时 adminOK 恒为 true（灰度关闭，行为与第 26 轮一致），
// 所以「缺身份 400」「地址簿缺 key 读空」这类断言必须显式 t.Setenv("ADMIN_PASSWORD", ...)
// 才能观测到——这是设计使然，不是测试取巧。

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/kiddyt00/sdy/server/internal/barcode"
	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

// newR27Server 起一台测试服务器并**同时暴露 store**：本轮很多断言要看库里的
// 事实（流水、库存、client_token），只靠 HTTP 观测不到。
func newR27Server(t *testing.T) (*httptest.Server, *store.Store) {
	t.Helper()
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	res := barcode.New(st, barcode.DefaultConfig(), nil)
	// 静态目录里放一个 admin.html：/admin 是不带数据的登录壳，本轮刻意保持公开，
	// 测试要能验证它「没被鉴权包住」而不是「文件不存在所以 404」。
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "admin.html"), []byte("<!doctype html><title>admin</title>"), 0o644); err != nil {
		t.Fatalf("写测试用 admin.html 失败: %v", err)
	}
	ts := httptest.NewServer(withCORS(routes(st, res, dir, false, wxConf{})))
	t.Cleanup(ts.Close)
	return ts, st
}

// r27Req 发请求：hdr 里的头逐个设上；client 决定带不带 Cookie（管理端登录态靠它）。
func r27Req(t *testing.T, client *http.Client, ts *httptest.Server, method, path, body string, hdr map[string]string) (int, string) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := http.NewRequest(method, ts.URL+path, rdr)
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	if body != "" {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := client.Do(req)
	if err != nil {
		t.Fatalf("发请求失败: %v", err)
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		t.Fatalf("读响应失败: %v", err)
	}
	return res.StatusCode, string(raw)
}

// r27JarClient 带 Cookie 罐的客户端（管理端登录 / 退出用）。
func r27JarClient(t *testing.T) *http.Client {
	t.Helper()
	jar, err := cookiejar.New(nil)
	if err != nil {
		t.Fatalf("建 Cookie 罐失败: %v", err)
	}
	return &http.Client{Jar: jar}
}

// r27Seed 造两台顾客 + 两张单（A 一张、B 一张）+ 一个员工令牌 + 一个绑了 A 手机号的 openid。
type r27Fixture struct {
	orderA, orderB string
	staffToken     string
	phoneA, phoneB string
	openidA        string
}

func r27Seed(t *testing.T, st *store.Store) r27Fixture {
	t.Helper()
	for _, p := range []store.Product{
		{Code: "6901", Name: "可乐", SalePrice: 2.5, Stock: 120},
		{Code: "6902", Name: "农夫", SalePrice: 1.8, Stock: 3},
	} {
		if _, err := st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品失败: %v", err)
		}
	}
	f := r27Fixture{phoneA: "13800001111", phoneB: "13800002222", openidA: "o_A"}
	a, err := st.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: f.phoneA,
		DeliveryType: "pickup", Items: []store.NewOrderInputItem{{Code: "6901", Qty: 10}}})
	if err != nil {
		t.Fatalf("造单失败: %v", err)
	}
	b, err := st.CreateOrder(store.NewOrderInput{CustomerName: "李四", Phone: f.phoneB,
		DeliveryType: "pickup", Items: []store.NewOrderInputItem{{Code: "6901", Qty: 1}}})
	if err != nil {
		t.Fatalf("造单失败: %v", err)
	}
	f.orderA, f.orderB = a.ID, b.ID
	if _, err := st.BindWxUser(f.openidA, "", f.phoneA, "张三", ""); err != nil {
		t.Fatalf("造微信用户失败: %v", err)
	}
	if _, err := st.BindWxUser("o_STAFF", "", "", "小美", ""); err != nil {
		t.Fatalf("造员工失败: %v", err)
	}
	if _, err := st.SetWxUserRole("o_STAFF", store.RoleStaff); err != nil {
		t.Fatalf("设员工角色失败: %v", err)
	}
	tok, err := st.RotateStaffToken("o_STAFF")
	if err != nil {
		t.Fatalf("发员工令牌失败: %v", err)
	}
	f.staffToken = tok
	return f
}

// orderPage 解析 /api/orders 的信封。
type orderPage struct {
	Items  []store.Order `json:"items"`
	Total  int           `json:"total"`
	Limit  int           `json:"limit"`
	Offset int           `json:"offset"`
}

// TestR27OrdersIdentity 身份四态 + 只看自己的单。
func TestR27OrdersIdentity(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret") // 通道打开，身份才需要真的解析
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// ① 无身份 → 400，且文案要告诉顾客带什么
	code, body := r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", nil)
	if code != 400 || !strings.Contains(body, "缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token") {
		t.Fatalf("无身份应 400 且给出提示，实际 %d %s", code, body)
	}
	// 未知 openid 视为无身份（任务书：openid 未知算没有身份）
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders?openid=o_nobody", "", nil); code != 400 {
		t.Errorf("未知 openid 应视为无身份 400，实际 %d", code)
	}
	// ② phone 参数：只回该手机号的单
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA, "", nil)
	var page orderPage
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil {
		t.Fatalf("按 phone 查单失败: %d %s", code, body)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].Phone != f.phoneA {
		t.Errorf("按 phone 应只回自己的 1 单，实际 %+v", page)
	}
	// ③ openid：服务端用 wx_user.phone 折成业务身份
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?openid="+f.openidA, "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 1 ||
		page.Items[0].Phone != f.phoneA {
		t.Fatalf("按 openid 应只回自己的 1 单，实际 %d %s", code, body)
	}
	// ④ 员工令牌：看全量
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", map[string]string{"X-Staff-Token": f.staffToken})
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 2 {
		t.Fatalf("员工应看全量 2 单，实际 %d %s", code, body)
	}
	// ?staff= 查询参数同样认
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?staff="+f.staffToken, "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 2 {
		t.Errorf("?staff= 应同样放行全量，实际 %d %s", code, body)
	}
	// 失效令牌 → 401（不能因为「有令牌」就放行）
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", map[string]string{"X-Staff-Token": "deadbeef"}); code != 401 {
		t.Errorf("失效员工令牌应 401，实际 %d", code)
	}
}

// TestR27OrderDetailOwnership 订单详情：不是自己的单按 404 处理，不泄露存在性。
func TestR27OrderDetailOwnership(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// 自己的单 → 200
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders/"+f.orderA+"?phone="+f.phoneA, "", nil); code != 200 {
		t.Errorf("自己的单应 200，实际 %d", code)
	}
	// 别人的单 → 404 且文案就是「订单不存在」
	code, body := r27Req(t, anon, ts, http.MethodGet, "/api/orders/"+f.orderB+"?phone="+f.phoneA, "", nil)
	if code != 404 || !strings.Contains(body, "订单不存在") {
		t.Errorf("越权读单应 404 订单不存在，实际 %d %s", code, body)
	}
	// 无身份 → 404（不告诉调用方这单存不存在）
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders/"+f.orderA, "", nil); code != 404 {
		t.Errorf("无身份读单应 404，实际 %d", code)
	}
	// 员工 → 任意单 200
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders/"+f.orderB, "", map[string]string{"X-Staff-Token": f.staffToken}); code != 200 {
		t.Errorf("员工读任意单应 200，实际 %d", code)
	}
	// 不存在的单仍是 404
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders/M404?phone="+f.phoneA, "", nil); code != 404 {
		t.Errorf("不存在的单应 404，实际 %d", code)
	}
}

// TestR27OrdersPagingAndTotal total 必须是符合条件总数，items 才是当页；limit 上限 200。
func TestR27OrdersPagingAndTotal(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	for i := 0; i < 2; i++ { // A 一共 3 单
		if _, err := st.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: f.phoneA,
			DeliveryType: "pickup", Items: []store.NewOrderInputItem{{Code: "6901", Qty: 1}}}); err != nil {
			t.Fatal(err)
		}
	}
	anon := r27JarClient(t)

	code, body := r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA+"&limit=2", "", nil)
	var page orderPage
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil {
		t.Fatalf("分页查询失败: %d %s", code, body)
	}
	if page.Total != 3 || len(page.Items) != 2 || page.Limit != 2 || page.Offset != 0 {
		t.Errorf("第一页期望 total=3 len=2 limit=2 offset=0，实际 %+v", page)
	}
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA+"&limit=2&offset=2", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil {
		t.Fatalf("第二页失败: %d %s", code, body)
	}
	if page.Total != 3 || len(page.Items) != 1 || page.Offset != 2 {
		t.Errorf("第二页期望 total=3 len=1 offset=2，实际 %+v", page)
	}
	// 默认 limit=50；非法/负数回默认；上限 200
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA, "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Limit != 50 {
		t.Errorf("默认 limit 应为 50，实际 %d %s", code, body)
	}
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA+"&limit=abc&offset=-3", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Limit != 50 || page.Offset != 0 {
		t.Errorf("非法 limit/offset 应回默认，实际 %d %s", code, body)
	}
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA+"&limit=500", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Limit != 200 {
		t.Errorf("limit 上限应为 200，实际 %d %s", code, body)
	}
	// status 过滤仍然可用
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneA+"&status=done", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 0 {
		t.Errorf("status 过滤应生效（done 为 0），实际 %d %s", code, body)
	}
}

// TestR27AdvancePermission 只有店主/员工能推进状态；顾客只能确认收货自己那一单。
func TestR27AdvancePermission(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// 顾客想改成「配送中」→ 403
	code, body := r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/advance?phone="+f.phoneA,
		`{"to":"delivering"}`, nil)
	if code != 403 || !strings.Contains(body, "只有店主可以推进订单状态") {
		t.Fatalf("顾客推进备货应 403，实际 %d %s", code, body)
	}
	// 不是自己的单，就算 to=done 也 403
	if code, _ := r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderB+"/advance?phone="+f.phoneA,
		`{"to":"done"}`, nil); code != 403 {
		t.Errorf("推进别人的单应 403，实际 %d", code)
	}
	// 员工可以推进到「待取货」
	code, body = r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/advance",
		`{"to":"ready"}`, map[string]string{"X-Staff-Token": f.staffToken})
	if code != 200 || !strings.Contains(body, `"status":"ready"`) {
		t.Fatalf("员工推进应 200，实际 %d %s", code, body)
	}
	// 顾客确认收货（ready → done）自己的单 → 放行
	code, body = r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/advance?phone="+f.phoneA,
		`{"to":"done"}`, nil)
	if code != 200 || !strings.Contains(body, `"status":"done"`) {
		t.Fatalf("顾客确认收货应 200，实际 %d %s", code, body)
	}
	// 非法流转仍是 409（状态机没被放宽）
	if code, _ := r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/advance",
		`{"to":"pending"}`, map[string]string{"X-Staff-Token": f.staffToken}); code != 409 {
		t.Errorf("非法流转应 409，实际 %d", code)
	}
}

// TestR27CancelPermissionAndAudit 取消：归属校验 + 回补必须写流水 + 幂等。
func TestR27CancelPermissionAndAudit(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// 不是自己的单 → 404（不泄露存在性）
	code, body := r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderB+"/cancel?phone="+f.phoneA, "", nil)
	if code != 404 || !strings.Contains(body, "订单不存在") {
		t.Fatalf("取消别人的单应 404，实际 %d %s", code, body)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 109 {
		t.Errorf("越权取消不得动库存：期望 109，实际 %v", p.Stock)
	}
	// 自己的单 → 200 且回补写流水
	code, body = r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/cancel?phone="+f.phoneA, "", nil)
	if code != 200 || !strings.Contains(body, `"status":"cancelled"`) {
		t.Fatalf("取消自己的单应 200，实际 %d %s", code, body)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 119 {
		t.Errorf("取消应回补 10 件到 119，实际 %v", p.Stock)
	}
	logs, err := st.ListStockLog(50)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, e := range logs {
		if e.Kind == store.StockKindCancel && e.OrderID == f.orderA && e.Delta == 10 && e.Reason == "取消订单回补" {
			found = true
			if e.By != "顾客" {
				t.Errorf("顾客取消的操作人应记「顾客」，实际 %q", e.By)
			}
		}
	}
	if !found {
		t.Errorf("取消回补必须写 stock_log（kind=%s order_id=%s），实际 %+v", store.StockKindCancel, f.orderA, logs)
	}
	// 幂等：再取消一次不报错、不回补第二次
	code, body = r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/cancel?phone="+f.phoneA, "", nil)
	if code != 200 {
		t.Fatalf("重复取消应幂等 200，实际 %d %s", code, body)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 119 {
		t.Errorf("重复取消不得再回补：期望 119，实际 %v", p.Stock)
	}
	// 员工可以取消任意单，流水记员工名
	code, _ = r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderB+"/cancel", "",
		map[string]string{"X-Staff-Token": f.staffToken})
	if code != 200 {
		t.Fatalf("员工取消应 200，实际 %d", code)
	}
	logs, _ = st.ListStockLog(5)
	if len(logs) == 0 || logs[0].By != "小美" || logs[0].OrderID != f.orderB {
		t.Errorf("员工取消的流水应记员工名与订单号，实际 %+v", logs)
	}
}

// TestR27OrderCreateIdempotentHTTP 下单幂等 + 库存不足 400 + 起送价 400。
func TestR27OrderCreateIdempotentHTTP(t *testing.T) {
	ts, st := newR27Server(t)
	r27Seed(t, st) // 种子里 A 单 10 件、B 单 1 件：6901 现在 109 件
	anon := r27JarClient(t)

	body := `{"customerName":"张三","phone":"13800003333","deliveryType":"pickup",` +
		`"clientToken":"tok-1","items":[{"code":"6901","qty":2}]}`
	code, resp := r27Req(t, anon, ts, http.MethodPost, "/api/orders", body, nil)
	if code != 201 || strings.Contains(resp, "duplicated") {
		t.Fatalf("首次下单应 201 且无 duplicated，实际 %d %s", code, resp)
	}
	var first store.Order
	if err := json.Unmarshal([]byte(resp), &first); err != nil {
		t.Fatalf("解析下单响应失败: %v (%s)", err, resp)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 107 {
		t.Fatalf("下单后库存期望 107，实际 %v", p.Stock)
	}
	// 同一 clientToken 再来一次 → 200 + duplicated:true + 原单，且库存不动
	code, resp = r27Req(t, anon, ts, http.MethodPost, "/api/orders", body, nil)
	if code != 200 || !strings.Contains(resp, `"duplicated":true`) {
		t.Fatalf("重复下单应 200 duplicated:true，实际 %d %s", code, resp)
	}
	var second store.Order
	if err := json.Unmarshal([]byte(resp), &second); err != nil {
		t.Fatalf("解析重复下单响应失败: %v (%s)", err, resp)
	}
	if second.ID != first.ID {
		t.Errorf("幂等应回原单 %s，实际 %s", first.ID, second.ID)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 107 {
		t.Errorf("重复下单不得再扣库存：期望 107，实际 %v", p.Stock)
	}
	// 库存不足 → 400（不是 409），文案带商品名与剩余件数，且整单回滚
	code, resp = r27Req(t, anon, ts, http.MethodPost, "/api/orders",
		`{"customerName":"张三","phone":"13800003333","deliveryType":"pickup",`+
			`"items":[{"code":"6901","qty":1},{"code":"6902","qty":99}]}`, nil)
	if code != 400 || !strings.Contains(resp, "库存不足：农夫（还剩 3 件）") {
		t.Fatalf("库存不足应 400 且说明剩余，实际 %d %s", code, resp)
	}
	if p, _ := st.GetProduct("6901"); p.Stock != 107 {
		t.Errorf("库存不足必须整单回滚：6901 期望 107，实际 %v", p.Stock)
	}
	// 起送价：货款不够 → 400「还差 X 元起送」
	if _, err := st.SaveSettings(store.Settings{Name: "家庭超市", MinOrder: 20}); err != nil {
		t.Fatal(err)
	}
	code, resp = r27Req(t, anon, ts, http.MethodPost, "/api/orders",
		`{"customerName":"张三","phone":"13800003333","deliveryType":"pickup",`+
			`"items":[{"code":"6901","qty":1}]}`, nil)
	if code != 400 || !strings.Contains(resp, "还差 17.5 元起送") {
		t.Fatalf("未达起送价应 400「还差 17.5 元起送」，实际 %d %s", code, resp)
	}
	// 下架商品仍是 409（原有语义不动）
	if _, err := st.SetProductsOnSale([]string{"6901"}, false); err != nil {
		t.Fatal(err)
	}
	code, resp = r27Req(t, anon, ts, http.MethodPost, "/api/orders",
		`{"customerName":"张三","phone":"13800003333","deliveryType":"pickup",`+
			`"items":[{"code":"6901","qty":30}]}`, nil)
	if code != 409 || !strings.Contains(resp, "已下架") {
		t.Errorf("下架商品下单应 409，实际 %d %s", code, resp)
	}
}

// TestR27AddressKeyHTTP 地址簿能力令牌：没 key 读空、有 key 才给、员工放行。
func TestR27AddressKeyHTTP(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// 首次保存地址 → 发一枚 32 位 hex
	code, body := r27Req(t, anon, ts, http.MethodPost, "/api/addresses",
		`{"phone":"`+f.phoneA+`","contact":"张三","address":"幸福路 1 号"}`, nil)
	if code != 200 {
		t.Fatalf("保存地址应 200，实际 %d %s", code, body)
	}
	var saved struct {
		store.Address
		OK  bool   `json:"ok"`
		Key string `json:"key"`
	}
	if err := json.Unmarshal([]byte(body), &saved); err != nil {
		t.Fatalf("解析保存响应失败: %v (%s)", err, body)
	}
	if !saved.OK || len(saved.Key) != 32 {
		t.Fatalf("应回 ok:true 与 32 位 key，实际 %s", body)
	}
	if saved.ID == 0 || saved.Contact != "张三" {
		t.Errorf("地址字段应平铺在响应顶层（兼容老前端），实际 %s", body)
	}
	// 再存一次：复用同一枚 key
	_, body = r27Req(t, anon, ts, http.MethodPost, "/api/addresses",
		`{"phone":"`+f.phoneA+`","contact":"张三","address":"幸福路 2 号"}`, nil)
	var again struct {
		Key string `json:"key"`
	}
	_ = json.Unmarshal([]byte(body), &again)
	if again.Key != saved.Key {
		t.Errorf("同一手机号应复用同一枚 key：%q vs %q", saved.Key, again.Key)
	}
	// 缺 key → 静默空（200，不是 400、也不是 403）
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "", nil)
	var list struct {
		Items []store.Address `json:"items"`
		Total int             `json:"total"`
	}
	if code != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list.Items) != 0 || list.Total != 0 {
		t.Fatalf("缺 key 应回 `{items:[],total:0}`，实际 %d %s", code, body)
	}
	// 错误 key → 同样静默空
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA+"&key=deadbeef", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &list) != nil || list.Total != 0 {
		t.Errorf("错误 key 应静默空，实际 %d %s", code, body)
	}
	// 正确 key → 拿到 2 条
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA+"&key="+saved.Key, "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list.Items) != 2 {
		t.Fatalf("正确 key 应回 2 条地址，实际 %d %s", code, body)
	}
	// 员工不带 key 也能看（管理端代客查址）
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "",
		map[string]string{"X-Staff-Token": f.staffToken})
	if code != 200 || json.Unmarshal([]byte(body), &list) != nil || len(list.Items) != 2 {
		t.Errorf("员工应能看地址簿，实际 %d %s", code, body)
	}
	// 缺 phone 仍是 400（原有断言不动）
	if code, body := r27Req(t, anon, ts, http.MethodGet, "/api/addresses", "", nil); code != 400 ||
		!strings.Contains(body, "手机号") {
		t.Errorf("缺 phone 应 400，实际 %d %s", code, body)
	}
	// 删除：缺 key → 404；带 key → 200
	if code, _ := r27Req(t, anon, ts, http.MethodDelete,
		"/api/addresses/"+itoa(list.Items[0].ID)+"?phone="+f.phoneA, "", nil); code != 404 {
		t.Errorf("缺 key 删除应 404，实际 %d", code)
	}
	if code, _ := r27Req(t, anon, ts, http.MethodDelete,
		"/api/addresses/"+itoa(list.Items[0].ID)+"?phone="+f.phoneA+"&key="+saved.Key, "", nil); code != 200 {
		t.Errorf("带 key 删除应 200，实际 %d", code)
	}
}

// TestR27SettingsDeliversRules GET /api/settings 要下发 lowStock/minOrder/deliveryFee/minFree。
func TestR27SettingsDeliversRules(t *testing.T) {
	ts, st := newR27Server(t)
	anon := r27JarClient(t)

	code, body := r27Req(t, anon, ts, http.MethodGet, "/api/settings", "", nil)
	var cfg store.Settings
	if code != 200 || json.Unmarshal([]byte(body), &cfg) != nil {
		t.Fatalf("读设置失败: %d %s", code, body)
	}
	if cfg.LowStock != store.LowStockThreshold || cfg.MinOrder != 0 || cfg.DeliveryFee != 3 || cfg.MinFree != 30 {
		t.Errorf("默认规则参数应下发 5/0/3/30，实际 %+v", cfg)
	}
	code, body = r27Req(t, anon, ts, http.MethodPost, "/api/settings",
		`{"name":"家庭超市","lowStock":8,"minOrder":20}`, nil)
	if code != 200 {
		t.Fatalf("保存设置失败: %d %s", code, body)
	}
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/settings", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &cfg) != nil || cfg.LowStock != 8 || cfg.MinOrder != 20 {
		t.Errorf("保存后应下发 8/20，实际 %d %s", code, body)
	}
	// 只改店名时应保留库里已有的 lowStock/minOrder（指针语义：没传＝不动）
	if _, err := st.SaveSettings(store.Settings{Name: "小店", LowStock: 8, MinOrder: 20}); err != nil {
		t.Fatal(err)
	}
	if code, _ := r27Req(t, anon, ts, http.MethodPost, "/api/settings", `{"name":"小店"}`, nil); code != 200 {
		t.Fatal("只改店名应成功")
	}
	_, body = r27Req(t, anon, ts, http.MethodGet, "/api/settings", "", nil)
	_ = json.Unmarshal([]byte(body), &cfg)
	if cfg.LowStock != 8 || cfg.MinOrder != 20 {
		t.Errorf("未传 lowStock/minOrder 应保留现状 8/20，实际 %+v", cfg)
	}
}

// TestR27GrayChannelStillFiltersCustomers 灰度默认（ADMIN_PASSWORD 未设置）：
// 管理端接口照旧全放行（老板不会被锁在门外），但**只要请求带了顾客身份，就必须按顾客过滤**。
//
// 这条用例是第 27 轮端到端验收实测失败的回归：以前 adminOK 排在最前，通道关着时
// 任何请求都算管理员，于是 ?phone=B 也能读到 A 的订单、地址簿的 key 形同虚设、
// 没有员工令牌也能把别人的单推进到「配送中」。
func TestR27GrayChannelStillFiltersCustomers(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "") // 灰度默认：通道关闭
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// ① 顾客 B 查列表只看得到自己的单
	code, body := r27Req(t, anon, ts, http.MethodGet, "/api/orders?phone="+f.phoneB, "", nil)
	var page orderPage
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil {
		t.Fatalf("灰度下按 phone 查单失败: %d %s", code, body)
	}
	if page.Total != 1 || len(page.Items) != 1 || page.Items[0].Phone != f.phoneB {
		t.Errorf("灰度下按 phone 应只回自己的 1 单，实际 %+v", page)
	}
	// ② 越权读单按 404，不泄露存在性
	if code, b := r27Req(t, anon, ts, http.MethodGet, "/api/orders/"+f.orderA+"?phone="+f.phoneB, "", nil); code != 404 || !strings.Contains(b, "订单不存在") {
		t.Errorf("灰度下越权读单应 404 订单不存在，实际 %d %s", code, b)
	}
	// ③ 无令牌推进别人的单 → 403（通道关着不是「谁都是管理员」）
	if code, b := r27Req(t, anon, ts, http.MethodPost, "/api/orders/"+f.orderA+"/advance?phone="+f.phoneB, `{"to":"delivering"}`, nil); code != 403 || !strings.Contains(b, "只有店主可以推进订单状态") {
		t.Errorf("灰度下无令牌推进应 403，实际 %d %s", code, b)
	}
	// ④ 地址簿：只有手机号、没有 key → 读空
	if code, b := r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "", nil); code != 200 || !strings.Contains(b, `"total":0`) {
		t.Errorf("灰度下缺 key 应读空，实际 %d %s", code, b)
	}
	// ⑤ 管理端自己的列表请求（完全不带身份）在灰度下仍然放行：老板的后台要能用
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", nil)
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 2 {
		t.Errorf("灰度下无身份的管理端列表应放行全量 2 单，实际 %d %s", code, body)
	}
	// ⑥ 员工令牌任何模式下都是全量
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", map[string]string{"X-Staff-Token": f.staffToken})
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 2 {
		t.Errorf("灰度下员工仍应看全量 2 单，实际 %d %s", code, body)
	}
	// ⑦ 管理端声明（X-Admin: 1）必须盖过同一个浏览器里记住的顾客手机号。
	// 这就是老板在后台点「派单」的真实请求形状：sdy-api.advanceOrder 会顺手拼 ?phone=<老板手机号>，
	// 若按顾客身份先解析，灰度档会被判成「顾客推进订单」而 403——后台派单直接报错。
	code, body = r27Req(t, anon, ts, http.MethodPost,
		"/api/orders/"+f.orderA+"/advance?phone="+f.phoneA, `{"to":"delivering"}`, map[string]string{"X-Admin": "1"})
	if code != 200 || !strings.Contains(body, `"delivering"`) {
		t.Errorf("灰度下带 X-Admin 的派单应放行（不能被 ?phone= 拖成顾客），实际 %d %s", code, body)
	}
	// ⑧ X-Wx-Openid 是小程序发的头名（utils/api.js identityParams），必须能解析出顾客身份
	code, body = r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", map[string]string{"X-Wx-Openid": f.openidA})
	if code != 200 || json.Unmarshal([]byte(body), &page) != nil || page.Total != 1 || page.Items[0].Phone != f.phoneA {
		t.Errorf("只带 X-Wx-Openid 头应解析出顾客 A 的 1 单，实际 %d %s", code, body)
	}
}

// TestR27AdminChannelOff ADMIN_PASSWORD 未设置 = 通道关闭：所有管理接口行为与第 26 轮一致。
func TestR27AdminChannelOff(t *testing.T) {
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)

	// 管理接口一律放行：没有任何 Cookie 也 200
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/stocklog", ""},
		{http.MethodGet, "/api/couriers", ""},
		{http.MethodGet, "/api/customers", ""},
		{http.MethodGet, "/api/wx/users", ""},
		{http.MethodGet, "/api/barcode/lib", ""},
		{http.MethodGet, "/api/pricing/check", ""},
		{http.MethodGet, "/admin", ""},
		{http.MethodPost, "/api/products/stock", `{"code":"6901","stock":50}`},
		{http.MethodPost, "/api/stock/change", `{"code":"6901","kind":"adjust","qty":1,"reason":"t","by":"老板"}`},
		{http.MethodPost, "/api/couriers", `{"name":"老王","phone":"139"}`},
		{http.MethodPost, "/api/products/onsale", `{"codes":["6901"],"onSale":true}`},
		{http.MethodPost, "/api/customers/tier", `{"phone":"13800001111","tier":"vip"}`},
		{http.MethodPost, "/api/customers/note", `{"phone":"13800001111","note":"熟客"}`},
		{http.MethodPost, "/api/wx/role", `{"openid":"o_A","role":"customer"}`},
		{http.MethodPost, "/api/products", `{"code":"6909","name":"新货","salePrice":1,"stock":0}`},
		{http.MethodDelete, "/api/products/6909", ""},
	} {
		if code, body := r27Req(t, anon, ts, c.method, c.path, c.body, nil); code != 200 {
			t.Errorf("通道关闭时 %s %s 应 200，实际 %d %s", c.method, c.path, code, body)
		}
	}
	// 订单/地址接口同样按「管理员放行」处理（第 26 轮行为）
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/orders", "", nil); code != 200 {
		t.Errorf("通道关闭时 GET /api/orders 应 200（全量），实际 %d", code)
	}
	if code, body := r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "", nil); code != 200 ||
		!strings.Contains(body, "items") {
		t.Errorf("通道关闭时读地址簿应 200，实际 %d %s", code, body)
	}
	// 公开端点不受影响
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/healthz", "", nil); code != 200 {
		t.Error("healthz 应 200")
	}
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/products?onSale=1", "", nil); code != 200 {
		t.Error("顾客端商品列表应 200")
	}
	// 登录接口在通道关闭时明确回 enabled:false（前端据此知道不用登录）
	code, body := r27Req(t, anon, ts, http.MethodPost, "/api/admin/login", `{"password":"whatever"}`, nil)
	if code != 200 || !strings.Contains(body, `"enabled":false`) {
		t.Errorf("通道关闭时登录应回 enabled:false，实际 %d %s", code, body)
	}
}

// TestR27AdminChannelOn ADMIN_PASSWORD 已设置：未登录 401，登录后可写，退出后又 401；
// 公开端点（healthz / wx / staff / 顾客端商品）保持公开。
func TestR27AdminChannelOn(t *testing.T) {
	t.Setenv("ADMIN_PASSWORD", "s3cret")
	ts, st := newR27Server(t)
	f := r27Seed(t, st)
	anon := r27JarClient(t)
	admin := r27JarClient(t)

	// 未登录：管理接口 401 + 明确文案
	for _, c := range []struct{ method, path, body string }{
		{http.MethodGet, "/api/stocklog", ""},
		{http.MethodGet, "/api/couriers", ""},
		{http.MethodGet, "/api/customers", ""},
		{http.MethodGet, "/api/wx/users", ""},
		{http.MethodGet, "/api/barcode/lib", ""},
		{http.MethodGet, "/api/pricing/check", ""},
		{http.MethodPost, "/api/products/stock", `{"code":"6901","stock":50}`},
		{http.MethodPost, "/api/stock/change", `{"code":"6901","kind":"adjust","qty":1,"reason":"t","by":"老板"}`},
		{http.MethodPost, "/api/products", `{"code":"6909","name":"新货","salePrice":1,"stock":1}`},
		{http.MethodPost, "/api/products/onsale", `{"codes":["6901"],"onSale":true}`},
		{http.MethodPost, "/api/customers/tier", `{"phone":"13800001111","tier":"vip"}`},
		{http.MethodPost, "/api/customers/note", `{"phone":"13800001111","note":"熟客"}`},
		{http.MethodPost, "/api/wx/role", `{"openid":"o_A","role":"customer"}`},
		{http.MethodPost, "/api/settings", `{"name":"小店"}`},
		{http.MethodDelete, "/api/products/6901", ""},
	} {
		if code, body := r27Req(t, anon, ts, c.method, c.path, c.body, nil); code != 401 ||
			!strings.Contains(body, "请先登录管理后台") {
			t.Errorf("未登录 %s %s 应 401，实际 %d %s", c.method, c.path, code, body)
		}
	}
	// 公开端点：健康检查 / 顾客端商品 / 小程序资料 / 员工扫码
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/healthz", "", nil); code != 200 {
		t.Error("healthz 应保持公开")
	}
	// /admin 是没有数据的登录壳，刻意不鉴权（否则设了口令会把老板锁在门外）；
	// 它背后的每个数据接口都已逐个鉴权。
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/admin", "", nil); code != 200 {
		t.Error("/admin 是登录壳，应保持公开（数据接口才鉴权）")
	}
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/products?onSale=1&phone="+f.phoneA, "", nil); code != 200 {
		t.Error("顾客端商品列表应保持公开")
	}
	if code, body := r27Req(t, anon, ts, http.MethodPost, "/api/wx/profile", `{}`, nil); code != 400 ||
		!strings.Contains(body, "缺少 openid") {
		t.Errorf("wx/profile 应保持公开（这里应因缺 openid 而 400），实际 %d %s", code, body)
	}
	if code, body := r27Req(t, anon, ts, http.MethodGet, "/api/staff/scan?code=6901", "", nil); code != 401 ||
		!strings.Contains(body, "员工身份") {
		t.Errorf("staff/scan 应仍是员工令牌鉴权（这里应 401 员工身份），实际 %d %s", code, body)
	}
	// 顾客端读地址簿：通道打开时不再是管理员，缺 key 应静默空
	if code, body := r27Req(t, anon, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "", nil); code != 200 ||
		!strings.Contains(body, `"total":0`) {
		t.Errorf("通道打开时顾客读地址簿应静默空，实际 %d %s", code, body)
	}
	// 口令不对 → 401；没有 Cookie
	if code, body := r27Req(t, admin, ts, http.MethodPost, "/api/admin/login", `{"password":"nope"}`, nil); code != 401 ||
		!strings.Contains(body, "管理口令不对") {
		t.Fatalf("错误口令应 401，实际 %d %s", code, body)
	}
	if code, _ := r27Req(t, admin, ts, http.MethodGet, "/api/customers", "", nil); code != 401 {
		t.Fatal("错误口令登录后不应拿到访问权")
	}
	// 正确口令 → 200 + HttpOnly/SameSite Cookie
	code, body := r27Req(t, admin, ts, http.MethodPost, "/api/admin/login", `{"password":"s3cret"}`, nil)
	if code != 200 || !strings.Contains(body, `"enabled":true`) {
		t.Fatalf("登录应 200 enabled:true，实际 %d %s", code, body)
	}
	if code, body := r27Req(t, admin, ts, http.MethodGet, "/api/customers", "", nil); code != 200 {
		t.Fatalf("带管理 Cookie 应放行，实际 %d %s", code, body)
	}
	// 记录 Cookie 属性也检查一遍（用一次显式请求读 Set-Cookie）
	loginReq, _ := http.NewRequest(http.MethodPost, ts.URL+"/api/admin/login", strings.NewReader(`{"password":"s3cret"}`))
	loginReq.Header.Set("Content-Type", "application/json")
	res, err := ts.Client().Do(loginReq)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	var ck *http.Cookie
	for _, c := range res.Cookies() {
		if c.Name == adminCookieName {
			ck = c
		}
	}
	if ck == nil {
		t.Fatalf("登录应下发 %s Cookie", adminCookieName)
	}
	if !ck.HttpOnly || ck.SameSite != http.SameSiteStrictMode || ck.Path != "/" || ck.MaxAge <= 0 {
		t.Errorf("管理 Cookie 属性不对：HttpOnly=%v SameSite=%v Path=%q MaxAge=%d",
			ck.HttpOnly, ck.SameSite, ck.Path, ck.MaxAge)
	}
	// 篡改 Cookie → 401（签名必须真的校验）
	req, _ := http.NewRequest(http.MethodGet, ts.URL+"/api/customers", nil)
	req.AddCookie(&http.Cookie{Name: adminCookieName, Value: ck.Value + "00"})
	tres, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	tres.Body.Close()
	if tres.StatusCode != 401 {
		t.Errorf("签名被篡改的 Cookie 应 401，实际 %d", tres.StatusCode)
	}
	// 管理后台读订单：Cookie + 显式声明 X-Admin = 看全量。
	// 第 27 轮验收实测的真问题：管理员 Cookie 与顾客页共用同一个浏览器，若服务端
	// 「带了 Cookie 就当管理员」，老板自己逛顾客页（无声明）就会看到全店订单，
	// 于是 ?phone=B 能看到 A 的单、地址簿 key 形同虚设。管理端身份必须显式声明。
	if code, body := r27Req(t, admin, ts, http.MethodGet, "/api/orders", "",
		map[string]string{"X-Admin": "1"}); code != 200 || !strings.Contains(body, `"total":2`) {
		t.Errorf("带管理 Cookie + X-Admin 读订单应看全量 2 单，实际 %d %s", code, body)
	}
	// 同一个人：带 Cookie 但不声明（= 用同一个浏览器逛顾客页）+ 指定手机号 → 只回本人的单
	if code, body := r27Req(t, admin, ts, http.MethodGet, "/api/orders?phone="+f.phoneB, "", nil); code != 200 ||
		!strings.Contains(body, `"total":1`) || strings.Contains(body, f.orderA) {
		t.Errorf("带 Cookie 但不声明 X-Admin 时应按顾客手机号过滤（只见 B 的 1 单），实际 %d %s", code, body)
	}
	// 带 Cookie 但不声明 + 完全没有身份 → 400（不再被当成管理员全量放行）
	if code, body := r27Req(t, admin, ts, http.MethodGet, "/api/orders", "", nil); code != 400 ||
		!strings.Contains(body, "缺少身份") {
		t.Errorf("通道打开时未声明 X-Admin 的无身份请求应 400，实际 %d %s", code, body)
	}
	// 地址簿同样：不声明 + 缺 key → 静默空（key 是真边界）
	if code, body := r27Req(t, admin, ts, http.MethodGet, "/api/addresses?phone="+f.phoneA, "", nil); code != 200 ||
		!strings.Contains(body, `"total":0`) {
		t.Errorf("不声明 X-Admin 时管理端 Cookie 不应绕过地址簿 key，实际 %d %s", code, body)
	}
	// 退出 → Cookie 失效
	if code, _ := r27Req(t, admin, ts, http.MethodPost, "/api/admin/logout", "", nil); code != 200 {
		t.Fatal("退出应 200")
	}
	if code, _ := r27Req(t, admin, ts, http.MethodGet, "/api/customers", "", nil); code != 401 {
		t.Error("退出后应 401")
	}
	// 登录接口只认 POST
	if code, _ := r27Req(t, anon, ts, http.MethodGet, "/api/admin/login", "", nil); code != 405 {
		t.Error("GET /api/admin/login 应 405")
	}
}

// TestR27CORSAllowsIdentityHeaders 跨源页面要能带身份头（审计：Allow-Headers 只有 Content-Type）。
func TestR27CORSAllowsIdentityHeaders(t *testing.T) {
	ts, _ := newR27Server(t)
	req, err := http.NewRequest(http.MethodOptions, ts.URL+"/api/orders", nil)
	if err != nil {
		t.Fatal(err)
	}
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		t.Errorf("预检应 204，实际 %d", res.StatusCode)
	}
	allow := res.Header.Get("Access-Control-Allow-Headers")
	for _, h := range []string{"X-Staff-Token", "X-Openid", "X-Wx-Openid", "X-Phone", "X-Admin", "Content-Type"} {
		if !strings.Contains(allow, h) {
			t.Errorf("Allow-Headers 应包含 %s，实际 %q", h, allow)
		}
	}
}

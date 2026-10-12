package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/kiddyt00/sdy/server/internal/barcode"
	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

// newTestServer 起一个内存库的测试服务（静态目录用临时目录，避免读到真实页面）。
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	res := barcode.New(st, barcode.DefaultConfig(), nil)
	ts := httptest.NewServer(withCORS(routes(st, res, t.TempDir(), false)))
	t.Cleanup(ts.Close)
	return ts
}

// do 发一个请求，返回状态码与响应体文本。
func do(t *testing.T, ts *httptest.Server, method, path, body string) (int, string) {
	t.Helper()
	var r *http.Request
	var err error
	if body == "" {
		r, err = http.NewRequest(method, ts.URL+path, nil)
	} else {
		r, err = http.NewRequest(method, ts.URL+path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
	}
	if err != nil {
		t.Fatalf("构造请求失败: %v", err)
	}
	res, err := ts.Client().Do(r)
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

func productTotal(t *testing.T, ts *httptest.Server) int {
	t.Helper()
	code, body := do(t, ts, http.MethodGet, "/api/products", "")
	if code != 200 {
		t.Fatalf("取商品列表失败: %d %s", code, body)
	}
	var out struct {
		Total int `json:"total"`
	}
	if err := json.Unmarshal([]byte(body), &out); err != nil {
		t.Fatalf("解析商品列表失败: %v (%s)", err, body)
	}
	return out.Total
}

// TestProductHTTPFlow 建档 → 改档案 → 删档案的完整 HTTP 流程与错误码映射。
func TestProductHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"6901","name":"可口可乐","salePrice":2.5,"costPrice":1.8,"stock":12,"unit":"罐","category":"饮料"}`)
	if code != 200 {
		t.Fatalf("建档应成功，实际 %d %s", code, body)
	}
	if !strings.Contains(body, `"unit":"罐"`) {
		t.Errorf("建档响应缺少单位: %s", body)
	}
	if productTotal(t, ts) != 1 {
		t.Errorf("建档后应有 1 个商品")
	}

	// 改档案（价格 + 名称）：请求**不带 stock** → 后端保留现有库存（编辑表单不改库存）
	code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"6901","name":"可口可乐 330ml","salePrice":2.6,"costPrice":1.8,"unit":"罐","category":"饮料"}`)
	if code != 200 || !strings.Contains(body, "可口可乐 330ml") {
		t.Fatalf("改档案应成功，实际 %d %s", code, body)
	}
	if !strings.Contains(body, `"stock":12`) {
		t.Errorf("改档案不带 stock 时应保留库存 12，实际 %s", body)
	}

	// 校验：名称必填
	if code, body = do(t, ts, http.MethodPost, "/api/products", `{"code":"6902","salePrice":1}`); code != 400 || !strings.Contains(body, "名称") {
		t.Errorf("空名称应 400 且提示名称，实际 %d %s", code, body)
	}
	// 校验：价格为负
	if code, _ = do(t, ts, http.MethodPost, "/api/products", `{"code":"6902","name":"雪碧","salePrice":-1}`); code != 400 {
		t.Errorf("负售价应 400，实际 %d", code)
	}
	// 价格防线：参考价 4.00 → 上限 3.80
	if code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"6902","name":"雪碧","salePrice":3.9,"refPrice":4}`); code != 400 || !strings.Contains(body, "比价防线") {
		t.Errorf("超价应 400 且提示比价防线，实际 %d %s", code, body)
	}
	// 批发商品豁免
	if code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"6902","name":"雪碧","salePrice":3.9,"refPrice":4,"isWholesale":true}`); code != 200 {
		t.Errorf("批发商品应豁免防线，实际 %d %s", code, body)
	}
	if productTotal(t, ts) != 2 {
		t.Errorf("应有 2 个商品")
	}

	// 删除约束：库存非 0
	if code, body = do(t, ts, http.MethodDelete, "/api/products/6901", ""); code != 409 || !strings.Contains(body, "盘点为 0") {
		t.Errorf("库存非 0 应 409 且提示盘点为 0，实际 %d %s", code, body)
	}
	// 先把库存改到 0，再删
	if code, body = do(t, ts, http.MethodPost, "/api/products/stock", `{"code":"6901","stock":0}`); code != 200 {
		t.Fatalf("改库存应成功，实际 %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodDelete, "/api/products/6901", ""); code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Errorf("库存为 0 应可删除，实际 %d %s", code, body)
	}
	// 再删一次 → 404
	if code, _ = do(t, ts, http.MethodDelete, "/api/products/6901", ""); code != 404 {
		t.Errorf("重复删除应 404，实际 %d", code)
	}
	// 缺条码 → 400；方法不对 → 405
	if code, _ = do(t, ts, http.MethodDelete, "/api/products/", ""); code != 400 {
		t.Errorf("缺条码应 400，实际 %d", code)
	}
	if code, _ = do(t, ts, http.MethodPut, "/api/products/6902", "{}"); code != 405 {
		t.Errorf("PUT 应 405，实际 %d", code)
	}
	// 剩下的商品仍在
	if productTotal(t, ts) != 1 {
		t.Errorf("删除后应剩 1 个商品")
	}
}

// TestProductStockSemantics 建档/编辑的库存语义：不带 stock = 不改库存，带了才写；档案变更标记待同步。
func TestProductStockSemantics(t *testing.T) {
	ts := newTestServer(t)

	// 建档带初始库存
	code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"7001","name":"矿泉水","salePrice":2,"stock":7,"unit":"瓶"}`)
	if code != 200 || !strings.Contains(body, `"stock":7`) {
		t.Fatalf("建档应写入初始库存 7，实际 %d %s", code, body)
	}
	if !strings.Contains(body, `"syncStatus":"pending"`) {
		t.Errorf("建档后应标记待同步，实际 %s", body)
	}
	// 编辑不带 stock → 保留 7
	code, body = do(t, ts, http.MethodPost, "/api/products", `{"code":"7001","name":"矿泉水 550ml","salePrice":2.2}`)
	if code != 200 || !strings.Contains(body, `"stock":7`) {
		t.Errorf("编辑不带 stock 应保留库存 7，实际 %d %s", code, body)
	}
	// 明确传 stock:0 → 写 0
	code, body = do(t, ts, http.MethodPost, "/api/products", `{"code":"7001","name":"矿泉水 550ml","salePrice":2.2,"stock":0}`)
	if code != 200 || !strings.Contains(body, `"stock":0`) {
		t.Errorf("显式传 stock 0 应写 0，实际 %d %s", code, body)
	}
	// 新建不带 stock → 0（不是报错）
	code, body = do(t, ts, http.MethodPost, "/api/products", `{"code":"7002","name":"纸巾","salePrice":6}`)
	if code != 200 || !strings.Contains(body, `"stock":0`) {
		t.Errorf("新建不带 stock 应为 0，实际 %d %s", code, body)
	}
	// 档案变更落到列表：缺省单位/分类在 store 层补全
	code, body = do(t, ts, http.MethodGet, "/api/products", "")
	if code != 200 || !strings.Contains(body, `"unit":"件"`) || !strings.Contains(body, `"category":"未分类"`) {
		t.Errorf("列表应含补全后的单位与分类，实际 %d %s", code, body)
	}
}

// TestHealthzAndOptions CORS 预检与健康检查（部署到域名后前端要跨域写）。
func TestHealthzAndOptions(t *testing.T) {
	ts := newTestServer(t)
	if code, body := do(t, ts, http.MethodGet, "/healthz", ""); code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Errorf("healthz 应 200，实际 %d %s", code, body)
	}
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/api/products/6901", nil)
	res, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("预检失败: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != 204 {
		t.Errorf("OPTIONS 应 204，实际 %d", res.StatusCode)
	}
	if got := res.Header.Get("Access-Control-Allow-Methods"); !strings.Contains(got, "DELETE") {
		t.Errorf("预检应允许 DELETE，实际 %q", got)
	}
}

// TestAddressHTTPFlow 收货地址簿 HTTP 层（D18）：增改查删 + 错误映射 + 默认地址轮换。
func TestAddressHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	// 没有手机号 → 400
	if code, body := do(t, ts, http.MethodGet, "/api/addresses", ""); code != 400 || !strings.Contains(body, "手机号") {
		t.Fatalf("缺手机号应 400，实际 %d %s", code, body)
	}

	// 新增第一条 → 自动默认
	code, body := do(t, ts, http.MethodPost, "/api/addresses",
		`{"phone":"13800000001","contact":"张三","address":"幸福路 1 号"}`)
	if code != 200 || !strings.Contains(body, `"isDefault":true`) {
		t.Fatalf("首条地址应 200 且默认，实际 %d %s", code, body)
	}
	var first store.Address
	if err := json.Unmarshal([]byte(body), &first); err != nil || first.ID == 0 {
		t.Fatalf("解析新增地址失败: %v (%s)", err, body)
	}

	// 列表里能看到
	code, body = do(t, ts, http.MethodGet, "/api/addresses?phone=13800000001", "")
	if code != 200 || !strings.Contains(body, `"total":1`) || !strings.Contains(body, "幸福路 1 号") {
		t.Fatalf("地址列表应有 1 条，实际 %d %s", code, body)
	}

	// 第二条显式设为默认 → 列表默认地址换人且排最前
	code, body = do(t, ts, http.MethodPost, "/api/addresses",
		`{"phone":"13800000001","contact":"张三","address":"幸福路 2 号","isDefault":true}`)
	if code != 200 {
		t.Fatalf("新增第二条失败: %d %s", code, body)
	}
	var second store.Address
	_ = json.Unmarshal([]byte(body), &second)
	code, body = do(t, ts, http.MethodGet, "/api/addresses?phone=13800000001", "")
	var list struct {
		Items []store.Address `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		t.Fatalf("解析地址列表失败: %v (%s)", err, body)
	}
	if len(list.Items) != 2 || !list.Items[0].IsDefault || list.Items[0].ID != second.ID {
		t.Fatalf("默认地址应换到最新一条并排最前，实际 %+v", list.Items)
	}

	// 校验：缺收货人 / 缺地址
	if code, body := do(t, ts, http.MethodPost, "/api/addresses", `{"phone":"13800000001","address":"幸福路"}`); code != 400 || !strings.Contains(body, "收货人") {
		t.Fatalf("缺收货人应 400，实际 %d %s", code, body)
	}
	if code, body := do(t, ts, http.MethodPost, "/api/addresses", `{"phone":"13800000001","contact":"张三"}`); code != 400 || !strings.Contains(body, "送货地址") {
		t.Fatalf("缺地址应 400，实际 %d %s", code, body)
	}

	// 删除：缺编号 / 编号不合法 / 方法不支持
	if code, body := do(t, ts, http.MethodDelete, "/api/addresses/", ""); code != 400 || !strings.Contains(body, "缺少地址编号") {
		t.Fatalf("缺编号应 400，实际 %d %s", code, body)
	}
	if code, body := do(t, ts, http.MethodDelete, "/api/addresses/abc?phone=13800000001", ""); code != 400 || !strings.Contains(body, "编号不合法") {
		t.Fatalf("编号不合法应 400，实际 %d %s", code, body)
	}
	if code, body := do(t, ts, http.MethodPut, "/api/addresses/"+itoa(first.ID)+"?phone=13800000001", ""); code != 405 {
		t.Fatalf("PUT 应 405，实际 %d %s", code, body)
	}

	// 删掉默认地址 → 剩下的一条顶为默认
	code, body = do(t, ts, http.MethodDelete, "/api/addresses/"+itoa(second.ID)+"?phone=13800000001", "")
	if code != 200 || !strings.Contains(body, `"ok":true`) {
		t.Fatalf("删除应 200，实际 %d %s", code, body)
	}
	code, body = do(t, ts, http.MethodGet, "/api/addresses?phone=13800000001", "")
	_ = json.Unmarshal([]byte(body), &list)
	if len(list.Items) != 1 || list.Items[0].ID != first.ID || !list.Items[0].IsDefault {
		t.Fatalf("删掉默认后剩下的一条应变默认，实际 %+v", list.Items)
	}

	// 重复删除 → 404；缺手机号 → 400
	if code, _ := do(t, ts, http.MethodDelete, "/api/addresses/"+itoa(second.ID)+"?phone=13800000001", ""); code != 404 {
		t.Fatalf("重复删除应 404，实际 %d", code)
	}
	if code, _ := do(t, ts, http.MethodDelete, "/api/addresses/"+itoa(first.ID), ""); code != 400 {
		t.Fatalf("缺手机号应 400，实际 %d", code)
	}
}

func itoa(n int64) string {
	return strconv.FormatInt(n, 10)
}

// TestAdminCleanURL 管理端干净地址（D22）：/admin 直出 admin.html、/admin/ 301 到 /admin、
// 老地址 /admin.html 继续可用（不能让老板已收藏的链接失效）。
func TestAdminCleanURL(t *testing.T) {
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// 静态目录里放一个带标记的 admin.html，避免依赖真实页面内容
	dir := t.TempDir()
	page := []byte("<title>小邻里超市 · 经营管理台</title>")
	if err := os.WriteFile(filepath.Join(dir, "admin.html"), page, 0o644); err != nil {
		t.Fatalf("写测试页面失败: %v", err)
	}
	ts := httptest.NewServer(routes(st, barcode.New(st, barcode.DefaultConfig(), nil), dir, false))
	t.Cleanup(ts.Close)

	// /admin → 200 且内容就是 admin.html
	code, body := do(t, ts, http.MethodGet, "/admin", "")
	if code != 200 || !strings.Contains(body, "经营管理台") {
		t.Fatalf("/admin 应 200 且直出管理端页面，实际 %d %s", code, body)
	}
	// 老地址继续可用
	if code, body := do(t, ts, http.MethodGet, "/admin.html", ""); code != 200 || !strings.Contains(body, "经营管理台") {
		t.Fatalf("/admin.html 应继续可用，实际 %d %s", code, body)
	}

	// /admin/ → 301 到 /admin（不再跟随重定向，否则相对路径基准会变成 /admin/）
	client := &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Get(ts.URL + "/admin/")
	if err != nil {
		t.Fatalf("请求 /admin/ 失败: %v", err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusMovedPermanently {
		t.Errorf("/admin/ 应 301，实际 %d", res.StatusCode)
	}
	if loc := res.Header.Get("Location"); loc != "/admin" {
		t.Errorf("/admin/ 应跳到 /admin，实际 %q", loc)
	}
}

// 任务池⑥ / D23：上下架走独立接口，编辑档案不改变状态，顾客端只看上架商品。
func TestProductOnSaleHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	// 建档：默认上架，且响应里必须带 onSale（不能省略，否则前端把 false 当缺省）
	code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"7101","name":"红牛","salePrice":6,"stock":9,"unit":"罐"}`)
	if code != 200 || !strings.Contains(body, `"onSale":true`) {
		t.Fatalf("建档应默认上架并下发 onSale=true，实际 %d %s", code, body)
	}

	// 下架
	code, body = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":["7101"],"onSale":false}`)
	if code != 200 || !strings.Contains(body, `"count":1`) || !strings.Contains(body, `"changed":["7101"]`) {
		t.Fatalf("下架应成功并返回 changed，实际 %d %s", code, body)
	}

	// 顾客端列表（onSale=1）不含；管理端全量仍含且 onSale=false
	if _, body = do(t, ts, http.MethodGet, "/api/products?onSale=1", ""); strings.Contains(body, "7101") {
		t.Errorf("顾客端不应看到下架商品，实际 %s", body)
	}
	if _, body = do(t, ts, http.MethodGet, "/api/products", ""); !strings.Contains(body, `"onSale":false`) {
		t.Errorf("管理端应看到下架商品并带 onSale=false，实际 %s", body)
	}

	// 编辑档案（改名 + 改价）不应把它恢复上架
	code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"7101","name":"红牛（新包装）","salePrice":6.5,"stock":9,"unit":"罐"}`)
	if code != 200 || !strings.Contains(body, `"onSale":false`) {
		t.Errorf("编辑档案不应改变上下架状态，实际 %d %s", code, body)
	}

	// 下架商品下单：409 + 明确文案
	code, body = do(t, ts, http.MethodPost, "/api/orders",
		`{"customerName":"王阿姨","phone":"13800001111","deliveryType":"pickup","items":[{"code":"7101","qty":1}]}`)
	if code != 409 || !strings.Contains(body, "已下架") {
		t.Fatalf("下架商品下单应 409 且提示已下架，实际 %d %s", code, body)
	}

	// 重新上架后可以下单
	if code, body = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":["7101"],"onSale":true}`); code != 200 {
		t.Fatalf("上架失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/orders",
		`{"customerName":"王阿姨","phone":"13800001111","deliveryType":"pickup","items":[{"code":"7101","qty":1}]}`); code != 201 {
		t.Fatalf("上架后应能下单，实际 %d %s", code, body)
	}

	// 边界：空清单 400；未知条码 404；重复下架 count 0
	if code, _ = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":[],"onSale":false}`); code != 400 {
		t.Errorf("空清单应 400，实际 %d", code)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":["不存在"],"onSale":false}`); code != 404 {
		t.Errorf("未知条码应 404，实际 %d", code)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":["7101"],"onSale":true}`); code != 200 || !strings.Contains(body, `"count":0`) {
		t.Errorf("重复上架应为 count 0，实际 %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodGet, "/api/products/onsale", ""); code != 405 {
		t.Errorf("GET /api/products/onsale 应 405，实际 %d", code)
	}
}

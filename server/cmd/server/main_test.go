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
	"time"

	"github.com/kiddyt00/sdy/server/internal/barcode"
	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

// newTestServer 起一个内存库的测试服务（静态目录用临时目录，避免读到真实页面）。
func newTestServer(t *testing.T) *httptest.Server {
	t.Helper()
	return newTestServerWx(t, wxConf{})
}

// newTestServerWx 同上，但可注入微信登录配置（测试指向假微信服务器，本地不出网）。
func newTestServerWx(t *testing.T, wxc wxConf) *httptest.Server {
	t.Helper()
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	res := barcode.New(st, barcode.DefaultConfig(), nil)
	if wxc.client == nil {
		wxc.client = &http.Client{Timeout: 3 * time.Second}
	}
	ts := httptest.NewServer(withCORS(routes(st, res, t.TempDir(), false, wxc)))
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
	page := []byte("<title>啥都有快送 · 经营管理台</title>")
	if err := os.WriteFile(filepath.Join(dir, "admin.html"), page, 0o644); err != nil {
		t.Fatalf("写测试页面失败: %v", err)
	}
	ts := httptest.NewServer(routes(st, barcode.New(st, barcode.DefaultConfig(), nil), dir, false, wxConf{}))
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

// 任务池⑦ / D24：顾客等级 HTTP 全流程 —— 设等级 → 带 phone 取批发价 → 下单按批发价入库。
func TestCustomerTierHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	if code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"7101","name":"整箱可乐","salePrice":60,"wholesalePrice":52,"stock":10,"unit":"箱","category":"饮料"}`); code != 200 {
		t.Fatalf("建档失败: %d %s", code, body)
	}

	// 不带 phone / 陌生手机号：都是零售价
	code, body := do(t, ts, http.MethodGet, "/api/products?onSale=1", "")
	if code != 200 || !strings.Contains(body, `"tier":"retail"`) || !strings.Contains(body, `"price":60`) {
		t.Fatalf("不带 phone 应回零售价: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/products?onSale=1&phone=13900000000", ""); code != 200 || !strings.Contains(body, `"tier":"retail"`) {
		t.Fatalf("陌生手机号应回零售价: %d %s", code, body)
	}

	// 设成批发等级后，带 phone 拉列表就拿到批发价（价格口径由服务端算）
	if code, body = do(t, ts, http.MethodPost, "/api/customers/tier",
		`{"phone":"13800001111","name":"王老板","tier":"wholesale"}`); code != 200 || !strings.Contains(body, `"tier":"wholesale"`) {
		t.Fatalf("设等级失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/products?onSale=1&phone=13800001111", ""); code != 200 ||
		!strings.Contains(body, `"tier":"wholesale"`) || !strings.Contains(body, `"price":52`) {
		t.Fatalf("批发顾客应拿批发价: %d %s", code, body)
	}

	// 顾客列表可查
	if code, body = do(t, ts, http.MethodGet, "/api/customers", ""); code != 200 || !strings.Contains(body, `"phone":"13800001111"`) {
		t.Fatalf("顾客列表失败: %d %s", code, body)
	}

	// 下单按批发价入库（前端传价不参与计算）
	code, body = do(t, ts, http.MethodPost, "/api/orders",
		`{"customerName":"王老板","phone":"13800001111","deliveryType":"pickup","items":[{"code":"7101","qty":2}]}`)
	if code != 201 {
		t.Fatalf("下单失败: %d %s", code, body)
	}
	if !strings.Contains(body, `"price":52`) || !strings.Contains(body, `"subtotal":104`) {
		t.Fatalf("订单应按批发价入库: %s", body)
	}

	// 边界：非法等级 400（错误文案原样透出）、方法不支持 405
	if code, body = do(t, ts, http.MethodPost, "/api/customers/tier", `{"phone":"13800002222","tier":"gold"}`); code != 400 ||
		!strings.Contains(body, "参数不合法") {
		t.Errorf("非法等级应 400 参数不合法，实际 %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodGet, "/api/customers/tier", ""); code != 405 {
		t.Errorf("GET /api/customers/tier 应 405，实际 %d", code)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/customers", `{}`); code != 405 {
		t.Errorf("POST /api/customers 应 405，实际 %d", code)
	}
}

// 任务池⑧（D25）：库存变更走服务端唯一入口，一次事务里改库存 + 留流水。
func TestStockChangeHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	if code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"7201","name":"整箱可乐","salePrice":60,"stock":10,"unit":"箱"}`); code != 200 {
		t.Fatalf("建档失败: %d %s", code, body)
	}

	// 入库 30：响应带流水与改后库存（前端据此刷新本地镜像）
	code, body := do(t, ts, http.MethodPost, "/api/stock/change",
		`{"code":"7201","kind":"stock_in","qty":30,"reason":"整箱到货","by":"老板"}`)
	if code != 200 || !strings.Contains(body, `"stock":40`) || !strings.Contains(body, `"kind":"stock_in"`) ||
		!strings.Contains(body, `"before":10`) || !strings.Contains(body, `"after":40`) ||
		!strings.Contains(body, `"reason":"整箱到货"`) {
		t.Fatalf("入库应返回流水与改后库存，实际 %d %s", code, body)
	}

	// 改数 -5、盘点 30（盘点写的是实盘数，delta 由服务端算）
	if code, body = do(t, ts, http.MethodPost, "/api/stock/change",
		`{"code":"7201","kind":"adjust","qty":-5,"reason":"破损报废","by":"老板"}`); code != 200 ||
		!strings.Contains(body, `"stock":35`) {
		t.Fatalf("改数失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/stock/change",
		`{"code":"7201","kind":"stock_take","qty":30,"reason":"盘点","by":"老板"}`); code != 200 ||
		!strings.Contains(body, `"stock":30`) || !strings.Contains(body, `"delta":-5`) {
		t.Fatalf("盘点失败: %d %s", code, body)
	}

	// 流水可查，最新在前
	code, body = do(t, ts, http.MethodGet, "/api/stocklog?limit=30", "")
	if code != 200 || !strings.Contains(body, `"total":3`) || !strings.Contains(body, `"kind":"stock_take"`) {
		t.Fatalf("流水查询失败: %d %s", code, body)
	}

	// 非法输入一条都不许留痕，库存也不许变
	for _, bad := range []string{
		`{"code":"7201","kind":"nope","qty":1}`,
		`{"code":"7201","kind":"stock_in","qty":0}`,
		`{"code":"7201","kind":"adjust","qty":0}`,
		`{"code":"7201","kind":"stock_take","qty":-1}`,
		`{"code":"","kind":"stock_in","qty":1}`,
		`{"code":"查无此货","kind":"stock_in","qty":1}`,
	} {
		if code, body = do(t, ts, http.MethodPost, "/api/stock/change", bad); code != 400 && code != 404 {
			t.Errorf("非法输入应 400/404，实际 %d %s（%s）", code, body, bad)
		}
	}
	if code, body = do(t, ts, http.MethodGet, "/api/stocklog", ""); code != 200 || !strings.Contains(body, `"total":3`) {
		t.Errorf("失败不应留流水，实际 %d %s", code, body)
	}
	if _, body = do(t, ts, http.MethodGet, "/api/products?keyword=7201", ""); !strings.Contains(body, `"stock":30`) {
		t.Errorf("失败不应改库存，实际 %s", body)
	}

	// 老接口 SetStock 也留流水（绝对值 → 走同一个入口）
	if code, body = do(t, ts, http.MethodPost, "/api/products/stock", `{"code":"7201","stock":45}`); code != 200 ||
		!strings.Contains(body, `"stock":45`) {
		t.Fatalf("老接口改库存失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/stocklog", ""); code != 200 ||
		!strings.Contains(body, `"total":4`) || !strings.Contains(body, "直接改数") {
		t.Errorf("老接口也应留流水，实际 %d %s", code, body)
	}

	// 方法不支持
	if code, _ = do(t, ts, http.MethodGet, "/api/stock/change", ""); code != 405 {
		t.Errorf("GET /api/stock/change 应 405，实际 %d", code)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/stocklog", `{}`); code != 405 {
		t.Errorf("POST /api/stocklog 应 405，实际 %d", code)
	}
}

// 任务池⑧（D25）：配送员、门店抬头、顾客备注都落库，换设备后一致。
func TestCourierSettingsNoteHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	// 配送员：默认种入 4 位（原来只在浏览器 localStorage 里）
	code, body := do(t, ts, http.MethodGet, "/api/couriers", "")
	if code != 200 || !strings.Contains(body, `"total":4`) || !strings.Contains(body, "老张") {
		t.Fatalf("默认配送员应为 4 位，实际 %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"阿明","phone":"13900009999"}`); code != 200 ||
		!strings.Contains(body, `"total":5`) || !strings.Contains(body, "阿明") {
		t.Fatalf("新增配送员失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"阿明","remove":true}`); code != 200 ||
		!strings.Contains(body, `"total":4`) {
		t.Fatalf("删除配送员失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"  "}`); code != 400 ||
		!strings.Contains(body, "不能为空") {
		t.Errorf("空姓名应 400，实际 %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"查无此人","remove":true}`); code != 404 {
		t.Errorf("删不存在应 404，实际 %d", code)
	}
	for _, n := range []string{"小李", "阿强", "小美"} {
		if code, body = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"`+n+`","remove":true}`); code != 200 {
			t.Fatalf("删除 %s 失败: %d %s", n, code, body)
		}
	}
	if code, body = do(t, ts, http.MethodPost, "/api/couriers", `{"name":"老张","remove":true}`); code != 409 ||
		!strings.Contains(body, "至少要保留一位配送员") {
		t.Errorf("只剩一位时应 409，实际 %d %s", code, body)
	}

	// 门店抬头：默认值 → 保存 → 回读一致
	if code, body = do(t, ts, http.MethodGet, "/api/settings", ""); code != 200 ||
		!strings.Contains(body, "家庭超市") || !strings.Contains(body, "谢谢惠顾") {
		t.Fatalf("默认门店抬头不对: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/settings",
		`{"name":"水东洋便利店","phone":"13800001111","address":"水东洋小区 1 栋","footer":""}`); code != 200 ||
		!strings.Contains(body, "水东洋便利店") || !strings.Contains(body, "谢谢惠顾") {
		t.Fatalf("保存门店抬头失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/settings", ""); code != 200 ||
		!strings.Contains(body, "水东洋便利店") || !strings.Contains(body, "水东洋小区 1 栋") {
		t.Fatalf("回读门店抬头不一致: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/settings", `{"name":"  "}`); code != 400 ||
		!strings.Contains(body, "请填写店名") {
		t.Errorf("空店名应 400，实际 %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodDelete, "/api/settings", ""); code != 405 {
		t.Errorf("DELETE /api/settings 应 405，实际 %d", code)
	}

	// 顾客备注与标签：建档默认零售；改备注不动等级与姓名
	if code, body = do(t, ts, http.MethodPost, "/api/customers/note",
		`{"phone":"13800001111","name":"王阿姨","tags":"老客,爱买啤酒","note":"三楼，放冰箱"}`); code != 200 ||
		!strings.Contains(body, `"tier":"retail"`) || !strings.Contains(body, "爱买啤酒") {
		t.Fatalf("写顾客备注失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/customers/tier",
		`{"phone":"13800001111","name":"","tier":"vip"}`); code != 200 {
		t.Fatalf("设等级失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/customers/note",
		`{"phone":"13800001111","name":"","tags":"老客","note":"改地址了"}`); code != 200 ||
		!strings.Contains(body, `"tier":"vip"`) || !strings.Contains(body, "王阿姨") ||
		!strings.Contains(body, "改地址了") {
		t.Fatalf("改备注不应动等级与姓名: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/customers", ""); code != 200 ||
		!strings.Contains(body, "改地址了") || !strings.Contains(body, "老客") {
		t.Fatalf("顾客列表应带出标签备注: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodPost, "/api/customers/note",
		`{"phone":"13800001111","note":"`+strings.Repeat("长", 201)+`"}`); code != 400 ||
		!strings.Contains(body, "备注不能超过 200 字") {
		t.Errorf("超长备注应 400，实际 %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodGet, "/api/customers/note", ""); code != 405 {
		t.Errorf("GET /api/customers/note 应 405，实际 %d", code)
	}
}

// secretForTest 假 AppSecret：用来断言它绝不会出现在任何响应体里（D13）。
const secretForTest = "SECRET_MUST_NOT_LEAK_9f3a"

// TestWxLoginHTTPFlow 微信登录（第 23 轮 / D28）：假微信服务器换 openid → 绑手机号 →
// 等级取顾客档案（绑定不提权）、未配置 503、错误码翻译、secret 绝不外泄。
func TestWxLoginHTTPFlow(t *testing.T) {
	var hits int
	fake := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/sns/jscode2session" {
			t.Errorf("微信接口路径不对: %s", r.URL.Path)
		}
		q := r.URL.Query()
		hits++
		if q.Get("appid") != "wx_test" || q.Get("secret") != secretForTest ||
			q.Get("grant_type") != "authorization_code" {
			t.Errorf("code2session 参数不对: %s", r.URL.RawQuery)
		}
		switch q.Get("js_code") {
		case "BAD":
			_, _ = w.Write([]byte(`{"errcode":40029,"errmsg":"invalid code"}`))
		case "FLOOD":
			_, _ = w.Write([]byte(`{"errcode":45011,"errmsg":"freq limit"}`))
		default:
			_, _ = w.Write([]byte(`{"openid":"o_TEST_1","unionid":"u_TEST_1","session_key":"sk_must_not_leak"}`))
		}
	}))
	defer fake.Close()

	ts := newTestServerWx(t, wxConf{appid: "wx_test", secret: secretForTest, apiBase: fake.URL})

	// 收集所有响应体，最后统一断言 secret / session_key 没有外泄。
	var seen strings.Builder
	call := func(ts *httptest.Server, method, path, body string) (int, string) {
		c, b := do(t, ts, method, path, body)
		seen.WriteString(b)
		return c, b
	}

	// 老板先把 13800001111 设成批发客户（等级只能由管理端设定，D24）
	if code, body := call(ts, http.MethodPost, "/api/customers/tier",
		`{"phone":"13800001111","name":"王阿姨","tier":"wholesale"}`); code != 200 {
		t.Fatalf("设等级失败: %d %s", code, body)
	}

	// ① 只带 code：登录成功但不绑定，等级零售
	code, body := call(ts, http.MethodPost, "/api/wx/login", `{"code":"CODE_1"}`)
	if code != 200 || !strings.Contains(body, `"ok":true`) || !strings.Contains(body, `"openid":"o_TEST_1"`) ||
		!strings.Contains(body, `"bound":false`) || !strings.Contains(body, `"tier":"retail"`) {
		t.Fatalf("首次登录失败: %d %s", code, body)
	}

	// ② 带手机号：绑到批发顾客，等级跟着档案走（绑手机号本身不提权）
	code, body = call(ts, http.MethodPost, "/api/wx/login",
		`{"code":"CODE_2","phone":"13800001111","nickname":"阿明","avatar":"https://x/a.png"}`)
	if code != 200 || !strings.Contains(body, `"bound":true`) || !strings.Contains(body, `"tier":"wholesale"`) ||
		!strings.Contains(body, `"name":"王阿姨"`) || !strings.Contains(body, `"avatar":"https://x/a.png"`) {
		t.Fatalf("绑手机号后应拿到批发等级与档案姓名: %d %s", code, body)
	}

	// ③ 同一台微信再次登录（新 code、不带手机号）：绑定保留、等级不变
	code, body = call(ts, http.MethodPost, "/api/wx/login", `{"code":"CODE_3"}`)
	if code != 200 || !strings.Contains(body, `"bound":true`) || !strings.Contains(body, `"tier":"wholesale"`) ||
		!strings.Contains(body, `"openid":"o_TEST_1"`) {
		t.Fatalf("再次登录应保留绑定: %d %s", code, body)
	}

	// ④ 绑定档案可在后台审阅（只读）
	if code, body = call(ts, http.MethodGet, "/api/wx/users", ""); code != 200 ||
		!strings.Contains(body, "o_TEST_1") || !strings.Contains(body, "13800001111") {
		t.Fatalf("微信绑定列表失败: %d %s", code, body)
	}
	if code, _ = call(ts, http.MethodPost, "/api/wx/users", "{}"); code != 405 {
		t.Errorf("POST /api/wx/users 应 405，实际 %d", code)
	}

	// ⑤ 缺 code / 坏手机号 / 错方法
	if code, body = call(ts, http.MethodPost, "/api/wx/login", `{}`); code != 400 ||
		!strings.Contains(body, "缺少 code") {
		t.Errorf("缺 code 应 400，实际 %d %s", code, body)
	}
	if code, body = call(ts, http.MethodPost, "/api/wx/login", `{"code":"CODE_4","phone":"12345"}`); code != 400 ||
		!strings.Contains(body, "手机号格式不对") {
		t.Errorf("坏手机号应 400，实际 %d %s", code, body)
	}
	if code, _ = call(ts, http.MethodGet, "/api/wx/login", ""); code != 405 {
		t.Errorf("GET /api/wx/login 应 405，实际 %d", code)
	}

	// ⑥ 微信错误码翻译：40029 → 400，45011 → 429
	if code, body = call(ts, http.MethodPost, "/api/wx/login", `{"code":"BAD"}`); code != 400 ||
		!strings.Contains(body, "无效或已过期") {
		t.Errorf("40029 应 400，实际 %d %s", code, body)
	}
	if code, body = call(ts, http.MethodPost, "/api/wx/login", `{"code":"FLOOD"}`); code != 429 ||
		!strings.Contains(body, "太频繁") {
		t.Errorf("45011 应 429，实际 %d %s", code, body)
	}

	// ⑦ 服务端没配 WX_APPID / WX_SECRET → 503
	bare := newTestServer(t)
	if code, body = call(bare, http.MethodPost, "/api/wx/login", `{"code":"CODE_5"}`); code != 503 ||
		!strings.Contains(body, "未配置") {
		t.Errorf("未配置应 503，实际 %d %s", code, body)
	}

	// ⑩ 头像昵称保存（第 25 轮 / D31）：空值保留原值、未知 openid 404、缺 openid 400、错方法 405
	if code, body = call(ts, http.MethodPost, "/api/wx/profile",
		`{"openid":"o_TEST_1","nickname":"小美","avatar":"https://x/b.png"}`); code != 200 ||
		!strings.Contains(body, `"nickname":"小美"`) || !strings.Contains(body, `"avatar":"https://x/b.png"`) {
		t.Errorf("保存头像昵称失败: %d %s", code, body)
	}
	// 只改昵称：头像必须留着（否则用户每次编辑昵称都会掉头像）
	if code, body = call(ts, http.MethodPost, "/api/wx/profile", `{"openid":"o_TEST_1","nickname":"小美2"}`); code != 200 ||
		!strings.Contains(body, `"avatar":"https://x/b.png"`) {
		t.Errorf("空头像应保留原头像: %d %s", code, body)
	}
	if code, body = call(ts, http.MethodPost, "/api/wx/profile", `{"openid":"o_none"}`); code != 404 {
		t.Errorf("未知 openid 应 404，实际 %d %s", code, body)
	}
	if code, body = call(ts, http.MethodPost, "/api/wx/profile", `{}`); code != 400 ||
		!strings.Contains(body, "缺少 openid") {
		t.Errorf("缺 openid 应 400，实际 %d %s", code, body)
	}
	if code, _ = call(ts, http.MethodGet, "/api/wx/profile", ""); code != 405 {
		t.Errorf("GET /api/wx/profile 应 405，实际 %d", code)
	}

	// ⑧ 假微信服务器确实被调用了（否则上面全是假通过）
	if hits < 5 {
		t.Errorf("假微信服务器调用次数偏少: %d", hits)
	}
	// ⑨ secret 与 session_key 绝不外泄（D13）
	if strings.Contains(seen.String(), secretForTest) || strings.Contains(seen.String(), "sk_must_not_leak") {
		t.Errorf("响应体里出现了 secret / session_key：%s", seen.String())
	}
}

// 第 24 轮（D29）：顾客端商品详情与分类列表。
// 详情接口的钱口径必须与列表完全一致（D24/D12）：带 phone 按等级算有效价，页面只读 price。
func TestProductDetailAndCategoriesHTTPFlow(t *testing.T) {
	ts := newTestServer(t)

	for _, p := range []string{
		`{"code":"7201","name":"整箱可乐","salePrice":60,"wholesalePrice":52,"stock":10,"unit":"箱","category":"饮料","img":"/static/cola.jpg"}`,
		`{"code":"7202","name":"薯片","salePrice":6,"stock":5,"unit":"袋","category":"零食"}`,
	} {
		if code, body := do(t, ts, http.MethodPost, "/api/products", p); code != 200 {
			t.Fatalf("建档失败: %d %s", code, body)
		}
	}

	// ① 详情：不带 phone = 零售价，且必须下发图片字段（小程序要显示商品图）
	code, body := do(t, ts, http.MethodGet, "/api/products/7201", "")
	if code != 200 || !strings.Contains(body, `"tier":"retail"`) || !strings.Contains(body, `"price":60`) ||
		!strings.Contains(body, `"img":"/static/cola.jpg"`) {
		t.Fatalf("详情应回零售价与图片: %d %s", code, body)
	}

	// ② 详情：批发顾客 → 批发价（与列表同一口径）
	if code, body = do(t, ts, http.MethodPost, "/api/customers/tier",
		`{"phone":"13800001111","name":"王老板","tier":"wholesale"}`); code != 200 {
		t.Fatalf("设等级失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/products/7201?phone=13800001111", ""); code != 200 ||
		!strings.Contains(body, `"tier":"wholesale"`) || !strings.Contains(body, `"price":52`) {
		t.Fatalf("批发顾客详情应回批发价: %d %s", code, body)
	}
	// 陌生手机号 → 零售价（查不到人不是错误）
	if code, body = do(t, ts, http.MethodGet, "/api/products/7201?phone=13900000000", ""); code != 200 ||
		!strings.Contains(body, `"price":60`) {
		t.Fatalf("陌生手机号应回零售价: %d %s", code, body)
	}

	// ③ 详情：未知条码 404、方法不支持 405
	if code, _ = do(t, ts, http.MethodGet, "/api/products/9999", ""); code != 404 {
		t.Errorf("未知条码应 404，实际 %d", code)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/products/7201", "{}"); code != 405 {
		t.Errorf("POST 详情应 405，实际 %d", code)
	}

	// ④ 分类列表：默认只算上架商品，且每个分类带件数
	if code, body = do(t, ts, http.MethodGet, "/api/products/categories?onSale=1", ""); code != 200 ||
		!strings.Contains(body, `"name":"饮料"`) || !strings.Contains(body, `"name":"零食"`) ||
		!strings.Contains(body, `"count":1`) {
		t.Fatalf("分类列表应含饮料与零食及件数: %d %s", code, body)
	}
	// 下架一个分类 → 该分类从顾客端列表消失
	if code, body = do(t, ts, http.MethodPost, "/api/products/onsale", `{"codes":["7202"],"onSale":false}`); code != 200 {
		t.Fatalf("下架失败: %d %s", code, body)
	}
	if code, body = do(t, ts, http.MethodGet, "/api/products/categories?onSale=1", ""); code != 200 ||
		strings.Contains(body, `"name":"零食"`) {
		t.Errorf("下架后「零食」不应在列表: %d %s", code, body)
	}
	// 不带 onSale=1 → 全部商品（含下架），给管理端留口子
	if code, body = do(t, ts, http.MethodGet, "/api/products/categories", ""); code != 200 ||
		!strings.Contains(body, `"name":"零食"`) {
		t.Errorf("不带 onSale 应含全部: %d %s", code, body)
	}
	if code, _ = do(t, ts, http.MethodPost, "/api/products/categories", "{}"); code != 405 {
		t.Errorf("POST 分类应 405，实际 %d", code)
	}
}

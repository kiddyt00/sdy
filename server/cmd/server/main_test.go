package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
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

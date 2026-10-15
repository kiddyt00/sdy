// 支付轮（0.9.0）HTTP 契约：测试商品标记 + 0.01 元自提单恰好 1 分。
//
// 这两条是「用 1 分钱真验一笔微信支付」的前提：
//   - POST /api/products 必须能落 isDemo（否则 seed 脚本灌不进「测试商品」标记）；
//   - 0.01 元商品走**自提**时订单总额必须恰好 = 1 分（微信 amount.total 的最小值），
//     走配送则 = 1 分 + 配送费 3 元 = 301 分 —— 这正是「测试单必须选自提」的原因。
package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
)

// TestPaytestProductIsDemoViaHTTP POST /api/products 透出 isDemo，且只认显式 true。
func TestPaytestProductIsDemoViaHTTP(t *testing.T) {
	ts := newTestServer(t)

	// ① 显式 isDemo:true → 落库并回读为 true（管理端据此显示示例商品警示条）。
	code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"9000000000001","name":"【测试】微信支付 1 分钱","salePrice":0.01,"stock":999,"isDemo":true}`)
	if code != 200 {
		t.Fatalf("建档应成功，实际 %d %s", code, body)
	}
	if !strings.Contains(body, `"isDemo":true`) {
		t.Errorf("建档响应应带 isDemo=true，实际 %s", body)
	}
	if !strings.Contains(body, `"salePrice":0.01`) {
		t.Errorf("测试商品售价应为 0.01，实际 %s", body)
	}

	// ② 普通商品不带 isDemo → 必须是 false（绝不误标真货）。
	if code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"9000000000002","name":"真商品","salePrice":2.5,"stock":10}`); code != 200 {
		t.Fatalf("建档应成功，实际 %d %s", code, body)
	}
	if strings.Contains(body, `"isDemo":true`) {
		t.Errorf("缺 isDemo 字段应保持 false（绝不把真商品标成示例），实际 %s", body)
	}
	// 列表里同样如此：只有测试商品那一条 isDemo=true。
	_, body = do(t, ts, http.MethodGet, "/api/products", "")
	var list struct {
		Items []struct {
			Code   string `json:"code"`
			IsDemo bool   `json:"isDemo"`
		} `json:"items"`
	}
	if err := json.Unmarshal([]byte(body), &list); err != nil {
		t.Fatalf("解析商品列表失败: %v (%s)", err, body)
	}
	demoCount := 0
	for _, p := range list.Items {
		if p.IsDemo {
			demoCount++
			if p.Code != "9000000000001" {
				t.Errorf("被标成示例商品的应是测试商品，实际 %s", p.Code)
			}
		}
	}
	if demoCount != 1 {
		t.Errorf("列表里应恰好 1 条 isDemo=true，实际 %d（%s）", demoCount, body)
	}

	// ③ 编辑测试商品的档案（不带 isDemo）→ 标记**不丢**（is_demo 不在覆盖列里，规则 29①）。
	if code, body = do(t, ts, http.MethodPost, "/api/products",
		`{"code":"9000000000001","name":"【测试】微信支付 1 分钱（改名）","salePrice":0.01}`); code != 200 {
		t.Fatalf("改档案应成功，实际 %d %s", code, body)
	}
	if !strings.Contains(body, `"isDemo":true`) {
		t.Errorf("编辑后标记不应丢失，实际 %s", body)
	}
}

// TestPaytestOrderAmountIsOneFen 0.01 元商品：自提单总额 = 1 分，配送单 = 301 分。
//
// 这条锁的是「测试商品必须选自提」这个口径 —— 它同时也是业务事实：
// 配送费默认 3 元、起送价不限，所以 1 分钱商品走配送会变成 3.01 元。
func TestPaytestOrderAmountIsOneFen(t *testing.T) {
	ts := newTestServer(t)
	if code, body := do(t, ts, http.MethodPost, "/api/products",
		`{"code":"9000000000001","name":"【测试】微信支付 1 分钱","salePrice":0.01,"stock":999,"isDemo":true}`); code != 200 {
		t.Fatalf("建测试商品应成功，实际 %d %s", code, body)
	}

	type orderResp struct {
		ID          string  `json:"id"`
		Subtotal    float64 `json:"subtotal"`
		DeliveryFee float64 `json:"deliveryFee"`
		Total       float64 `json:"total"`
	}

	// ① 自提：自提费 0 → 总额恰好 0.01 元 = 1 分。
	code, body := do(t, ts, http.MethodPost, "/api/orders",
		`{"customerName":"支付测试","phone":"13800009999","deliveryType":"pickup","items":[{"code":"9000000000001","qty":1}]}`)
	if code != 201 && code != 200 {
		t.Fatalf("自提单应下单成功，实际 %d %s", code, body)
	}
	var pickup orderResp
	if err := json.Unmarshal([]byte(body), &pickup); err != nil {
		t.Fatalf("解析自提单失败: %v (%s)", err, body)
	}
	if amountFen(pickup.Total) != 1 {
		t.Errorf("自提 0.01 元商品总额应为 1 分，实际 %d 分（subtotal=%v fee=%v total=%v）",
			amountFen(pickup.Total), pickup.Subtotal, pickup.DeliveryFee, pickup.Total)
	}

	// ② 配送：加 3 元配送费 → 301 分（证明「测试单必须选自提」不是空话）。
	code, body = do(t, ts, http.MethodPost, "/api/orders",
		`{"customerName":"支付测试","phone":"13800009999","address":"测试地址 1 号","deliveryType":"delivery","items":[{"code":"9000000000001","qty":1}]}`)
	if code != 201 && code != 200 {
		t.Fatalf("配送单应下单成功，实际 %d %s", code, body)
	}
	var delivery orderResp
	if err := json.Unmarshal([]byte(body), &delivery); err != nil {
		t.Fatalf("解析配送单失败: %v (%s)", err, body)
	}
	if amountFen(delivery.Total) != 301 {
		t.Errorf("配送 0.01 元商品总额应为 301 分（含 3 元配送费），实际 %d 分", amountFen(delivery.Total))
	}
}

package main

// 支付轮微信支付 HTTP 层单测（§1.9）。
//
// 全程不出网：进程内 httptest 假微信支付（/v3/pay/... 、/v3/refund/...），
// 商户私钥与平台证书都是测试现场生成的假文件（写进 t.TempDir()，随用例销毁），
// 回调报文用假平台私钥签名 + 假 APIv3 密钥加密后再发给本机 handler——
// 走的是和线上完全一样的验签 / 解密 / 业务校验路径。

import (
	"context"
	"crypto"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
	"github.com/kiddyt00/sdy/server/internal/wxpay"
)

// payTestKey 只用于测试的假 APIv3 密钥（32 字节）——不是任何真实密钥，永不进生产。
const payTestKey = "0123456789abcdef0123456789abcdef"

const (
	payTestAppID = "wxapp_paytest"
	payTestMchID = "mch_paytest"
)

// ---------- 进程内假微信支付 ----------

type payReqRecord struct {
	Method string
	Path   string
	Raw    string
	Auth   string
}

// payTrade 查单响应（每个订单可单独定制）。
type payTrade struct {
	State string
	Txn   string
	Fen   int64
}

type fakeWXPay struct {
	mu            sync.Mutex
	srv           *httptest.Server
	reqs          []payReqRecord
	apiV3Key      string
	platformPriv  *rsa.PrivateKey
	prepayCount   int
	lastPrepayNo  string
	lastOpenID    string
	lastFen       int64
	trades        map[string]payTrade // 缺省：SUCCESS + WX_TXN_<单号> + 500 分
	queryFail     bool
	prepayFail    bool
	refundFail    bool
	refundStatus  string // 退款创建/查单返回的状态，默认 PROCESSING
	refundID      string
	refundFen     int64
	refundQueries int
	tradeQueries  int
	refundCreates int
}

func (f *fakeWXPay) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	f.reqs = append(f.reqs, payReqRecord{Method: r.Method, Path: r.URL.Path, Raw: string(raw), Auth: r.Header.Get("Authorization")})
	f.mu.Unlock()

	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && path == "/v3/pay/transactions/jsapi":
		var in struct {
			OutTradeNo string `json:"out_trade_no"`
			Amount     struct {
				Total int64 `json:"total"`
			} `json:"amount"`
			Payer struct {
				Openid string `json:"openid"`
			} `json:"payer"`
		}
		_ = json.Unmarshal(raw, &in)
		f.mu.Lock()
		f.prepayCount++
		f.lastPrepayNo, f.lastOpenID, f.lastFen = in.OutTradeNo, in.Payer.Openid, in.Amount.Total
		fail := f.prepayFail
		n := f.prepayCount
		f.mu.Unlock()
		if fail {
			writeJSON(w, 500, map[string]string{"code": "SYSTEM_ERROR", "message": "下单失败"})
			return
		}
		writeJSON(w, 200, map[string]string{"prepay_id": fmt.Sprintf("wx_prepay_%d", n)})

	case r.Method == http.MethodGet && strings.HasPrefix(path, "/v3/pay/transactions/out-trade-no/"):
		no := strings.TrimPrefix(path, "/v3/pay/transactions/out-trade-no/")
		f.mu.Lock()
		tr, hit := f.trades[no]
		fail := f.queryFail
		f.tradeQueries++
		f.mu.Unlock()
		if fail {
			writeJSON(w, 500, map[string]string{"code": "SYSTEM_ERROR", "message": "查单失败"})
			return
		}
		if !hit {
			tr = payTrade{State: "SUCCESS", Txn: "WX_TXN_" + no, Fen: 500}
		}
		writeJSON(w, 200, map[string]any{
			"out_trade_no":   no,
			"trade_state":    tr.State,
			"transaction_id": tr.Txn,
			"success_time":   "2026-11-01T10:00:00+08:00",
			"amount":         map[string]any{"total": tr.Fen, "payer_total": tr.Fen},
		})

	case r.Method == http.MethodPost && path == "/v3/refund/domestic/refunds":
		var in struct {
			OutTradeNo  string `json:"out_trade_no"`
			OutRefundNo string `json:"out_refund_no"`
			Reason      string `json:"reason"`
			Amount      struct {
				Total  int64 `json:"total"`
				Refund int64 `json:"refund"`
			} `json:"amount"`
		}
		_ = json.Unmarshal(raw, &in)
		f.mu.Lock()
		f.refundCreates++
		fail, status, id := f.refundFail, f.refundStatus, f.refundID
		f.mu.Unlock()
		if fail {
			writeJSON(w, 500, map[string]string{"code": "SYSTEM_ERROR", "message": "退款请求失败"})
			return
		}
		writeJSON(w, 200, map[string]any{
			"refund_id":     id,
			"out_refund_no": in.OutRefundNo,
			"status":        status,
			"amount":        map[string]any{"total": in.Amount.Total, "refund": in.Amount.Refund},
		})

	case r.Method == http.MethodGet && strings.HasPrefix(path, "/v3/refund/domestic/refunds/"):
		no := strings.TrimPrefix(path, "/v3/refund/domestic/refunds/")
		f.mu.Lock()
		f.refundQueries++
		status, id, fen := f.refundStatus, f.refundID, f.refundFen
		f.mu.Unlock()
		writeJSON(w, 200, map[string]any{
			"refund_id":     id,
			"out_refund_no": no,
			"status":        status,
			"success_time":  "2026-11-01T11:00:00+08:00",
			"amount":        map[string]any{"refund": fen},
		})

	default:
		writeJSON(w, 404, map[string]string{"code": "NOT_FOUND", "message": "假微信支付没有这个接口：" + r.Method + " " + path})
	}
}

func (f *fakeWXPay) counts() (prepay, refundCreate, refundQuery int) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.prepayCount, f.refundCreates, f.refundQueries
}

// queryCount 主动查单次数（/v3/pay/transactions/out-trade-no/...）。
func (f *fakeWXPay) queryCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.tradeQueries
}

func (f *fakeWXPay) lastRefundReq() (payReqRecord, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	for i := len(f.reqs) - 1; i >= 0; i-- {
		if f.reqs[i].Method == http.MethodPost && f.reqs[i].Path == "/v3/refund/domestic/refunds" {
			return f.reqs[i], true
		}
	}
	return payReqRecord{}, false
}

// ---------- 测试环境 ----------

type payEnv struct {
	ts         *httptest.Server
	st         *store.Store
	fake       *fakeWXPay
	pay        *payRT
	phoneA     string
	phoneB     string
	openidA    string
	openidB    string
	staffToken string
}

// newPayEnv 起一个「支付已配置」的测试服务：假微信支付 + 现场生成的私钥/证书。
func newPayEnv(t *testing.T) *payEnv {
	t.Helper()
	dir := t.TempDir()
	merchantPriv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成商户密钥失败：%v", err)
	}
	platformPriv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成平台密钥失败：%v", err)
	}
	privDER, err := x509.MarshalPKCS8PrivateKey(merchantPriv)
	if err != nil {
		t.Fatalf("序列化商户私钥失败：%v", err)
	}
	privPath := filepath.Join(dir, "apiclient_key.pem")
	if err := os.WriteFile(privPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: privDER}), 0o600); err != nil {
		t.Fatalf("写测试私钥失败：%v", err)
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(20261101),
		Subject:      pkix.Name{CommonName: "fake wechatpay platform"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &platformPriv.PublicKey, platformPriv)
	if err != nil {
		t.Fatalf("自签测试平台证书失败：%v", err)
	}
	certPath := filepath.Join(dir, "platform_cert.pem")
	if err := os.WriteFile(certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}), 0o600); err != nil {
		t.Fatalf("写测试平台证书失败：%v", err)
	}

	fake := &fakeWXPay{
		apiV3Key:     payTestKey,
		platformPriv: platformPriv,
		trades:       map[string]payTrade{},
		refundStatus: "PROCESSING",
		refundID:     "wx_refund_1",
		refundFen:    500,
	}
	fake.srv = httptest.NewServer(fake)
	t.Cleanup(fake.srv.Close)

	pay, err := newPayRT(wxpay.Config{
		AppID:            payTestAppID,
		MchID:            payTestMchID,
		SerialNo:         "SERIAL_PAYTEST",
		APIv3Key:         payTestKey,
		PrivateKeyPath:   privPath,
		PlatformCertPath: certPath,
		APIBase:          fake.srv.URL,
		NotifyURL:        "https://mall.shadouyou.cloud/api/pay/notify",
		Client:           &http.Client{Timeout: 3 * time.Second},
	})
	if err != nil {
		t.Fatalf("构造支付运行时失败（测试私钥/证书应能加载）：%v", err)
	}

	// 关掉未配 ADMIN_PASSWORD 时的灰度放行：否则「无身份」请求会被 identityOf 当成管理员，
	// 测不出 prepay 的 400 缺少身份。
	t.Setenv("ADMIN_PASSWORD", "paytest-admin-pass")
	ts, st := newTestServerPay(t, wxConf{}, pay)
	e := &payEnv{ts: ts, st: st, fake: fake, pay: pay, phoneA: "13800001111", phoneB: "13800002222",
		openidA: "o_A", openidB: "o_B"}
	e.seed(t)
	return e
}

// newPayEnvNoPay 支付未配置（pay=nil）的服务——验证 §1.2「服务照起、prepay 回 503」。
func newPayEnvNoPay(t *testing.T) (*payEnv, *store.Store) {
	t.Helper()
	t.Setenv("ADMIN_PASSWORD", "paytest-admin-pass")
	ts, st := newTestServerPay(t, wxConf{}, nil)
	e := &payEnv{ts: ts, st: st, phoneA: "13800001111", phoneB: "13800002222", openidA: "o_A", openidB: "o_B"}
	e.seed(t)
	return e, st
}

func (e *payEnv) seed(t *testing.T) {
	t.Helper()
	for _, p := range []store.Product{
		{Code: "6901", Name: "可乐", SalePrice: 2.5, Stock: 120},
		{Code: "6902", Name: "农夫", SalePrice: 1.8, Stock: 3},
	} {
		if _, err := e.st.UpsertProduct(p); err != nil {
			t.Fatalf("写入商品失败：%v", err)
		}
	}
	if _, err := e.st.BindWxUser(e.openidA, "", e.phoneA, "张三", ""); err != nil {
		t.Fatalf("绑定微信用户 A 失败：%v", err)
	}
	if _, err := e.st.BindWxUser(e.openidB, "", e.phoneB, "李四", ""); err != nil {
		t.Fatalf("绑定微信用户 B 失败：%v", err)
	}
	if _, err := e.st.BindWxUser("o_STAFF", "", "", "小美", ""); err != nil {
		t.Fatalf("绑定员工微信失败：%v", err)
	}
	if _, err := e.st.SetWxUserRole("o_STAFF", store.RoleStaff); err != nil {
		t.Fatalf("设员工角色失败：%v", err)
	}
	tok, err := e.st.RotateStaffToken("o_STAFF")
	if err != nil {
		t.Fatalf("发员工令牌失败：%v", err)
	}
	e.staffToken = tok
}

// payOrder 造一张单（默认 6901 × 2 = 5.00 元 → 500 分，正好对上假微信的默认金额）。
func (e *payEnv) payOrder(t *testing.T, phone, openid string) store.Order {
	t.Helper()
	o, err := e.st.CreateOrder(store.NewOrderInput{
		CustomerName: "张三", Phone: phone, DeliveryType: "pickup", OpenID: openid,
		PayWindow: true, // 支付已配置：开未付倒计时（假微信支付是就绪的）
		Items:     []store.NewOrderInputItem{{Code: "6901", Qty: 2}},
	})
	if err != nil {
		t.Fatalf("造单失败：%v", err)
	}
	return o
}

// signedPayNotify 构造一条真实形状的回调（假平台私钥签名 + 假 APIv3 密钥 AES-GCM 加密）。
func (e *payEnv) signedPayNotify(t *testing.T, eventType string, plain map[string]any) (http.Header, []byte) {
	t.Helper()
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("序列化回调明文失败：%v", err)
	}
	const nonce = "abcdefghijkl"
	aad := "transaction"
	if strings.HasPrefix(eventType, "REFUND") {
		aad = "refund"
	}
	block, err := aes.NewCipher([]byte(e.fake.apiV3Key))
	if err != nil {
		t.Fatalf("建 AES 失败：%v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("建 GCM 失败：%v", err)
	}
	sealed := gcm.Seal(nil, []byte(nonce), plainBytes, []byte(aad))
	body, err := json.Marshal(map[string]any{
		"id":            "EV-PAYTEST-0001",
		"create_time":   "2026-11-01T10:00:00+08:00",
		"resource_type": "encrypt-resource",
		"event_type":    eventType,
		"summary":       "支付成功",
		"resource": map[string]string{
			"algorithm":       "AEAD_AES_256_GCM",
			"ciphertext":      base64.StdEncoding.EncodeToString(sealed),
			"nonce":           nonce,
			"associated_data": aad,
			"original_type":   "transaction",
		},
	})
	if err != nil {
		t.Fatalf("序列化回调报文失败：%v", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	headerNonce := "1234567890abcdef"
	msg := ts + "\n" + headerNonce + "\n" + string(body) + "\n"
	sum := sha256.Sum256([]byte(msg))
	sig, err := rsa.SignPKCS1v15(rand.Reader, e.fake.platformPriv, crypto.SHA256, sum[:])
	if err != nil {
		t.Fatalf("回调签名失败：%v", err)
	}
	h := http.Header{}
	h.Set("Wechatpay-Timestamp", ts)
	h.Set("Wechatpay-Nonce", headerNonce)
	h.Set("Wechatpay-Signature", base64.StdEncoding.EncodeToString(sig))
	h.Set("Wechatpay-Serial", "FAKE-PLATFORM-SERIAL-01")
	h.Set("Content-Type", "application/json")
	return h, body
}

// postNotify 把签名好的回调直接发给 handler（带 Wechatpay-* 头）。
func (e *payEnv) postNotify(t *testing.T, path string, hdr http.Header, body []byte) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, e.ts.URL+path, strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("构造回调请求失败：%v", err)
	}
	req.Header = hdr
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("发回调失败：%v", err)
	}
	defer res.Body.Close()
	raw, _ := io.ReadAll(res.Body)
	return res.StatusCode, string(raw)
}

// ---------- prepay ----------

// TestPayPrepayNotConfigured 支付没配好：prepay 回 503 固定文案，其它功能照旧。
func TestPayPrepayNotConfigured(t *testing.T) {
	e, st := newPayEnvNoPay(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay",
		`{"orderId":"`+o.ID+`"}`, map[string]string{"X-Wx-Openid": e.openidA})
	if code != 503 || !strings.Contains(body, payNotConfiguredMsg) {
		t.Fatalf("支付未配置应回 503 与固定文案，实际 %d %s", code, body)
	}
	for _, leak := range []string{"PRIVATE KEY", "BEGIN", "paySign", "MII"} {
		if strings.Contains(body, leak) {
			t.Errorf("未配置响应里不该出现 %q：%s", leak, body)
		}
	}
	// 其余功能照旧：订单列表仍 200。
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/orders?phone="+e.phoneA, "", nil); code != 200 {
		t.Fatalf("支付未配置不该影响其它接口，实际 %d %s", code, body)
	}
	if code, _ := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/notify", "{}", nil); code != 503 {
		t.Errorf("未配置时回调也应 503（微信会重推），实际 %d", code)
	}
	_ = st
}

// TestPayPrepayIdentityAndOwnership 身份四态 + 归属 + 跨端补 openid 三分支（§1.5）。
func TestPayPrepayIdentityAndOwnership(t *testing.T) {
	e := newPayEnv(t)
	webA := e.payOrder(t, e.phoneA, "") // 网页下单：没绑微信
	webB := e.payOrder(t, e.phoneB, "") // 别人的网页单
	wxA := e.payOrder(t, e.phoneA, e.openidA)
	wxB := e.payOrder(t, e.phoneB, e.openidB)
	// 手机号是 A 的，但微信标识被绑成了 B 的（数据异常/换号）——归属校验按手机号通过，
	// 到 resolvePayer 才被 openid 不一致拦下，这才是 403「这个订单不是你的」的场景。
	oddA := e.payOrder(t, e.phoneA, e.openidB)

	cases := []struct {
		name string
		body string
		hdr  map[string]string
		want int
		msg  string
	}{
		{"无身份", `{"orderId":"` + wxA.ID + `"}`, nil, 400, "缺少身份"},
		{"缺 orderId", `{}`, map[string]string{"X-Wx-Openid": e.openidA}, 400, "缺少订单号"},
		{"订单不存在", `{"orderId":"M_NOPE"}`, map[string]string{"X-Wx-Openid": e.openidA}, 404, ""},
		// 不是自己的单（手机号不同）→ 404「订单不存在」，与 GET /api/orders/{id}、取消订单同一口径，
		// 不向外泄露「这单存在但不是你的」。契约 §1.5 的字面写的是 403，实现取 404（见交付报告差异说明）。
		{"别人的单（手机号不同）", `{"orderId":"` + wxB.ID + `"}`, map[string]string{"X-Wx-Openid": e.openidA}, 404, "订单不存在"},
		{"别人的网页单", `{"orderId":"` + webB.ID + `"}`, map[string]string{"X-Wx-Openid": e.openidA}, 404, "订单不存在"},
		// 自己的手机号、却绑了别人微信 → 403 明确拒绝（契约里那句 403 文案在这里生效）。
		{"自己的单绑了别人微信", `{"orderId":"` + oddA.ID + `"}`, map[string]string{"X-Wx-Openid": e.openidA}, 403, "这个订单不是你的，无法支付"},
		{"纯网页身份", `{"orderId":"` + webA.ID + `"}`, map[string]string{"X-Phone": e.phoneA}, 400, "请在微信小程序里登录后再支付"},
		{"跨端补 openid 手机号一致", `{"orderId":"` + webA.ID + `"}`, map[string]string{"X-Wx-Openid": e.openidA}, 200, ""},
	}
	for _, c := range cases {
		code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", c.body, c.hdr)
		if code != c.want {
			t.Errorf("%s：期望 %d 实际 %d（%s）", c.name, c.want, code, body)
			continue
		}
		if c.msg != "" && !strings.Contains(body, c.msg) {
			t.Errorf("%s：期望文案含 %q，实际 %s", c.name, c.msg, body)
		}
	}
	// 补写确实落库了（下一次同一个人再付不会被当成别人的单）。
	got, err := e.st.GetOrder(webA.ID)
	if err != nil {
		t.Fatalf("读订单失败：%v", err)
	}
	if got.OpenID != e.openidA {
		t.Errorf("跨端补 openid 应把订单 openid 写成 %s，实际 %q", e.openidA, got.OpenID)
	}
	// 员工令牌放行代客收款（订单绑了微信）。
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay",
		`{"orderId":"`+wxA.ID+`"}`, map[string]string{"X-Staff-Token": e.staffToken}); code != 200 {
		t.Errorf("员工应能代客发起支付，实际 %d %s", code, body)
	}
	// 员工碰没绑微信的单：明确提示，而不是拿空 openid 去调微信。
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay",
		`{"orderId":"`+webB.ID+`"}`, map[string]string{"X-Staff-Token": e.staffToken}); code != 400 || !strings.Contains(body, "还没有绑定微信") {
		t.Errorf("员工付未绑微信的单应 400 提示，实际 %d %s", code, body)
	}
}

// TestPayPrepayParamsAndReuse 返回结构 + 同单 prepay_id 复用 + 几个拒绝分支。
func TestPayPrepayParamsAndReuse(t *testing.T) {
	e := newPayEnv(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	hdr := map[string]string{"X-Wx-Openid": e.openidA}
	body := `{"orderId":"` + o.ID + `"}`

	code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", body, hdr)
	if code != 200 {
		t.Fatalf("prepay 应成功，实际 %d %s", code, raw)
	}
	var out struct {
		OutTradeNo string            `json:"outTradeNo"`
		AmountFen  int64             `json:"amountFen"`
		PayParams  map[string]string `json:"payParams"`
		ExpireAt   int64             `json:"expireAt"`
	}
	if err := json.Unmarshal([]byte(raw), &out); err != nil {
		t.Fatalf("解析 prepay 响应失败：%v（%s）", err, raw)
	}
	if out.OutTradeNo != o.ID {
		t.Errorf("outTradeNo 应是订单号本身，实际 %q", out.OutTradeNo)
	}
	// 金额一律整数分：2.5 元 × 2 = 500 分，绝不出现浮点比较。
	if out.AmountFen != 500 {
		t.Errorf("amountFen 应为 500，实际 %d", out.AmountFen)
	}
	if out.PayParams["package"] != "prepay_id=wx_prepay_1" || out.PayParams["signType"] != "RSA" {
		t.Errorf("payParams 不对：%+v", out.PayParams)
	}
	if out.PayParams["paySign"] == "" || out.PayParams["nonceStr"] == "" || out.PayParams["timeStamp"] == "" {
		t.Errorf("payParams 缺字段：%+v", out.PayParams)
	}
	now := time.Now().Unix()
	if out.ExpireAt < now+800 || out.ExpireAt > now+910 {
		t.Errorf("expireAt 应约等于 now+900，实际 %d（now=%d）", out.ExpireAt, now)
	}
	// 假微信确实收到的是订单号 + 顾客 openid + 整数分。
	if e.fake.lastPrepayNo != o.ID || e.fake.lastOpenID != e.openidA || e.fake.lastFen != 500 {
		t.Errorf("下单请求体不对：no=%q openid=%q fen=%d", e.fake.lastPrepayNo, e.fake.lastOpenID, e.fake.lastFen)
	}
	if !strings.HasPrefix(e.fake.reqs[0].Auth, "WECHATPAY2-SHA256-RSA2048 ") {
		t.Errorf("调微信必须带签名头，实际 %q", e.fake.reqs[0].Auth)
	}

	// 同一单再点一次「去支付」：复用 prepay_id，不重复下单、不重置倒计时。
	code, raw2 := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", body, hdr)
	if code != 200 {
		t.Fatalf("第二次 prepay 应成功，实际 %d %s", code, raw2)
	}
	var out2 struct {
		PayParams map[string]string `json:"payParams"`
		ExpireAt  int64             `json:"expireAt"`
	}
	_ = json.Unmarshal([]byte(raw2), &out2)
	if out2.PayParams["package"] != "prepay_id=wx_prepay_1" || out2.ExpireAt != out.ExpireAt {
		t.Errorf("同单未过期应复用 prepay_id 与截止时刻：%+v（原 %+v）", out2, out)
	}
	if prepay, _, _ := e.fake.counts(); prepay != 1 {
		t.Errorf("重复发起不该重复调微信下单，实际 %d 次", prepay)
	}

	// 已收款 → 400。
	if err := e.st.MarkPaid(o.ID, "WX_TXN_PAID", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", body, hdr); code != 400 || !strings.Contains(body, "订单已收款") {
		t.Errorf("已收款单应 400，实际 %d %s", code, body)
	}

	// 非 pending → 400。
	o2 := e.payOrder(t, e.phoneA, e.openidA)
	if _, err := e.st.AdvanceOrder(o2.ID, pricing.StatusDelivering); err != nil {
		t.Fatalf("推进订单失败：%v", err)
	}
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", `{"orderId":"`+o2.ID+`"}`, hdr); code != 400 || !strings.Contains(body, "不能支付") {
		t.Errorf("非待付款单应 400，实际 %d %s", code, body)
	}

	// 已超时 → 400（服务端按 pay_expire_at 判定，不信前端）。
	o3 := e.payOrder(t, e.phoneA, e.openidA)
	if _, err := e.st.DB().Exec(`UPDATE orders SET pay_expire_at=? WHERE id=?`, time.Now().Unix()-1, o3.ID); err != nil {
		t.Fatalf("改到期时间失败：%v", err)
	}
	if code, body := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/pay/prepay", `{"orderId":"`+o3.ID+`"}`, hdr); code != 400 || !strings.Contains(body, "超时未付") {
		t.Errorf("超时单应 400，实际 %d %s", code, body)
	}
}

// ---------- notify ----------

func paySuccessPlain(outTradeNo, txn string, fen int64) map[string]any {
	return map[string]any{
		"mchid":          payTestMchID,
		"appid":          payTestAppID,
		"out_trade_no":   outTradeNo,
		"transaction_id": txn,
		"trade_state":    "SUCCESS",
		"success_time":   "2026-11-01T10:00:00+08:00",
		"amount":         map[string]any{"total": fen, "payer_total": fen, "currency": "CNY"},
	}
}

// TestPayNotifyPaidAndIdempotent 正常回调置已收款；重复回调不改数据。
func TestPayNotifyPaidAndIdempotent(t *testing.T) {
	e := newPayEnv(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	hdr, body := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain(o.ID, "WX_TXN_OK", 500))

	code, raw := e.postNotify(t, "/api/pay/notify", hdr, body)
	if code != 200 || !strings.Contains(raw, `"code":"SUCCESS"`) {
		t.Fatalf("正常回调应 200 SUCCESS，实际 %d %s", code, raw)
	}
	got, err := e.st.GetOrder(o.ID)
	if err != nil {
		t.Fatalf("读订单失败：%v", err)
	}
	if !got.Paid || got.TransactionID != "WX_TXN_OK" || got.PaidAt != "2026-11-01T10:00:00+08:00" {
		t.Fatalf("回调应把订单置为已收款：%+v", got)
	}

	// 微信重推（同 transaction_id，success_time 不同）：200 SUCCESS 且一个字段都不改。
	hdr2, body2 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain(o.ID, "WX_TXN_OK", 500))
	code, raw = e.postNotify(t, "/api/pay/notify", hdr2, body2)
	if code != 200 || !strings.Contains(raw, `"code":"SUCCESS"`) {
		t.Fatalf("重复回调应 200 SUCCESS，实际 %d %s", code, raw)
	}
	again, _ := e.st.GetOrder(o.ID)
	if again.PaidAt != got.PaidAt || again.TransactionID != got.TransactionID {
		t.Errorf("重复回调不该改数据：%+v", again)
	}
}

// TestPayNotifyRejects 金额不符 / 签名错 / 商户号错 / 单不存在 / 状态异常：都不许改数据。
func TestPayNotifyRejects(t *testing.T) {
	e := newPayEnv(t)

	// ① 金额不符 → 4xx 且订单一个字段都不改。
	o1 := e.payOrder(t, e.phoneA, e.openidA)
	hdr, body := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain(o1.ID, "WX_TXN_BAD", 600))
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr, body); code < 400 || code >= 500 {
		t.Errorf("金额不符应回 4xx（让微信重试），实际 %d %s", code, raw)
	}
	after, _ := e.st.GetOrder(o1.ID)
	if after.Paid || after.TransactionID != "" || after.PaidAt != "" || after.RefundState != "" {
		t.Errorf("金额不符时订单一个字段都不该改：%+v", after)
	}

	// ② 签名错 → 401，且不改数据。
	o2 := e.payOrder(t, e.phoneA, e.openidA)
	hdr2, body2 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain(o2.ID, "WX_TXN_SIG", 500))
	hdr2.Set("Wechatpay-Signature", base64.StdEncoding.EncodeToString([]byte("not a real signature")))
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr2, body2); code != 401 {
		t.Errorf("签名错应 401，实际 %d %s", code, raw)
	}
	if st, _ := e.st.GetOrder(o2.ID); st.Paid {
		t.Errorf("签名错的回调绝不能改数据：%+v", st)
	}

	// ③ 商户号不一致 → 4xx。
	o3 := e.payOrder(t, e.phoneA, e.openidA)
	plain := paySuccessPlain(o3.ID, "WX_TXN_MCH", 500)
	plain["mchid"] = "mch_someone_else"
	hdr3, body3 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", plain)
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr3, body3); code < 400 || code >= 500 {
		t.Errorf("商户号不一致应回 4xx，实际 %d %s", code, raw)
	}

	// ④ AppID 不一致 → 4xx。
	o4 := e.payOrder(t, e.phoneA, e.openidA)
	plain = paySuccessPlain(o4.ID, "WX_TXN_APP", 500)
	plain["appid"] = "wxapp_someone_else"
	hdr4, body4 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", plain)
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr4, body4); code < 400 || code >= 500 {
		t.Errorf("AppID 不一致应回 4xx，实际 %d %s", code, raw)
	}

	// ⑤ 订单不存在 → 404（同样不能 5xx）。
	hdr5, body5 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain("M_NOT_EXIST", "WX_TXN_X", 500))
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr5, body5); code != 404 {
		t.Errorf("订单不存在应 404，实际 %d %s", code, raw)
	}

	// ⑥ trade_state 不是 SUCCESS → 4xx。
	o6 := e.payOrder(t, e.phoneA, e.openidA)
	plain = paySuccessPlain(o6.ID, "WX_TXN_NS", 500)
	plain["trade_state"] = "NOTPAY"
	hdr6, body6 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", plain)
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr6, body6); code < 400 || code >= 500 {
		t.Errorf("trade_state 非 SUCCESS 应回 4xx，实际 %d %s", code, raw)
	}

	// ⑦ 非支付事件（退款事件发到支付回调）→ 200 SUCCESS 但不碰订单。
	o7 := e.payOrder(t, e.phoneA, e.openidA)
	hdr7, body7 := e.signedPayNotify(t, "REFUND.SUCCESS", map[string]any{
		"mchid": payTestMchID, "out_refund_no": "R" + o7.ID, "refund_id": "RF_X",
		"refund_status": "SUCCESS", "amount": map[string]any{"refund": 500},
	})
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr7, body7); code != 200 || !strings.Contains(raw, "SUCCESS") {
		t.Errorf("非支付事件应 200 SUCCESS 让微信别重推，实际 %d %s", code, raw)
	}
	if st, _ := e.st.GetOrder(o7.ID); st.Paid {
		t.Errorf("退款事件不该把订单置为已收款：%+v", st)
	}

	// ⑧ 同一 transaction_id 被别的订单占用（数据异常）→ 4xx/200 都可接受，但绝不能 500、绝不能 panic，
	// 且原订单数据不被破坏。
	o8 := e.payOrder(t, e.phoneA, e.openidA)
	o9 := e.payOrder(t, e.phoneB, e.openidB)
	if err := e.st.MarkPaid(o9.ID, "WX_TXN_DUP", ""); err != nil {
		t.Fatalf("预置支付单号失败：%v", err)
	}
	hdr8, body8 := e.signedPayNotify(t, "TRANSACTION.SUCCESS", paySuccessPlain(o8.ID, "WX_TXN_DUP", 500))
	if code, raw := e.postNotify(t, "/api/pay/notify", hdr8, body8); code >= 500 {
		t.Errorf("支付单号冲突不该回 5xx（微信会一直重推），实际 %d %s", code, raw)
	}
	if st, _ := e.st.GetOrder(o8.ID); st.Paid {
		t.Errorf("冲突时不该把冲突单号写到另一张单上：%+v", st)
	}
}

// TestPayRefundNotify 退款回调：R+订单号与裸订单号两种都认、幂等、未知单号 404。
func TestPayRefundNotify(t *testing.T) {
	e := newPayEnv(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o.ID, "WX_TXN_R", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	refundPlain := func(no, status string) map[string]any {
		return map[string]any{
			"mchid": payTestMchID, "out_refund_no": no, "refund_id": "wx_refund_1",
			"refund_status": status, "success_time": "2026-11-01T11:00:00+08:00",
			"amount": map[string]any{"refund": 500},
		}
	}

	hdr, body := e.signedPayNotify(t, "REFUND.SUCCESS", refundPlain("R"+o.ID, "SUCCESS"))
	if code, raw := e.postNotify(t, "/api/pay/refund-notify", hdr, body); code != 200 || !strings.Contains(raw, `"code":"SUCCESS"`) {
		t.Fatalf("退款回调应 200 SUCCESS，实际 %d %s", code, raw)
	}
	got, _ := e.st.GetOrder(o.ID)
	if got.RefundState != store.RefundStateSuccess || got.RefundID != "wx_refund_1" {
		t.Fatalf("退款状态没落库：%+v", got)
	}
	// 重复退款回调：幂等。
	hdr2, body2 := e.signedPayNotify(t, "REFUND.SUCCESS", refundPlain("R"+o.ID, "SUCCESS"))
	if code, _ := e.postNotify(t, "/api/pay/refund-notify", hdr2, body2); code != 200 {
		t.Errorf("重复退款回调应 200，实际 %d", code)
	}

	// 裸订单号（人工退款/老数据）也认。
	o2 := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o2.ID, "WX_TXN_R2", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	hdr3, body3 := e.signedPayNotify(t, "REFUND.ABNORMAL", refundPlain(o2.ID, "ABNORMAL"))
	if code, raw := e.postNotify(t, "/api/pay/refund-notify", hdr3, body3); code != 200 {
		t.Fatalf("裸订单号的退款回调应 200，实际 %d %s", code, raw)
	}
	if st, _ := e.st.GetOrder(o2.ID); st.RefundState != store.RefundStateFail {
		t.Errorf("ABNORMAL 应落成 fail：%+v", st)
	}

	// 未知退款单号 → 404（不能 5xx）。
	hdr4, body4 := e.signedPayNotify(t, "REFUND.SUCCESS", refundPlain("R_M_NOT_EXIST", "SUCCESS"))
	if code, raw := e.postNotify(t, "/api/pay/refund-notify", hdr4, body4); code != 404 {
		t.Errorf("未知退款单号应 404，实际 %d %s", code, raw)
	}
}

// ---------- pay/status ----------

// TestPayStatusQueryFallback 本地未付 → 主动查单兜底；30 秒内不重复查；查单失败不 500。
func TestPayStatusQueryFallback(t *testing.T) {
	e := newPayEnv(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	hdr := map[string]string{"X-Wx-Openid": e.openidA}

	code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o.ID, "", hdr)
	if code != 200 {
		t.Fatalf("查支付状态应 200，实际 %d %s", code, raw)
	}
	var st struct {
		Paid          bool   `json:"paid"`
		Status        string `json:"status"`
		TransactionID string `json:"transactionId"`
		RefundState   string `json:"refundState"`
		ExpireAt      int64  `json:"expireAt"`
	}
	if err := json.Unmarshal([]byte(raw), &st); err != nil {
		t.Fatalf("解析状态失败：%v（%s）", err, raw)
	}
	if !st.Paid || st.TransactionID != "WX_TXN_"+o.ID {
		t.Fatalf("应通过主动查单兜底置为已收款：%s", raw)
	}
	if st.Status != pricing.StatusPending || st.ExpireAt <= 0 {
		t.Errorf("状态字段不对：%s", raw)
	}
	if q := e.fake.queryCount(); q != 1 {
		t.Errorf("第一次应查单 1 次，实际 %d", q)
	}
	// 30 秒节流：紧接着再查一次，不再打微信（本地已付也不会再查）。
	if code, _ := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o.ID, "", hdr); code != 200 {
		t.Errorf("第二次查状态应 200，实际 %d", code)
	}
	if q := e.fake.queryCount(); q != 1 {
		t.Errorf("30 秒内不该重复查单，实际 %d 次", q)
	}

	// 查单失败 → 如实返回本地状态（200），绝不 500。
	o2 := e.payOrder(t, e.phoneA, e.openidA)
	e.fake.mu.Lock()
	e.fake.queryFail = true
	e.fake.mu.Unlock()
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o2.ID, "", hdr)
	if code != 200 || !strings.Contains(raw, `"paid":false`) {
		t.Errorf("查单失败应诚实返回本地未付（200），实际 %d %s", code, raw)
	}

	// 查单金额不符 → 不置已收款。
	o3 := e.payOrder(t, e.phoneA, e.openidA)
	e.fake.mu.Lock()
	e.fake.queryFail = false
	e.fake.trades[o3.ID] = payTrade{State: "SUCCESS", Txn: "WX_TXN_WRONG", Fen: 999}
	e.fake.mu.Unlock()
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o3.ID, "", hdr)
	if code != 200 || !strings.Contains(raw, `"paid":false`) {
		t.Errorf("查单金额不符不该置已收款，实际 %d %s", code, raw)
	}

	// 退款中 → 顺带查退款兜底。
	o4 := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o4.ID, "WX_TXN_R4", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	if err := e.st.MarkRefund(o4.ID, "wx_refund_1", store.RefundStateProcessing); err != nil {
		t.Fatalf("写退款中失败：%v", err)
	}
	e.fake.mu.Lock()
	e.fake.refundStatus = "SUCCESS"
	e.fake.mu.Unlock()
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o4.ID, "", hdr)
	if code != 200 || !strings.Contains(raw, `"refundState":"success"`) {
		t.Errorf("退款中应查退款兜底成 success，实际 %d %s", code, raw)
	}

	// 归属：别人的单 404；缺 orderId 400。
	if code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o2.ID, "", map[string]string{"X-Wx-Openid": e.openidB}); code != 404 {
		t.Errorf("别人的单应 404，实际 %d %s", code, raw)
	}
	if code, _ := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status", "", hdr); code != 400 {
		t.Errorf("缺 orderId 应 400，实际 %d", code)
	}
	if code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/pay/status?orderId="+o2.ID, "", nil); code != 400 || !strings.Contains(raw, "缺少身份") {
		t.Errorf("无身份的查状态应 400 缺少身份，实际 %d %s", code, raw)
	}
}

// ---------- mark-paid ----------

// TestPayMarkPaidHTTP 后台/员工手工标记已收款：adminGate 生效、幂等、不写 stock_log。
func TestPayMarkPaidHTTP(t *testing.T) {
	e := newPayEnv(t)
	o := e.payOrder(t, e.phoneA, e.openidA)
	var logsBefore int
	if err := e.st.DB().QueryRow(`SELECT COUNT(*) FROM stock_log WHERE order_id=?`, o.ID).Scan(&logsBefore); err != nil {
		t.Fatalf("统计流水失败：%v", err)
	}
	staff := map[string]string{"X-Staff-Token": e.staffToken}

	code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o.ID+"/mark-paid", `{"note":"现金"}`, staff)
	if code != 200 {
		t.Fatalf("员工标记已收款应 200，实际 %d %s", code, raw)
	}
	got, _ := e.st.GetOrder(o.ID)
	if !got.Paid || got.PaidAt == "" {
		t.Fatalf("标记后应 paid=1 且有 paid_at：%+v", got)
	}
	if got.TransactionID != "" {
		t.Errorf("现金标记不该占微信支付单号，实际 %q", got.TransactionID)
	}
	var logsAfter int
	if err := e.st.DB().QueryRow(`SELECT COUNT(*) FROM stock_log WHERE order_id=?`, o.ID).Scan(&logsAfter); err != nil {
		t.Fatalf("统计流水失败：%v", err)
	}
	if logsAfter != logsBefore {
		t.Errorf("mark-paid 不该写 stock_log（%d→%d）", logsBefore, logsAfter)
	}
	// 幂等：再点一次 200 且 paid_at 不变。
	code, _ = r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o.ID+"/mark-paid", "", staff)
	if code != 200 {
		t.Errorf("重复标记应 200，实际 %d", code)
	}
	if again, _ := e.st.GetOrder(o.ID); again.PaidAt != got.PaidAt {
		t.Errorf("重复标记不该改 paid_at：%+v", again)
	}
	// 顾客身份不行。
	if code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o.ID+"/mark-paid", "",
		map[string]string{"X-Wx-Openid": e.openidA}); code != 403 || !strings.Contains(raw, "只有店主") {
		t.Errorf("顾客标记应 403，实际 %d %s", code, raw)
	}
	// 方法不对 405。
	if code, _ := r27Req(t, http.DefaultClient, e.ts, http.MethodGet, "/api/orders/"+o.ID+"/mark-paid", "", staff); code != 405 {
		t.Errorf("GET mark-paid 应 405，实际 %d", code)
	}
}

// ---------- 取消已收款单 → 退款 ----------

// TestPayCancelPaidOrderRefunds 已付款单取消要发起退款；退款失败不能影响取消（§1.7）。
func TestPayCancelPaidOrderRefunds(t *testing.T) {
	e := newPayEnv(t)
	hdrA := map[string]string{"X-Wx-Openid": e.openidA}

	// ① 已付款单取消 → 退款请求带 R+订单号、整数分、原因；订单 refund_state=processing。
	o := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o.ID, "WX_TXN_C1", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	code, raw := r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o.ID+"/cancel", "", hdrA)
	if code != 200 {
		t.Fatalf("取消应 200，实际 %d %s", code, raw)
	}
	var resp struct {
		Status      string `json:"status"`
		RefundState string `json:"refundState"`
		RefundID    string `json:"refundId"`
		RefundError string `json:"refundError"`
	}
	if err := json.Unmarshal([]byte(raw), &resp); err != nil {
		t.Fatalf("解析取消响应失败：%v（%s）", err, raw)
	}
	if resp.Status != pricing.StatusCancelled || resp.RefundState != store.RefundStateProcessing || resp.RefundID != "wx_refund_1" {
		t.Fatalf("已付款单取消后应 cancelled + refundState=processing：%s", raw)
	}
	if resp.RefundError != "" {
		t.Errorf("退款发起成功时不该有 refundError：%s", raw)
	}
	req, ok := e.fake.lastRefundReq()
	if !ok {
		t.Fatalf("没有发出退款请求")
	}
	var refundIn struct {
		OutTradeNo  string `json:"out_trade_no"`
		OutRefundNo string `json:"out_refund_no"`
		Reason      string `json:"reason"`
		Amount      struct {
			Total  int64 `json:"total"`
			Refund int64 `json:"refund"`
		} `json:"amount"`
	}
	if err := json.Unmarshal([]byte(req.Raw), &refundIn); err != nil {
		t.Fatalf("解析退款请求失败：%v（%s）", err, req.Raw)
	}
	if refundIn.OutRefundNo != "R"+o.ID || refundIn.OutTradeNo != o.ID {
		t.Errorf("退款单号应为 R+订单号：%+v", refundIn)
	}
	if refundIn.Amount.Total != 500 || refundIn.Amount.Refund != 500 {
		t.Errorf("退款金额应为整数分 500/500：%+v", refundIn.Amount)
	}
	if strings.TrimSpace(refundIn.Reason) == "" {
		t.Errorf("退款应带原因：%+v", refundIn)
	}

	// ② 未付款单取消 → 不发退款、也没有 refundError（保持既有行为）。
	_, creates, _ := e.fake.counts()
	o2 := e.payOrder(t, e.phoneA, e.openidA)
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o2.ID+"/cancel", "", hdrA)
	if code != 200 {
		t.Fatalf("未付款单取消应 200，实际 %d %s", code, raw)
	}
	if strings.Contains(raw, "refundError") {
		t.Errorf("未付款单取消不该有 refundError：%s", raw)
	}
	if _, after, _ := e.fake.counts(); after != creates {
		t.Errorf("未付款单取消不该调用退款（%d→%d）", creates, after)
	}

	// ③ 退款接口失败 → 取消失败？不！订单必须已经 cancelled，失败如实落 refund_state=fail。
	e.fake.mu.Lock()
	e.fake.refundFail = true
	e.fake.mu.Unlock()
	o3 := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o3.ID, "WX_TXN_C3", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o3.ID+"/cancel", "", hdrA)
	if code != 200 {
		t.Fatalf("退款失败也必须让取消成功（200），实际 %d %s", code, raw)
	}
	bad, _ := e.st.GetOrder(o3.ID)
	if bad.Status != pricing.StatusCancelled || bad.RefundState != store.RefundStateFail {
		t.Fatalf("退款失败应落 cancelled + refund_state=fail：%+v", bad)
	}
	if !strings.Contains(raw, "refundError") || !strings.Contains(raw, "退款发起失败") {
		t.Errorf("退款失败要如实写在响应里：%s", raw)
	}

	// ④ 后台/员工把已付款单推进到 cancelled 走同一条退款路径。
	e.fake.mu.Lock()
	e.fake.refundFail = false
	e.fake.mu.Unlock()
	_, creates4, _ := e.fake.counts()
	o4 := e.payOrder(t, e.phoneA, e.openidA)
	if err := e.st.MarkPaid(o4.ID, "WX_TXN_C4", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	code, raw = r27Req(t, http.DefaultClient, e.ts, http.MethodPost, "/api/orders/"+o4.ID+"/advance", `{"to":"cancelled"}`,
		map[string]string{"X-Staff-Token": e.staffToken})
	if code != 200 {
		t.Fatalf("员工取消（advance cancelled）应 200，实际 %d %s", code, raw)
	}
	if got, _ := e.st.GetOrder(o4.ID); got.Status != pricing.StatusCancelled || got.RefundState != store.RefundStateProcessing {
		t.Errorf("员工取消已付款单也要退款：%+v", got)
	}
	if _, after4, _ := e.fake.counts(); after4 != creates4+1 {
		t.Errorf("advance 到 cancelled 应发一次退款（%d→%d）", creates4, after4)
	}

	// ⑤ 支付未配置时取消已付款单：仍取消成功，退款失败如实落库。
	noPay, st5 := newPayEnvNoPay(t)
	o5, err := st5.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: noPay.phoneA,
		DeliveryType: "pickup", OpenID: noPay.openidA, Items: []store.NewOrderInputItem{{Code: "6901", Qty: 2}}})
	if err != nil {
		t.Fatalf("造单失败：%v", err)
	}
	if err := st5.MarkPaid(o5.ID, "WX_TXN_C5", ""); err != nil {
		t.Fatalf("标记已收款失败：%v", err)
	}
	code, raw = r27Req(t, http.DefaultClient, noPay.ts, http.MethodPost, "/api/orders/"+o5.ID+"/cancel", "",
		map[string]string{"X-Wx-Openid": noPay.openidA})
	if code != 200 || !strings.Contains(raw, "未配置") {
		t.Fatalf("未配置时取消应成功但如实报退款失败，实际 %d %s", code, raw)
	}
	if got, _ := st5.GetOrder(o5.ID); got.Status != pricing.StatusCancelled || got.RefundState != store.RefundStateFail {
		t.Errorf("未配置时应落 cancelled + refund_state=fail：%+v", got)
	}
}

// ---------- 环境变量与扫单 goroutine ----------

// TestPayEnvOverrides PAY_EXPIRE_SECONDS / PAY_SWEEP_INTERVAL 生效与非法值回退（§1.2/§1.6）。
func TestPayEnvOverrides(t *testing.T) {
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.UpsertProduct(store.Product{Code: "6901", Name: "可乐", SalePrice: 2.5, Stock: 120}); err != nil {
		t.Fatalf("写商品失败：%v", err)
	}
	newOrder := func() store.Order {
		o, err := st.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: "13800001111",
			DeliveryType: "pickup", PayWindow: true, Items: []store.NewOrderInputItem{{Code: "6901", Qty: 1}}})
		if err != nil {
			t.Fatalf("造单失败：%v", err)
		}
		return o
	}

	t.Setenv("PAY_EXPIRE_SECONDS", "120")
	if got := store.PayExpireSeconds(); got != 120 {
		t.Errorf("PAY_EXPIRE_SECONDS=120 应生效，实际 %d", got)
	}
	now := time.Now().Unix()
	if o := newOrder(); o.PayExpireAt < now+119 || o.PayExpireAt > now+121 {
		t.Errorf("新单到期时刻应为 now+120，实际 %d（now=%d）", o.PayExpireAt, now)
	}
	t.Setenv("PAY_EXPIRE_SECONDS", "abc")
	if got := store.PayExpireSeconds(); got != store.DefaultPayExpireSeconds {
		t.Errorf("非法 PAY_EXPIRE_SECONDS 应回退默认 %d，实际 %d", store.DefaultPayExpireSeconds, got)
	}
	t.Setenv("PAY_EXPIRE_SECONDS", "0")
	if got := store.PayExpireSeconds(); got != store.DefaultPayExpireSeconds {
		t.Errorf("0 应回退默认 %d，实际 %d", store.DefaultPayExpireSeconds, got)
	}

	t.Setenv("PAY_SWEEP_INTERVAL", "")
	if got := sweepInterval(); got != DefaultSweepInterval {
		t.Errorf("默认扫单间隔应为 %s，实际 %s", DefaultSweepInterval, got)
	}
	t.Setenv("PAY_SWEEP_INTERVAL", "2s")
	if got := sweepInterval(); got != 2*time.Second {
		t.Errorf("PAY_SWEEP_INTERVAL=2s 应生效，实际 %s", got)
	}
	t.Setenv("PAY_SWEEP_INTERVAL", "500ms")
	if got := sweepInterval(); got != 500*time.Millisecond {
		t.Errorf("PAY_SWEEP_INTERVAL=500ms 应生效，实际 %s", got)
	}
	for _, bad := range []string{"abc", "-1s", "0"} {
		t.Setenv("PAY_SWEEP_INTERVAL", bad)
		if got := sweepInterval(); got != DefaultSweepInterval {
			t.Errorf("非法 PAY_SWEEP_INTERVAL=%q 应回退默认，实际 %s（绝不 panic）", bad, got)
		}
	}
}

// TestPaySweepGoroutine 扫单 goroutine：支付未开通时绝不误杀；开通后真的取消超时单；ctx 取消立即退出。
func TestPaySweepGoroutine(t *testing.T) {
	t.Setenv("PAY_SWEEP_INTERVAL", "20ms")
	st, err := store.Open(":memory:", pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("打开内存库失败：%v", err)
	}
	t.Cleanup(func() { st.Close() })
	if _, err := st.UpsertProduct(store.Product{Code: "6901", Name: "可乐", SalePrice: 2.5, Stock: 120}); err != nil {
		t.Fatalf("写商品失败：%v", err)
	}
	o, err := st.CreateOrder(store.NewOrderInput{CustomerName: "张三", Phone: "13800001111",
		DeliveryType: "pickup", PayWindow: true, Items: []store.NewOrderInputItem{{Code: "6901", Qty: 2}}})
	if err != nil {
		t.Fatalf("造单失败：%v", err)
	}
	if _, err := st.DB().Exec(`UPDATE orders SET pay_expire_at=? WHERE id=?`, time.Now().Unix()-1, o.ID); err != nil {
		t.Fatalf("改到期时间失败：%v", err)
	}

	// 阶段① 支付未开通（pay == nil）：每轮直接跳过——库里残留的过期单也必须原地不动。
	ctx, cancel := context.WithCancel(context.Background())
	go sweepExpiredOrders(ctx, st, nil)
	time.Sleep(200 * time.Millisecond)
	if got, err := st.GetOrder(o.ID); err != nil || got.Status != pricing.StatusPending {
		t.Fatalf("支付未开通时扫单不许取消订单：%+v err=%v", got, err)
	}
	cancel()

	// 阶段② 支付就绪：同一张单会被扫掉（回补库存 + pay_timeout 流水）。
	ready := newPayEnv(t).pay
	if ready == nil || !ready.ready() {
		t.Fatal("假支付运行时应当是就绪的")
	}
	ctx1, cancel1 := context.WithCancel(context.Background())
	defer cancel1()
	go sweepExpiredOrders(ctx1, st, ready)
	deadline := time.Now().Add(5 * time.Second)
	for {
		got, err := st.GetOrder(o.ID)
		if err == nil && got.Status == pricing.StatusCancelled {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("扫单 goroutine 未在 5 秒内取消超时单（PAY_SWEEP_INTERVAL=20ms）")
		}
		time.Sleep(10 * time.Millisecond)
	}
	cancel1()

	// 阶段③ ctx 取消后必须退出（容器优雅退出的要求）。
	done := make(chan struct{})
	ctx2, cancel2 := context.WithCancel(context.Background())
	cancel2()
	go func() { sweepExpiredOrders(ctx2, st, nil); close(done) }()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("ctx 已取消但扫单 goroutine 没退出")
	}
}

// TestPayOrderNoCountdownWhenPayOff 支付未开通时 HTTP 下单不写未付倒计时，
// 且怎么扫都不会被自动取消（支付轮必修缺陷的回归用例）。
func TestPayOrderNoCountdownWhenPayOff(t *testing.T) {
	e, st := newPayEnvNoPay(t)
	postOrder := func(ts *httptest.Server, hdr map[string]string, token string) store.Order {
		t.Helper()
		code, raw := r27Req(t, http.DefaultClient, ts, http.MethodPost, "/api/orders",
			`{"customerName":"张三","phone":"13800001111","deliveryType":"pickup","clientToken":"`+token+`","items":[{"code":"6901","qty":2}]}`, hdr)
		if code != 201 {
			t.Fatalf("下单应 201，实际 %d %s", code, raw)
		}
		var o store.Order
		if err := json.Unmarshal([]byte(raw), &o); err != nil {
			t.Fatalf("解析下单响应失败：%v（%s）", err, raw)
		}
		return o
	}

	o := postOrder(e.ts, map[string]string{"X-Phone": e.phoneA}, "tk-payoff-1")
	if o.PayExpireAt != 0 {
		t.Fatalf("支付未开通时 payExpireAt 必须是 0，实际 %d", o.PayExpireAt)
	}
	// 把「现在」推到一年后：这张单照样不会被扫单取消。
	n, err := st.CancelExpiredUnpaid(time.Now().Unix()+365*24*3600, 50)
	if err != nil || n != 0 {
		t.Fatalf("支付未开通时不该扫掉任何订单：n=%d err=%v", n, err)
	}
	if got, _ := st.GetOrder(o.ID); got.Status != pricing.StatusPending || got.Paid {
		t.Errorf("支付未开通的单必须保持待付款：%+v", got)
	}

	// 对照组：支付就绪时下单会写倒计时（§1.5 下单即开始 15 分钟倒计时）。
	live := newPayEnv(t)
	o2 := postOrder(live.ts, map[string]string{"X-Wx-Openid": live.openidA}, "tk-payoff-2")
	if o2.PayExpireAt <= time.Now().Unix() {
		t.Errorf("支付就绪时下单应有未付倒计时：%+v", o2)
	}
}

// TestPaySettingsPayEnabled /api/settings 下发派生字段 payEnabled（未开通 false / 开通 true），
// 既有 Settings 键一个都不少（嵌入结构体保证序列化后仍是平铺键）。
func TestPaySettingsPayEnabled(t *testing.T) {
	keys := []string{`"name"`, `"phone"`, `"address"`, `"footer"`, `"lowStock"`, `"minOrder"`, `"deliveryFee"`, `"minFree"`}
	check := func(ts *httptest.Server, want bool) string {
		t.Helper()
		code, raw := r27Req(t, http.DefaultClient, ts, http.MethodGet, "/api/settings", "", nil)
		if code != 200 {
			t.Fatalf("/api/settings 应 200，实际 %d %s", code, raw)
		}
		wantPay := `"payEnabled":false`
		if want {
			wantPay = `"payEnabled":true`
		}
		if !strings.Contains(raw, wantPay) {
			t.Errorf("期望 %s，实际 %s", wantPay, raw)
		}
		for _, k := range keys {
			if !strings.Contains(raw, k) {
				t.Errorf("settings 既有键 %s 丢了：%s", k, raw)
			}
		}
		return raw
	}
	off, _ := newPayEnvNoPay(t)
	check(off.ts, false)
	live := newPayEnv(t)
	check(live.ts, true)
}

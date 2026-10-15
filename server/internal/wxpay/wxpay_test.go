package wxpay

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"errors"
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
)

const (
	testAPIv3Key = "0123456789abcdef0123456789abcdef" // 恰好 32 字节
	testAppID    = "wxtestappid0000001"
	testMchID    = "1900000109"
	testSerial   = "TEST-SERIAL-01"
)

// ---------- 测试密钥与文件 ----------

type testEnv struct {
	dir           string
	merchantPriv  *rsa.PrivateKey
	merchantPub   *rsa.PublicKey
	platformPriv  *rsa.PrivateKey
	platformPub   *rsa.PublicKey
	privPath      string // PKCS#8（BEGIN PRIVATE KEY）
	privPKCS1Path string // PKCS#1（BEGIN RSA PRIVATE KEY）
	certPath      string // CERTIFICATE PEM
	pubPath       string // PUBLIC KEY PEM
}

func setupEnv(t *testing.T) *testEnv {
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
	env := &testEnv{
		dir:          dir,
		merchantPriv: merchantPriv,
		merchantPub:  &merchantPriv.PublicKey,
		platformPriv: platformPriv,
		platformPub:  &platformPriv.PublicKey,
	}
	env.privPath = filepath.Join(dir, "apiclient_key.pem")
	env.privPKCS1Path = filepath.Join(dir, "apiclient_key_pkcs1.pem")
	env.certPath = filepath.Join(dir, "platform_cert.pem")
	env.pubPath = filepath.Join(dir, "platform_pub.pem")

	der, err := x509.MarshalPKCS8PrivateKey(merchantPriv)
	if err != nil {
		t.Fatalf("序列化 PKCS#8 私钥失败：%v", err)
	}
	writeFile(t, env.privPath, pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
	writeFile(t, env.privPKCS1Path, pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(merchantPriv)}))

	pubDER, err := x509.MarshalPKIXPublicKey(&platformPriv.PublicKey)
	if err != nil {
		t.Fatalf("序列化平台公钥失败：%v", err)
	}
	writeFile(t, env.pubPath, pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: pubDER}))

	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(20261014),
		Subject:      pkix.Name{CommonName: "fake wechatpay platform"},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().Add(24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
	}
	certDER, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &platformPriv.PublicKey, platformPriv)
	if err != nil {
		t.Fatalf("自签平台证书失败：%v", err)
	}
	writeFile(t, env.certPath, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER}))
	return env
}

func writeFile(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatalf("写文件 %s 失败：%v", path, err)
	}
}

// ---------- 进程内假微信支付 ----------

type recordedReq struct {
	Method string
	URI    string // 含 query、不含域名（= 签名串里的 urlPath）
	Auth   map[string]string
	Body   string
	SigOK  bool
}

type fakeResp struct {
	Status int
	Body   string
}

type fakeWX struct {
	merchantPub *rsa.PublicKey
	mu          sync.Mutex
	reqs        []recordedReq
	override    map[string]fakeResp // "METHOD /path" → 定制响应（错误用例）
	orderStates map[string]string   // out_trade_no → 查单响应体
	refundState string              // 退款查单响应体
}

func newFakeWX(pub *rsa.PublicKey) *fakeWX {
	return &fakeWX{
		merchantPub: pub,
		override:    map[string]fakeResp{},
		orderStates: map[string]string{},
	}
}

func (f *fakeWX) reqCount() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return len(f.reqs)
}

func (f *fakeWX) getOverride(method, path string) (fakeResp, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	resp, hit := f.override[method+" "+path]
	return resp, hit
}

func (f *fakeWX) getOrderState(no string) (string, bool) {
	f.mu.Lock()
	defer f.mu.Unlock()
	st, hit := f.orderStates[no]
	return st, hit
}

func (f *fakeWX) setOverride(method, path string, resp fakeResp) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.override[method+" "+path] = resp
}

func (f *fakeWX) clearOverride(method, path string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	delete(f.override, method+" "+path)
}

func (f *fakeWX) setOrderState(no, body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.orderStates[no] = body
}

func (f *fakeWX) setRefundState(body string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.refundState = body
}

func (f *fakeWX) getRefundState() string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.refundState
}

func (f *fakeWX) lastReq() recordedReq {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.reqs) == 0 {
		return recordedReq{}
	}
	return f.reqs[len(f.reqs)-1]
}

func (f *fakeWX) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	body := string(raw)
	auth, ok := verifyAuthorization(f.merchantPub, r.Method, r.URL.RequestURI(), body, r.Header.Get("Authorization"))
	f.mu.Lock()
	f.reqs = append(f.reqs, recordedReq{Method: r.Method, URI: r.URL.RequestURI(), Auth: auth, Body: body, SigOK: ok})
	f.mu.Unlock()
	if !ok {
		writeJSON(w, http.StatusUnauthorized, `{"code":"SIGN_ERROR","message":"签名错误"}`)
		return
	}
	if resp, hit := f.getOverride(r.Method, r.URL.Path); hit {
		writeJSON(w, resp.Status, resp.Body)
		return
	}
	path := r.URL.Path
	switch {
	case r.Method == http.MethodPost && path == "/v3/pay/transactions/jsapi":
		var req struct {
			OutTradeNo string `json:"out_trade_no"`
			Amount     struct {
				Total json.Number `json:"total"`
			} `json:"amount"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			writeJSON(w, http.StatusBadRequest, `{"code":"PARAM_ERROR","message":"请求体不是合法 JSON"}`)
			return
		}
		total, err := req.Amount.Total.Int64()
		if req.OutTradeNo == "" || err != nil || total <= 0 {
			writeJSON(w, http.StatusBadRequest, `{"code":"PARAM_ERROR","message":"out_trade_no 非空且 amount.total 必须是正整数"}`)
			return
		}
		writeJSON(w, http.StatusOK, `{"prepay_id":"wxfake1234567890"}`)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/v3/pay/transactions/out-trade-no/"):
		no := strings.TrimPrefix(path, "/v3/pay/transactions/out-trade-no/")
		if st, hit := f.getOrderState(no); hit {
			writeJSON(w, http.StatusOK, st)
			return
		}
		writeJSON(w, http.StatusOK, `{"trade_state":"NOTPAY","out_trade_no":"`+no+`"}`)
	case r.Method == http.MethodPost && strings.HasSuffix(path, "/close"):
		w.WriteHeader(http.StatusNoContent)
	case r.Method == http.MethodPost && path == "/v3/refund/domestic/refunds":
		var req struct {
			OutRefundNo string `json:"out_refund_no"`
			Amount      struct {
				Refund int64 `json:"refund"`
			} `json:"amount"`
		}
		_ = json.Unmarshal(raw, &req)
		writeJSON(w, http.StatusOK, `{"refund_id":"50000`+req.OutRefundNo+`","out_refund_no":"`+req.OutRefundNo+
			`","status":"PROCESSING","amount":{"refund":`+strconv.FormatInt(req.Amount.Refund, 10)+`}}`)
	case r.Method == http.MethodGet && strings.HasPrefix(path, "/v3/refund/domestic/refunds/"):
		if st := f.getRefundState(); st != "" {
			writeJSON(w, http.StatusOK, st)
			return
		}
		writeJSON(w, http.StatusNotFound, `{"code":"RESOURCE_NOT_EXISTS","message":"退款单不存在"}`)
	default:
		writeJSON(w, http.StatusNotFound, `{"code":"NOT_FOUND","message":"假服务未实现该端点"}`)
	}
}

func writeJSON(w http.ResponseWriter, status int, body string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = io.WriteString(w, body)
}

func parseAuthorization(h string) (map[string]string, bool) {
	h = strings.TrimSpace(h)
	const prefix = "WECHATPAY2-SHA256-RSA2048 "
	if !strings.HasPrefix(h, prefix) {
		return nil, false
	}
	params := map[string]string{}
	for _, part := range strings.Split(strings.TrimPrefix(h, prefix), ",") {
		i := strings.Index(part, "=")
		if i < 0 {
			return nil, false
		}
		params[strings.TrimSpace(part[:i])] = strings.Trim(strings.TrimSpace(part[i+1:]), `"`)
	}
	for _, k := range []string{"mchid", "nonce_str", "signature", "timestamp", "serial_no"} {
		if params[k] == "" {
			return nil, false
		}
	}
	return params, true
}

// verifyAuthorization 模拟微信侧：用商户公钥验证 Authorization 头里的签名。
func verifyAuthorization(pub *rsa.PublicKey, method, uri, body, authHeader string) (map[string]string, bool) {
	params, ok := parseAuthorization(authHeader)
	if !ok {
		return params, false
	}
	msg := method + "\n" + uri + "\n" + params["timestamp"] + "\n" + params["nonce_str"] + "\n" + body + "\n"
	if err := verifySHA256(pub, msg, params["signature"]); err != nil {
		return params, false
	}
	return params, true
}

// ---------- 测试用客户端 ----------

func newTestClient(t *testing.T, env *testEnv, srv *httptest.Server) *Client {
	t.Helper()
	cl, err := Load(Config{
		AppID:            testAppID,
		MchID:            testMchID,
		SerialNo:         testSerial,
		APIv3Key:         testAPIv3Key,
		PrivateKeyPath:   env.privPath,
		PlatformCertPath: env.certPath,
		APIBase:          srv.URL,
		Client:           srv.Client(),
	})
	if err != nil {
		t.Fatalf("Load 失败：%v", err)
	}
	return cl
}

// ---------- Ready / ErrNotConfigured ----------

func TestReadyRequiresSixKeys(t *testing.T) {
	full := Config{
		AppID: "app", MchID: "mch", SerialNo: "sn", APIv3Key: testAPIv3Key,
		PrivateKeyPath: "/tmp/k.pem", PlatformCertPath: "/tmp/c.pem",
	}
	if !full.Ready() {
		t.Fatalf("六项齐全时 Ready() 应为 true")
	}
	empty := map[string]func(c *Config){
		"AppID":            func(c *Config) { c.AppID = "" },
		"MchID":            func(c *Config) { c.MchID = "" },
		"SerialNo":         func(c *Config) { c.SerialNo = "" },
		"APIv3Key":         func(c *Config) { c.APIv3Key = "" },
		"PrivateKeyPath":   func(c *Config) { c.PrivateKeyPath = "" },
		"PlatformCertPath": func(c *Config) { c.PlatformCertPath = "" },
	}
	for name, mut := range empty {
		t.Run("缺"+name, func(t *testing.T) {
			c := full
			mut(&c)
			if c.Ready() {
				t.Errorf("缺 %s 时 Ready() 应为 false", name)
			}
		})
	}
	t.Run("APIBase/NotifyURL 有默认值不算缺", func(t *testing.T) {
		c := full
		c.APIBase, c.NotifyURL, c.Client = "", "", nil
		if !c.Ready() {
			t.Errorf("APIBase/NotifyURL 为空时 Ready() 应仍为 true（有默认值）")
		}
	})
}

func TestLoadNotConfigured(t *testing.T) {
	if _, err := Load(Config{}); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("空配置 Load 应返回 ErrNotConfigured，实际 %v", err)
	}
	env := setupEnv(t)
	c := Config{
		AppID: testAppID, MchID: testMchID, SerialNo: testSerial,
		APIv3Key: "short", PrivateKeyPath: env.privPath, PlatformCertPath: env.certPath,
	}
	if _, err := Load(c); !errors.Is(err, ErrNotConfigured) {
		t.Fatalf("APIv3 密钥长度不对应返回 ErrNotConfigured，实际 %v", err)
	}
}

func TestLoadReadErrors(t *testing.T) {
	env := setupEnv(t)
	c := Config{
		AppID: testAppID, MchID: testMchID, SerialNo: testSerial, APIv3Key: testAPIv3Key,
		PrivateKeyPath: filepath.Join(env.dir, "nope.pem"), PlatformCertPath: env.certPath,
	}
	if _, err := Load(c); err == nil || errors.Is(err, ErrNotConfigured) || !strings.Contains(err.Error(), "读取商户私钥") {
		t.Fatalf("私钥不存在时应报读取错误（不是 ErrNotConfigured），实际 %v", err)
	}
	c.PrivateKeyPath = env.privPath
	c.PlatformCertPath = filepath.Join(env.dir, "nope-cert.pem")
	if _, err := Load(c); err == nil || !strings.Contains(err.Error(), "读取平台证书") {
		t.Fatalf("平台证书不存在时应报读取错误，实际 %v", err)
	}
}

func TestNotConfiguredMethodsDoNotSendRequest(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	ctx := context.Background()

	// 缺 SerialNo → Ready()==false；直接构造绕过 Load，验证方法本身不发请求。
	cl := &Client{
		cfg:  Config{AppID: testAppID, MchID: testMchID, APIv3Key: testAPIv3Key, NotifyURL: DefaultNotifyURL},
		priv: env.merchantPriv, plat: env.platformPub, http: srv.Client(), base: srv.URL,
	}
	if cl.cfg.Ready() {
		t.Fatal("该配置不应 Ready()")
	}
	cases := []struct {
		name string
		call func() error
	}{
		{"Prepay", func() error { _, err := cl.Prepay(ctx, "M1", "测试", 600, "openid", ""); return err }},
		{"BuildPayParams", func() error { _, err := cl.BuildPayParams("wx1"); return err }},
		{"QueryOrder", func() error { _, err := cl.QueryOrder(ctx, "M1"); return err }},
		{"CloseOrder", func() error { return cl.CloseOrder(ctx, "M1") }},
		{"Refund", func() error { _, err := cl.Refund(ctx, "M1", "RM1", 600, 600, "取消"); return err }},
		{"QueryRefund", func() error { _, err := cl.QueryRefund(ctx, "RM1"); return err }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			err := c.call()
			if !errors.Is(err, ErrNotConfigured) {
				t.Errorf("未配置时应返回 ErrNotConfigured，实际 %v", err)
			}
			if err != nil && !strings.Contains(err.Error(), "微信支付未配置") {
				t.Errorf("错误文本应含「微信支付未配置」，实际 %v", err)
			}
		})
	}
	if n := fake.reqCount(); n != 0 {
		t.Errorf("未配置时不应发出任何请求，实际发了 %d 个", n)
	}

	t.Run("nil 接收者不 panic", func(t *testing.T) {
		var nilClient *Client
		if _, err := nilClient.Prepay(ctx, "M1", "d", 1, "o", ""); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("nil 客户端 Prepay 应返回 ErrNotConfigured，实际 %v", err)
		}
		if err := nilClient.CloseOrder(ctx, "M1"); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("nil 客户端 CloseOrder 应返回 ErrNotConfigured，实际 %v", err)
		}
		if _, err := nilClient.VerifyAndDecryptNotify(http.Header{}, []byte(`{}`)); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("nil 客户端回调验签应返回 ErrNotConfigured，实际 %v", err)
		}
	})

	t.Run("缺平台密钥时回调验签报未配置", func(t *testing.T) {
		noPlat := &Client{cfg: cl.cfg}
		if _, err := noPlat.VerifyAndDecryptNotify(http.Header{}, []byte(`{}`)); !errors.Is(err, ErrNotConfigured) {
			t.Errorf("plat==nil 时应返回 ErrNotConfigured，实际 %v", err)
		}
	})
}

// ---------- 签名 / 验签 ----------

func TestAuthorizationSelfVerify(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)

	if _, err := cl.Prepay(context.Background(), "M20261014001", "沙棘汁×2", 600, "o_test_openid", ""); err != nil {
		t.Fatalf("Prepay 失败：%v", err)
	}
	req := fake.lastReq()
	if !req.SigOK {
		t.Fatalf("假服务未能用商户公钥验过 Authorization 头：%+v", req.Auth)
	}
	if req.Auth["mchid"] != testMchID || req.Auth["serial_no"] != testSerial {
		t.Errorf("Authorization 里的 mchid/serial_no 不对：%+v", req.Auth)
	}
	if _, err := strconv.ParseInt(req.Auth["timestamp"], 10, 64); err != nil {
		t.Errorf("timestamp 应是秒级整数串，实际 %q", req.Auth["timestamp"])
	}

	// 独立复算签名串：method\nurlPath\ntimestamp\nnonce\nbody\n
	msg := req.Method + "\n" + req.URI + "\n" + req.Auth["timestamp"] + "\n" + req.Auth["nonce_str"] + "\n" + req.Body + "\n"
	if err := verifySHA256(env.merchantPub, msg, req.Auth["signature"]); err != nil {
		t.Fatalf("按规格拼出的签名串验签失败：%v", err)
	}
	// 换一把公钥必须验不过（证明确实是商户私钥签的）。
	other, _ := rsa.GenerateKey(rand.Reader, 2048)
	if err := verifySHA256(&other.PublicKey, msg, req.Auth["signature"]); err == nil {
		t.Fatalf("用无关公钥竟然验过了签名")
	}
}

func TestAuthorizationCoversQueryString(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)

	if _, err := cl.QueryOrder(context.Background(), "M20261014002"); err != nil {
		t.Fatalf("QueryOrder 失败：%v", err)
	}
	req := fake.lastReq()
	if req.Method != http.MethodGet {
		t.Errorf("查单应为 GET，实际 %s", req.Method)
	}
	if req.URI != "/v3/pay/transactions/out-trade-no/M20261014002?mchid="+testMchID {
		t.Errorf("urlPath 不对：%s", req.URI)
	}
	if !req.SigOK {
		t.Errorf("含 query 的 urlPath 未被验签通过：%+v", req.Auth)
	}
}

func TestBadSignatureRejected(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()

	wrong, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("生成无关密钥失败：%v", err)
	}
	cl := &Client{
		cfg: Config{
			AppID: testAppID, MchID: testMchID, SerialNo: testSerial, APIv3Key: testAPIv3Key,
			PrivateKeyPath: env.privPath, PlatformCertPath: env.certPath, NotifyURL: DefaultNotifyURL,
		},
		priv: wrong, plat: env.platformPub, http: srv.Client(), base: srv.URL,
	}
	_, err = cl.Prepay(context.Background(), "M1", "测试", 600, "o", "")
	if err == nil {
		t.Fatal("错误签名应被假服务拒绝")
	}
	var apiErr *APIError
	if !errors.As(err, &apiErr) || apiErr.StatusCode != http.StatusUnauthorized {
		t.Fatalf("应拿到 401 APIError，实际 %v", err)
	}
	if !strings.Contains(err.Error(), "SIGN_ERROR") || !strings.Contains(err.Error(), "签名错误") {
		t.Errorf("错误文本应透传 code 与 message，实际 %v", err)
	}
	if fake.lastReq().SigOK {
		t.Errorf("假服务不该验过错误签名")
	}
}

func TestVerifySHA256RejectsBadBase64(t *testing.T) {
	env := setupEnv(t)
	if err := verifySHA256(env.merchantPub, "msg", "!!!not-base64!!!"); err == nil || !strings.Contains(err.Error(), "base64") {
		t.Fatalf("非法 base64 签名应报错，实际 %v", err)
	}
	if err := verifySHA256(env.merchantPub, "msg", ""); err == nil {
		t.Fatalf("空签名应报错")
	}
}

// ---------- 密钥解析 ----------

func TestParsePrivateKeyFormats(t *testing.T) {
	env := setupEnv(t)
	pkcs8, err := os.ReadFile(env.privPath)
	if err != nil {
		t.Fatal(err)
	}
	if k, err := parsePrivateKey(pkcs8); err != nil || k.N.Cmp(env.merchantPriv.N) != 0 {
		t.Fatalf("PKCS#8 私钥解析失败：%v", err)
	}
	pkcs1, err := os.ReadFile(env.privPKCS1Path)
	if err != nil {
		t.Fatal(err)
	}
	if k, err := parsePrivateKey(pkcs1); err != nil || k.N.Cmp(env.merchantPriv.N) != 0 {
		t.Fatalf("PKCS#1 私钥解析失败：%v", err)
	}
	if _, err := parsePrivateKey([]byte("not a pem")); err == nil {
		t.Fatalf("非 PEM 应报错")
	}
	if _, err := parsePrivateKey(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: []byte("garbage")})); err == nil {
		t.Fatalf("垃圾私钥应报错")
	}
}

func TestParsePlatformKeyFormats(t *testing.T) {
	env := setupEnv(t)
	cert, err := os.ReadFile(env.certPath)
	if err != nil {
		t.Fatal(err)
	}
	if k, err := parsePlatformPubKey(cert); err != nil || k.N.Cmp(env.platformPub.N) != 0 {
		t.Fatalf("CERTIFICATE 格式平台证书解析失败：%v", err)
	}
	pub, err := os.ReadFile(env.pubPath)
	if err != nil {
		t.Fatal(err)
	}
	if k, err := parsePlatformPubKey(pub); err != nil || k.N.Cmp(env.platformPub.N) != 0 {
		t.Fatalf("PUBLIC KEY 格式平台公钥解析失败：%v", err)
	}
	if _, err := parsePlatformPubKey([]byte("nope")); err == nil || !strings.Contains(err.Error(), "PEM") {
		t.Fatalf("非法 PEM 应报明确错误，实际 %v", err)
	}
	if _, err := parsePlatformPubKey(pem.EncodeToMemory(&pem.Block{Type: "PUBLIC KEY", Bytes: []byte("garbage")})); err == nil {
		t.Fatalf("既不是 CERTIFICATE 也不是 PUBLIC KEY 时应报错")
	}
}

// ---------- AES-256-GCM ----------

func encryptAESGCM(t *testing.T, key, plain, nonce, aad string) string {
	t.Helper()
	block, err := aes.NewCipher([]byte(key))
	if err != nil {
		t.Fatalf("NewCipher: %v", err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatalf("NewGCM: %v", err)
	}
	return base64.StdEncoding.EncodeToString(gcm.Seal(nil, []byte(nonce), []byte(plain), []byte(aad)))
}

func TestAESGCMDecrypt(t *testing.T) {
	const nonce = "abcdefghijkl" // 12 字节
	plain := `{"out_trade_no":"M1"}`
	ct := encryptAESGCM(t, testAPIv3Key, plain, nonce, "transaction")

	t.Run("正确密钥能解开", func(t *testing.T) {
		got, err := aesGCMDecrypt(testAPIv3Key, nonce, "transaction", ct)
		if err != nil {
			t.Fatalf("解密失败：%v", err)
		}
		if string(got) != plain {
			t.Errorf("明文不符：%s", got)
		}
	})
	t.Run("错密钥必须报错", func(t *testing.T) {
		_, err := aesGCMDecrypt("ffffffffffffffffffffffffffffffff", nonce, "transaction", ct)
		if err == nil || !strings.Contains(err.Error(), "解密失败") {
			t.Fatalf("错密钥应解密失败，实际 %v", err)
		}
	})
	t.Run("错 AAD 必须报错", func(t *testing.T) {
		if _, err := aesGCMDecrypt(testAPIv3Key, nonce, "refund", ct); err == nil {
			t.Fatalf("AAD 不符应解密失败")
		}
	})
	t.Run("密钥长度不对报错", func(t *testing.T) {
		if _, err := aesGCMDecrypt("short", nonce, "transaction", ct); err == nil || !strings.Contains(err.Error(), "32") {
			t.Fatalf("密钥长度不对应报错，实际 %v", err)
		}
	})
	t.Run("nonce 长度不对报错", func(t *testing.T) {
		if _, err := aesGCMDecrypt(testAPIv3Key, "short", "transaction", ct); err == nil || !strings.Contains(err.Error(), "nonce") {
			t.Fatalf("nonce 长度不对应报错，实际 %v", err)
		}
	})
	t.Run("密文非 base64 报错", func(t *testing.T) {
		if _, err := aesGCMDecrypt(testAPIv3Key, nonce, "transaction", "!!!!"); err == nil || !strings.Contains(err.Error(), "base64") {
			t.Fatalf("非 base64 密文应报错，实际 %v", err)
		}
	})
}

// ---------- 下单 / 查单 / 关单 ----------

func TestPrepay(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)
	ctx := context.Background()

	t.Run("成功返回 prepay_id", func(t *testing.T) {
		id, err := cl.Prepay(ctx, "M20261014001", "沙棘汁×2", 600, "o_openid", "")
		if err != nil {
			t.Fatalf("Prepay 失败：%v", err)
		}
		if id != "wxfake1234567890" {
			t.Errorf("prepay_id 不符：%s", id)
		}
		req := fake.lastReq()
		if req.URI != "/v3/pay/transactions/jsapi" {
			t.Errorf("下单端点不对：%s", req.URI)
		}
		var sent map[string]any
		if err := json.Unmarshal([]byte(req.Body), &sent); err != nil {
			t.Fatalf("请求体不是 JSON：%v", err)
		}
		if sent["appid"] != testAppID || sent["mchid"] != testMchID || sent["out_trade_no"] != "M20261014001" {
			t.Errorf("请求体基础字段不对：%v", sent)
		}
		if sent["notify_url"] != DefaultNotifyURL {
			t.Errorf("notify_url 应用默认值，实际 %v", sent["notify_url"])
		}
		amount, _ := sent["amount"].(map[string]any)
		if amount["total"].(float64) != 600 {
			t.Errorf("amount.total 应为整数分 600，实际 %v", amount["total"])
		}
		payer, _ := sent["payer"].(map[string]any)
		if payer["openid"] != "o_openid" {
			t.Errorf("payer.openid 不对：%v", payer)
		}
	})

	t.Run("显式 notifyURL 覆盖默认值", func(t *testing.T) {
		if _, err := cl.Prepay(ctx, "M2", "测试", 100, "o", "https://example.com/api/pay/notify"); err != nil {
			t.Fatalf("Prepay 失败：%v", err)
		}
		var sent map[string]any
		_ = json.Unmarshal([]byte(fake.lastReq().Body), &sent)
		if sent["notify_url"] != "https://example.com/api/pay/notify" {
			t.Errorf("显式 notifyURL 未生效：%v", sent["notify_url"])
		}
	})

	t.Run("金额非正数本地拦截", func(t *testing.T) {
		before := fake.reqCount()
		if _, err := cl.Prepay(ctx, "M3", "测试", 0, "o", ""); err == nil {
			t.Fatal("金额 0 应被拒")
		}
		if fake.reqCount() != before {
			t.Errorf("金额非法不应发请求")
		}
	})

	t.Run("微信返回 code/message 时错误文本透传", func(t *testing.T) {
		fake.setOverride("POST", "/v3/pay/transactions/jsapi", fakeResp{
			Status: http.StatusBadRequest,
			Body:   `{"code":"PARAM_ERROR","message":"订单号重复，请更换 out_trade_no"}`,
		})
		defer fake.clearOverride("POST", "/v3/pay/transactions/jsapi")
		_, err := cl.Prepay(ctx, "M4", "测试", 600, "o", "")
		if err == nil {
			t.Fatal("应返回错误")
		}
		if !strings.Contains(err.Error(), "PARAM_ERROR") || !strings.Contains(err.Error(), "订单号重复") {
			t.Errorf("错误文本应含 code 与 message，实际 %v", err)
		}
		var apiErr *APIError
		if !errors.As(err, &apiErr) || apiErr.Code != "PARAM_ERROR" {
			t.Errorf("应能用 errors.As 取到 APIError.Code，实际 %v", err)
		}
	})

	t.Run("非 JSON 错误体回退成状态码+响应片段", func(t *testing.T) {
		fake.setOverride("POST", "/v3/pay/transactions/jsapi", fakeResp{
			Status: http.StatusBadGateway,
			Body:   "<html>bad gateway</html>",
		})
		defer fake.clearOverride("POST", "/v3/pay/transactions/jsapi")
		_, err := cl.Prepay(ctx, "M5", "测试", 600, "o", "")
		if err == nil || !strings.Contains(err.Error(), "502") || !strings.Contains(err.Error(), "bad gateway") {
			t.Errorf("错误文本应含 HTTP 状态码与响应片段，实际 %v", err)
		}
	})
}

func TestQueryOrder(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)
	ctx := context.Background()

	t.Run("未支付 NOTPAY", func(t *testing.T) {
		st, err := cl.QueryOrder(ctx, "M20261014010")
		if err != nil {
			t.Fatalf("QueryOrder 失败：%v", err)
		}
		if st.TradeState != "NOTPAY" || st.TransactionID != "" || st.AmountFen != 0 {
			t.Errorf("NOTPAY 结果不符：%+v", st)
		}
	})

	t.Run("已支付 SUCCESS", func(t *testing.T) {
		fake.setOrderState("M20261014011", `{"trade_state":"SUCCESS","out_trade_no":"M20261014011","transaction_id":"42000M20261014011","success_time":"2026-10-14T16:00:00+08:00","amount":{"total":600}}`)
		st, err := cl.QueryOrder(ctx, "M20261014011")
		if err != nil {
			t.Fatalf("QueryOrder 失败：%v", err)
		}
		if st.TradeState != "SUCCESS" || st.TransactionID != "42000M20261014011" ||
			st.AmountFen != 600 || st.SuccessTime != "2026-10-14T16:00:00+08:00" {
			t.Errorf("SUCCESS 结果不符：%+v", st)
		}
	})

	t.Run("订单不存在透传 code", func(t *testing.T) {
		fake.setOverride("GET", "/v3/pay/transactions/out-trade-no/M404", fakeResp{
			Status: http.StatusNotFound,
			Body:   `{"code":"ORDER_NOT_EXIST","message":"订单不存在"}`,
		})
		defer fake.clearOverride("GET", "/v3/pay/transactions/out-trade-no/M404")
		_, err := cl.QueryOrder(ctx, "M404")
		if err == nil || !strings.Contains(err.Error(), "ORDER_NOT_EXIST") || !strings.Contains(err.Error(), "订单不存在") {
			t.Errorf("错误文本应透传，实际 %v", err)
		}
	})
}

func TestCloseOrder(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)
	ctx := context.Background()

	if err := cl.CloseOrder(ctx, "M20261014020"); err != nil {
		t.Fatalf("关单失败：%v", err)
	}
	req := fake.lastReq()
	if req.URI != "/v3/pay/transactions/out-trade-no/M20261014020/close" {
		t.Errorf("关单端点不对：%s", req.URI)
	}
	if !req.SigOK {
		t.Errorf("关单请求未通过验签")
	}

	fake.setOverride("POST", "/v3/pay/transactions/out-trade-no/M20261014021/close", fakeResp{
		Status: http.StatusBadRequest, Body: `{"code":"ORDER_CLOSED","message":"订单已关闭"}`,
	})
	defer fake.clearOverride("POST", "/v3/pay/transactions/out-trade-no/M20261014021/close")
	if err := cl.CloseOrder(ctx, "M20261014021"); err == nil || !strings.Contains(err.Error(), "ORDER_CLOSED") {
		t.Errorf("关单失败应透传 code，实际 %v", err)
	}
}

// ---------- 退款 ----------

func TestRefund(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)
	ctx := context.Background()

	st, err := cl.Refund(ctx, "M20261014030", "RM20261014030", 600, 600, "顾客取消")
	if err != nil {
		t.Fatalf("退款失败：%v", err)
	}
	if st.RefundID != "50000RM20261014030" || st.OutRefundNo != "RM20261014030" {
		t.Errorf("退款结果不符：%+v", st)
	}
	if st.State != "PROCESSING" || st.RefundFen != 600 {
		t.Errorf("退款状态/金额不符：%+v", st)
	}
	var sent map[string]any
	_ = json.Unmarshal([]byte(fake.lastReq().Body), &sent)
	if sent["out_trade_no"] != "M20261014030" || sent["out_refund_no"] != "RM20261014030" || sent["reason"] != "顾客取消" {
		t.Errorf("退款请求体不对：%v", sent)
	}
	amount, _ := sent["amount"].(map[string]any)
	if amount["refund"].(float64) != 600 || amount["total"].(float64) != 600 || amount["currency"] != "CNY" {
		t.Errorf("退款金额字段不对：%v", amount)
	}
	if sent["notify_url"] != "https://mall.shadouyou.cloud/api/pay/refund-notify" {
		t.Errorf("退款 notify_url 应由支付回调推出 …/refund-notify，实际 %v", sent["notify_url"])
	}

	t.Run("退款金额超过订单金额本地拦截", func(t *testing.T) {
		before := fake.reqCount()
		if _, err := cl.Refund(ctx, "M1", "RM1", 600, 700, "取消"); err == nil {
			t.Fatal("退款金额大于总额应被拒")
		}
		if fake.reqCount() != before {
			t.Errorf("金额非法不应发请求")
		}
	})

	t.Run("微信返回错误透传", func(t *testing.T) {
		fake.setOverride("POST", "/v3/refund/domestic/refunds", fakeResp{
			Status: http.StatusBadRequest, Body: `{"code":"NOT_ENOUGH","message":"商户号余额不足"}`,
		})
		defer fake.clearOverride("POST", "/v3/refund/domestic/refunds")
		_, err := cl.Refund(ctx, "M2", "RM2", 600, 600, "取消")
		if err == nil || !strings.Contains(err.Error(), "NOT_ENOUGH") || !strings.Contains(err.Error(), "余额不足") {
			t.Errorf("退款错误应透传，实际 %v", err)
		}
	})
}

func TestQueryRefund(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)
	ctx := context.Background()

	fake.setRefundState(`{"refund_id":"50000RM20261014040","out_refund_no":"RM20261014040","status":"SUCCESS","success_time":"2026-10-14T16:05:00+08:00","amount":{"refund":600,"total":600}}`)
	st, err := cl.QueryRefund(ctx, "RM20261014040")
	if err != nil {
		t.Fatalf("退款查单失败：%v", err)
	}
	if st.State != "SUCCESS" || st.RefundFen != 600 || st.SuccessTime != "2026-10-14T16:05:00+08:00" {
		t.Errorf("退款查单结果不符：%+v", st)
	}
	if uri := fake.lastReq().URI; uri != "/v3/refund/domestic/refunds/RM20261014040" {
		t.Errorf("退款查单端点不对：%s", uri)
	}
}

// ---------- BuildPayParams ----------

func TestBuildPayParams(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)

	params, err := cl.BuildPayParams("wxfake1234567890")
	if err != nil {
		t.Fatalf("BuildPayParams 失败：%v", err)
	}
	if params["package"] != "prepay_id=wxfake1234567890" {
		t.Errorf("package 不对：%s", params["package"])
	}
	if params["signType"] != "RSA" {
		t.Errorf("signType 应为 RSA，实际 %s", params["signType"])
	}
	if len(params["nonceStr"]) != 32 {
		t.Errorf("nonceStr 应 32 位，实际 %q", params["nonceStr"])
	}
	if _, err := strconv.ParseInt(params["timeStamp"], 10, 64); err != nil {
		t.Errorf("timeStamp 应是秒级字符串，实际 %q", params["timeStamp"])
	}
	msg := testAppID + "\n" + params["timeStamp"] + "\n" + params["nonceStr"] + "\n" + params["package"] + "\n"
	if err := verifySHA256(env.merchantPub, msg, params["paySign"]); err != nil {
		t.Fatalf("paySign 应能用商户公钥验过：%v", err)
	}
	if err := verifySHA256(env.platformPub, msg, params["paySign"]); err == nil {
		t.Errorf("paySign 不该能用平台公钥验过（应用商户私钥签）")
	}
	if fake.reqCount() != 0 {
		t.Errorf("BuildPayParams 是纯本地计算，不该发请求")
	}
}

// ---------- 回调验签 + 解密 ----------

// signedNotify 构造一条真实形状的回调：AES-256-GCM 加密 resource + 平台私钥签名 body。
func signedNotify(t *testing.T, env *testEnv, eventType string, plain any, key string) (http.Header, []byte) {
	t.Helper()
	plainBytes, err := json.Marshal(plain)
	if err != nil {
		t.Fatalf("明文序列化失败：%v", err)
	}
	const nonce = "abcdefghijkl" // 12 字节 ASCII
	aad := "transaction"
	if strings.HasPrefix(eventType, "REFUND") {
		aad = "refund"
	}
	res := map[string]string{
		"algorithm":       "AEAD_AES_256_GCM",
		"ciphertext":      encryptAESGCM(t, key, string(plainBytes), nonce, aad),
		"nonce":           nonce,
		"associated_data": aad,
		"original_type":   "transaction",
	}
	body, err := json.Marshal(map[string]any{
		"id":            "EV-20261014-0001",
		"create_time":   "2026-10-14T16:00:00+08:00",
		"resource_type": "encrypt-resource",
		"event_type":    eventType,
		"summary":       "支付成功",
		"resource":      res,
	})
	if err != nil {
		t.Fatalf("回调报文序列化失败：%v", err)
	}
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	headerNonce := "1234567890abcdef"
	sig, err := signSHA256(env.platformPriv, ts+"\n"+headerNonce+"\n"+string(body)+"\n")
	if err != nil {
		t.Fatalf("回调签名失败：%v", err)
	}
	h := http.Header{}
	h.Set("Wechatpay-Timestamp", ts)
	h.Set("Wechatpay-Nonce", headerNonce)
	h.Set("Wechatpay-Signature", sig)
	h.Set("Wechatpay-Serial", "FAKE-PLATFORM-SERIAL-01")
	h.Set("Content-Type", "application/json")
	return h, body
}

func TestVerifyAndDecryptNotify(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)

	payPlain := map[string]any{
		"mchid":          testMchID,
		"appid":          testAppID,
		"out_trade_no":   "M20261014050",
		"transaction_id": "42000M20261014050",
		"trade_state":    "SUCCESS",
		"success_time":   "2026-10-14T16:00:00+08:00",
		"amount":         map[string]any{"total": 600, "payer_total": 600, "currency": "CNY"},
	}

	t.Run("支付成功回调", func(t *testing.T) {
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		n, err := cl.VerifyAndDecryptNotify(h, body)
		if err != nil {
			t.Fatalf("验签解密失败：%v", err)
		}
		if n.EventType != "TRANSACTION.SUCCESS" || n.OutTradeNo != "M20261014050" ||
			n.TransactionID != "42000M20261014050" || n.TradeState != "SUCCESS" ||
			n.AmountFen != 600 || n.SuccessTime != "2026-10-14T16:00:00+08:00" {
			t.Errorf("支付回调字段不符：%+v", n)
		}
		if n.MchID != testMchID || n.AppID != testAppID {
			t.Errorf("mchid/appid 未解析出来：%+v", n)
		}
	})

	t.Run("签名被改坏必须拒绝", func(t *testing.T) {
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		raw, err := base64.StdEncoding.DecodeString(h.Get("Wechatpay-Signature"))
		if err != nil {
			t.Fatal(err)
		}
		raw[0] ^= 0xff
		h.Set("Wechatpay-Signature", base64.StdEncoding.EncodeToString(raw))
		if _, err := cl.VerifyAndDecryptNotify(h, body); err == nil || !strings.Contains(err.Error(), "验签失败") {
			t.Fatalf("坏签名应报验签失败，实际 %v", err)
		}
	})

	t.Run("body 被改坏必须拒绝", func(t *testing.T) {
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		// 改信封（明文业务字段在密文里，改它不改变 body），签名必须对不上。
		tampered := strings.Replace(string(body), "EV-20261014-0001", "EV-20261014-9999", 1)
		if tampered == string(body) {
			t.Fatal("测试前提不成立：body 里没有可改的信封字段")
		}
		if _, err := cl.VerifyAndDecryptNotify(h, []byte(tampered)); err == nil || !strings.Contains(err.Error(), "验签失败") {
			t.Fatalf("改过的 body 应报验签失败，实际 %v", err)
		}
	})

	t.Run("密文被改坏必须报解密失败", func(t *testing.T) {
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		var envl map[string]any
		if err := json.Unmarshal(body, &envl); err != nil {
			t.Fatal(err)
		}
		res := envl["resource"].(map[string]any)
		raw, err := base64.StdEncoding.DecodeString(res["ciphertext"].(string))
		if err != nil {
			t.Fatal(err)
		}
		raw[0] ^= 0xff
		res["ciphertext"] = base64.StdEncoding.EncodeToString(raw)
		newBody, err := json.Marshal(envl)
		if err != nil {
			t.Fatal(err)
		}
		// 重新用平台私钥签名，保证「验签过、解密失败」这条路径被独立覆盖。
		ts := h.Get("Wechatpay-Timestamp")
		nonce := h.Get("Wechatpay-Nonce")
		sig, err := signSHA256(env.platformPriv, ts+"\n"+nonce+"\n"+string(newBody)+"\n")
		if err != nil {
			t.Fatal(err)
		}
		h.Set("Wechatpay-Signature", sig)
		if _, err := cl.VerifyAndDecryptNotify(h, newBody); err == nil || !strings.Contains(err.Error(), "解密失败") {
			t.Fatalf("坏密文应报解密失败，实际 %v", err)
		}
	})

	t.Run("用非平台密钥签的回调必须拒绝", func(t *testing.T) {
		other, err := rsa.GenerateKey(rand.Reader, 2048)
		if err != nil {
			t.Fatal(err)
		}
		decoy := &testEnv{platformPriv: other}
		h, body := signedNotify(t, decoy, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		if _, err := cl.VerifyAndDecryptNotify(h, body); err == nil || !strings.Contains(err.Error(), "验签失败") {
			t.Fatalf("非平台密钥签名应被拒，实际 %v", err)
		}
	})

	t.Run("退款成功回调", func(t *testing.T) {
		refundPlain := map[string]any{
			"mchid":         testMchID,
			"out_refund_no": "RM20261014050",
			"refund_id":     "50000RM20261014050",
			"refund_status": "SUCCESS",
			"success_time":  "2026-10-14T16:10:00+08:00",
			"amount":        map[string]any{"refund": 600, "total": 600, "payer_refund": 600},
		}
		h, body := signedNotify(t, env, "REFUND.SUCCESS", refundPlain, testAPIv3Key)
		n, err := cl.VerifyAndDecryptNotify(h, body)
		if err != nil {
			t.Fatalf("退款回调验签解密失败：%v", err)
		}
		if n.EventType != "REFUND.SUCCESS" || n.OutRefundNo != "RM20261014050" ||
			n.RefundID != "50000RM20261014050" || n.RefundState != "SUCCESS" || n.AmountFen != 600 {
			t.Errorf("退款回调字段不符：%+v", n)
		}
	})

	t.Run("退款异常/关闭回调", func(t *testing.T) {
		for _, ev := range []string{"REFUND.ABNORMAL", "REFUND.CLOSED"} {
			plain := map[string]any{
				"out_refund_no": "RM20261014051",
				"refund_id":     "50000RM20261014051",
				"refund_status": strings.TrimPrefix(ev, "REFUND."),
				"amount":        map[string]any{"refund": 600},
			}
			h, body := signedNotify(t, env, ev, plain, testAPIv3Key)
			n, err := cl.VerifyAndDecryptNotify(h, body)
			if err != nil {
				t.Fatalf("%s 回调失败：%v", ev, err)
			}
			if n.RefundState != strings.TrimPrefix(ev, "REFUND.") {
				t.Errorf("%s 的 RefundState 不符：%+v", ev, n)
			}
		}
	})

	t.Run("错 APIv3 密钥解密报错", func(t *testing.T) {
		bad := *cl
		bad.cfg.APIv3Key = "ffffffffffffffffffffffffffffffff"
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		if _, err := bad.VerifyAndDecryptNotify(h, body); err == nil || !strings.Contains(err.Error(), "解密失败") {
			t.Fatalf("错密钥应解密失败，实际 %v", err)
		}
	})

	t.Run("缺头报错", func(t *testing.T) {
		_, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		if _, err := cl.VerifyAndDecryptNotify(http.Header{}, body); err == nil || !strings.Contains(err.Error(), "缺少 Wechatpay") {
			t.Fatalf("缺头应报错，实际 %v", err)
		}
	})

	t.Run("空报文报错", func(t *testing.T) {
		if _, err := cl.VerifyAndDecryptNotify(http.Header{}, nil); err == nil {
			t.Fatalf("空报文应报错")
		}
	})

	t.Run("不支持的事件类型报错", func(t *testing.T) {
		h, body := signedNotify(t, env, "TRANSACTION.CLOSED", payPlain, testAPIv3Key)
		if _, err := cl.VerifyAndDecryptNotify(h, body); err == nil || !strings.Contains(err.Error(), "不支持") {
			t.Fatalf("未支持的事件类型应报错，实际 %v", err)
		}
	})
}

// TestNotifyTimestampFreshness 回调时间戳新鲜度：陈旧时间戳与非整数时间戳都必须被拒（防重放）。
func TestNotifyTimestampFreshness(t *testing.T) {
	env := setupEnv(t)
	fake := newFakeWX(env.merchantPub)
	srv := httptest.NewServer(fake)
	defer srv.Close()
	cl := newTestClient(t, env, srv)

	payPlain := map[string]any{
		"mchid":          testMchID,
		"appid":          testAppID,
		"out_trade_no":   "M20261014060",
		"transaction_id": "42000M20261014060",
		"trade_state":    "SUCCESS",
		"success_time":   "2026-10-14T16:00:00+08:00",
		"amount":         map[string]any{"total": 600},
	}
	// resign 换掉时间戳后用平台私钥重新签名——确保被拒的原因只能是时间戳，而不是签名错。
	resign := func(ts string) (http.Header, []byte) {
		t.Helper()
		h, body := signedNotify(t, env, "TRANSACTION.SUCCESS", payPlain, testAPIv3Key)
		h.Set("Wechatpay-Timestamp", ts)
		sig, err := signSHA256(env.platformPriv, ts+"\n"+h.Get("Wechatpay-Nonce")+"\n"+string(body)+"\n")
		if err != nil {
			t.Fatalf("重新签名失败：%v", err)
		}
		h.Set("Wechatpay-Signature", sig)
		return h, body
	}

	t.Run("时间戳超 5 分钟必须拒绝", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			ts   time.Time
		}{
			{"早 10 分钟", time.Now().Add(-10 * time.Minute)},
			{"晚 10 分钟", time.Now().Add(10 * time.Minute)},
			{"早 1 小时", time.Now().Add(-time.Hour)},
		} {
			h, body := resign(strconv.FormatInt(tc.ts.Unix(), 10))
			_, err := cl.VerifyAndDecryptNotify(h, body)
			if err == nil {
				t.Fatalf("%s：陈旧时间戳必须拒绝", tc.name)
			}
			if !strings.Contains(err.Error(), "时间戳过期") {
				t.Errorf("%s：错误文本应含「时间戳过期」，实际 %v", tc.name, err)
			}
			if strings.Contains(err.Error(), "验签失败") {
				t.Errorf("%s：签名是合法的，不该报验签失败：%v", tc.name, err)
			}
		}
	})

	t.Run("时间戳不是整数必须拒绝", func(t *testing.T) {
		for _, bad := range []string{"not-a-number", "17abc", "", "2026-10-14T16:00:00+08:00"} {
			h, body := resign(bad)
			if bad == "" {
				h.Set("Wechatpay-Timestamp", "")
			}
			_, err := cl.VerifyAndDecryptNotify(h, body)
			if err == nil {
				t.Fatalf("时间戳 %q 必须拒绝", bad)
			}
			// 空串会被「缺头」分支先拦下，其余落到「不合法」分支。
			if bad != "" && !strings.Contains(err.Error(), "时间戳不合法") {
				t.Errorf("时间戳 %q：错误文本应含「时间戳不合法」，实际 %v", bad, err)
			}
		}
	})

	t.Run("容差内的偏差仍接受", func(t *testing.T) {
		for _, tc := range []struct {
			name string
			ts   time.Time
		}{
			{"刚过去 1 分钟", time.Now().Add(-time.Minute)},
			{"未来 1 分钟", time.Now().Add(time.Minute)},
		} {
			h, body := resign(strconv.FormatInt(tc.ts.Unix(), 10))
			if _, err := cl.VerifyAndDecryptNotify(h, body); err != nil {
				t.Fatalf("%s：容差内不该被拒：%v", tc.name, err)
			}
		}
	})
}

// TestLoadDefaults 确认 APIBase / NotifyURL 缺省值。
func TestLoadDefaults(t *testing.T) {
	env := setupEnv(t)
	cl, err := Load(Config{
		AppID: testAppID, MchID: testMchID, SerialNo: testSerial, APIv3Key: testAPIv3Key,
		PrivateKeyPath: env.privPath, PlatformCertPath: env.pubPath,
	})
	if err != nil {
		t.Fatalf("Load 失败：%v", err)
	}
	if cl.base != DefaultAPIBase || cl.cfg.NotifyURL != DefaultNotifyURL {
		t.Errorf("默认值不对：base=%s notify=%s", cl.base, cl.cfg.NotifyURL)
	}
	if cl.refundNotifyURL() != "https://mall.shadouyou.cloud/api/pay/refund-notify" {
		t.Errorf("退款回调地址推导不对：%s", cl.refundNotifyURL())
	}
	cl.cfg.NotifyURL = "https://example.com/custom"
	if cl.refundNotifyURL() != "" {
		t.Errorf("推不出时不应瞎编 URL，实际 %s", cl.refundNotifyURL())
	}
	if cl.http == nil || cl.http.Timeout != 10*time.Second {
		t.Errorf("默认 HTTP 客户端应有 10 秒超时")
	}
}

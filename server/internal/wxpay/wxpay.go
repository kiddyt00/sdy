// Package wxpay 微信支付 v3（小程序 JSAPI）客户端与密码学实现，纯标准库。
//
// 覆盖本项目需要的能力：JSAPI 下单、支付参数签名、查单、关单、退款、退款查单，
// 以及回调验签 + AES-256-GCM 解密。所有金额一律整数分（§1.3）。
// 未配置完整时所有方法返回包装后的 ErrNotConfigured，绝不 panic，也绝不发请求。
package wxpay

import (
	"bytes"
	"context"
	"crypto/rsa"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// DefaultAPIBase 微信支付正式环境域名；测试时用 WXPAY_API_BASE 指向假服务。
const DefaultAPIBase = "https://api.mch.weixin.qq.com"

// DefaultNotifyURL 生产环境支付回调地址（§1.2）。
const DefaultNotifyURL = "https://mall.shadouyou.cloud/api/pay/notify"

// ErrNotConfigured 微信支付未配置（缺商户号 / 证书序列号 / APIv3 密钥 / 私钥 / 平台证书 / AppID 中任意一项）。
// 上层用 errors.Is(err, ErrNotConfigured) 判定并回 503。
var ErrNotConfigured = errors.New("微信支付未配置")

// Config 微信支付配置：只从环境变量读（§1.2），绝不入库、绝不进日志。
type Config struct {
	AppID            string       // 小程序 AppID（回调校验 appid 用）
	MchID            string       // 商户号
	SerialNo         string       // 商户 API 证书序列号
	APIv3Key         string       // APIv3 密钥（32 位），回调 AES-256-GCM 解密用
	PrivateKeyPath   string       // 商户私钥 apiclient_key.pem 路径
	PlatformCertPath string       // 微信支付平台证书 PEM（CERTIFICATE 或 PUBLIC KEY 均可）
	APIBase          string       // 默认 https://api.mch.weixin.qq.com
	NotifyURL        string       // 默认 https://mall.shadouyou.cloud/api/pay/notify
	Client           *http.Client // 可注入（测试用 httptest.Client）；nil 则用 10 秒超时的默认客户端
}

// Ready 六个关键项（AppID / MchID / SerialNo / APIv3Key / PrivateKeyPath / PlatformCertPath）齐全才 true。
func (c Config) Ready() bool {
	return c.AppID != "" && c.MchID != "" && c.SerialNo != "" &&
		c.APIv3Key != "" && c.PrivateKeyPath != "" && c.PlatformCertPath != ""
}

// Client 微信支付客户端。零值不可用，必须经 Load 构造。
type Client struct {
	cfg  Config
	priv *rsa.PrivateKey
	plat *rsa.PublicKey
	http *http.Client
	base string
}

// Load 读商户私钥与平台证书/公钥并构造客户端。
// 配置不齐 → 返回包装后的 ErrNotConfigured（调用方回 503，且「下单接口照旧可用」，§1.2）。
func Load(c Config) (*Client, error) {
	if !c.Ready() {
		return nil, fmt.Errorf("%w（服务端缺少 AppID / 商户号 / 证书序列号 / APIv3 密钥 / 私钥 / 平台证书）", ErrNotConfigured)
	}
	if len(c.APIv3Key) != 32 {
		return nil, fmt.Errorf("%w：APIv3 密钥必须恰好 32 字节（当前 %d）", ErrNotConfigured, len(c.APIv3Key))
	}
	privPEM, err := os.ReadFile(c.PrivateKeyPath)
	if err != nil {
		return nil, fmt.Errorf("读取商户私钥 %s 失败：%w", c.PrivateKeyPath, err)
	}
	priv, err := parsePrivateKey(privPEM)
	if err != nil {
		return nil, fmt.Errorf("解析商户私钥 %s 失败：%w", c.PrivateKeyPath, err)
	}
	certPEM, err := os.ReadFile(c.PlatformCertPath)
	if err != nil {
		return nil, fmt.Errorf("读取平台证书 %s 失败：%w", c.PlatformCertPath, err)
	}
	plat, err := parsePlatformPubKey(certPEM)
	if err != nil {
		return nil, fmt.Errorf("解析平台证书 %s 失败：%w", c.PlatformCertPath, err)
	}
	base := strings.TrimRight(strings.TrimSpace(c.APIBase), "/")
	if base == "" {
		base = DefaultAPIBase
	}
	notify := strings.TrimSpace(c.NotifyURL)
	if notify == "" {
		notify = DefaultNotifyURL
	}
	hc := c.Client
	if hc == nil {
		hc = &http.Client{Timeout: 10 * time.Second}
	}
	c.APIBase = base
	c.NotifyURL = notify
	return &Client{cfg: c, priv: priv, plat: plat, http: hc, base: base}, nil
}

// APIError 微信支付返回的非 2xx 响应；错误文本可直接给运维看，也可用 errors.As 取 code 分支处理。
type APIError struct {
	StatusCode int
	Code       string
	Message    string
	Body       string
}

func (e *APIError) Error() string {
	if e.Code != "" || e.Message != "" {
		return fmt.Sprintf("微信支付返回错误（HTTP %d）：code=%s message=%s", e.StatusCode, e.Code, e.Message)
	}
	s := snippet(e.Body, 300)
	if s == "" {
		return fmt.Sprintf("微信支付返回错误（HTTP %d，响应体为空）", e.StatusCode)
	}
	return fmt.Sprintf("微信支付返回错误（HTTP %d）：%s", e.StatusCode, s)
}

// snippet 截断响应体，避免把整页 HTML 塞进错误与日志。
func snippet(s string, max int) string {
	s = strings.TrimSpace(s)
	if len(s) <= max {
		return s
	}
	return s[:max] + "…（已截断）"
}

func newAPIError(status int, body []byte) *APIError {
	e := &APIError{StatusCode: status, Body: string(body)}
	var parsed struct {
		Code    string `json:"code"`
		Message string `json:"message"`
	}
	if err := json.Unmarshal(body, &parsed); err == nil {
		e.Code = parsed.Code
		e.Message = parsed.Message
	}
	return e
}

// doJSON 商户侧请求统一出口：签名 → 带 Authorization / Accept / Content-Type → 发请求 → 非 2xx 转成可读错误。
// urlPath 含 query、不含域名（签名串用的就是它）。
func (cl *Client) doJSON(ctx context.Context, method, urlPath string, body any) ([]byte, error) {
	if cl == nil || !cl.cfg.Ready() {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	var payload []byte
	if body != nil {
		var err error
		payload, err = json.Marshal(body)
		if err != nil {
			return nil, fmt.Errorf("序列化请求体失败：%w", err)
		}
	}
	nonce, err := newNonce()
	if err != nil {
		return nil, err
	}
	timestamp := strconv.FormatInt(time.Now().Unix(), 10)
	message := method + "\n" + urlPath + "\n" + timestamp + "\n" + nonce + "\n" + string(payload) + "\n"
	signature, err := signSHA256(cl.priv, message)
	if err != nil {
		return nil, fmt.Errorf("请求签名失败：%w", err)
	}
	auth := fmt.Sprintf(
		`WECHATPAY2-SHA256-RSA2048 mchid="%s",nonce_str="%s",signature="%s",timestamp="%s",serial_no="%s"`,
		cl.cfg.MchID, nonce, signature, timestamp, cl.cfg.SerialNo,
	)
	req, err := http.NewRequestWithContext(ctx, method, cl.base+urlPath, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("构造微信支付请求失败：%w", err)
	}
	req.Header.Set("Authorization", auth)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("User-Agent", "sdy-wxpay/1.0")
	resp, err := cl.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("请求微信支付失败（%s %s）：%w", method, urlPath, err)
	}
	defer resp.Body.Close()
	respBody, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, fmt.Errorf("读取微信支付响应失败：%w", err)
	}
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		return nil, newAPIError(resp.StatusCode, respBody)
	}
	return respBody, nil
}

// Prepay JSAPI 下单，返回 prepay_id（§1.5：out_trade_no = 订单号，绝不带毫秒）。
// notifyURL 为空时用 Config.NotifyURL。
func (cl *Client) Prepay(ctx context.Context, outTradeNo, description string, amountFen int64, openID, notifyURL string) (string, error) {
	if cl == nil || !cl.cfg.Ready() {
		return "", fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(outTradeNo) == "" {
		return "", errors.New("outTradeNo 不能为空")
	}
	if amountFen <= 0 {
		return "", fmt.Errorf("支付金额必须是正整数分（当前 %d）", amountFen)
	}
	if notifyURL == "" {
		notifyURL = cl.cfg.NotifyURL
	}
	req := map[string]any{
		"appid":        cl.cfg.AppID,
		"mchid":        cl.cfg.MchID,
		"description":  description,
		"out_trade_no": outTradeNo,
		"notify_url":   notifyURL,
		"amount":       map[string]any{"total": amountFen, "currency": "CNY"},
		"payer":        map[string]any{"openid": openID},
	}
	respBody, err := cl.doJSON(ctx, http.MethodPost, "/v3/pay/transactions/jsapi", req)
	if err != nil {
		return "", err
	}
	var parsed struct {
		PrepayID string `json:"prepay_id"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return "", fmt.Errorf("解析微信支付下单响应失败：%w", err)
	}
	if parsed.PrepayID == "" {
		return "", fmt.Errorf("微信支付下单响应缺少 prepay_id：%s", snippet(string(respBody), 300))
	}
	return parsed.PrepayID, nil
}

// BuildPayParams 生成小程序 wx.requestPayment 需要的参数（§1.8 收银台）。
// paySign 用**商户私钥**对该串签名：appid\ntimeStamp\nnonceStr\npackage\n（不是平台公钥）。
func (cl *Client) BuildPayParams(prepayID string) (map[string]string, error) {
	if cl == nil || cl.priv == nil || !cl.cfg.Ready() {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(prepayID) == "" {
		return nil, errors.New("prepayID 不能为空")
	}
	timeStamp := strconv.FormatInt(time.Now().Unix(), 10)
	nonceStr, err := newNonce()
	if err != nil {
		return nil, err
	}
	pkg := "prepay_id=" + prepayID
	message := cl.cfg.AppID + "\n" + timeStamp + "\n" + nonceStr + "\n" + pkg + "\n"
	paySign, err := signSHA256(cl.priv, message)
	if err != nil {
		return nil, fmt.Errorf("支付参数签名失败：%w", err)
	}
	return map[string]string{
		"timeStamp": timeStamp,
		"nonceStr":  nonceStr,
		"package":   pkg,
		"signType":  "RSA",
		"paySign":   paySign,
	}, nil
}

// TradeState 查单结果（GET /v3/pay/transactions/out-trade-no/{no}?mchid=）。
type TradeState struct {
	TradeState    string // NOTPAY / SUCCESS / CLOSED / ...
	TransactionID string
	SuccessTime   string // RFC3339
	AmountFen     int64  // amount.total，整数分
}

// QueryOrder 主动查单（§1.5 的 30 秒兜底与支付成功后落库都用它）。
func (cl *Client) QueryOrder(ctx context.Context, outTradeNo string) (*TradeState, error) {
	if cl == nil || !cl.cfg.Ready() {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(outTradeNo) == "" {
		return nil, errors.New("outTradeNo 不能为空")
	}
	urlPath := "/v3/pay/transactions/out-trade-no/" + url.PathEscape(outTradeNo) +
		"?mchid=" + url.QueryEscape(cl.cfg.MchID)
	respBody, err := cl.doJSON(ctx, http.MethodGet, urlPath, nil)
	if err != nil {
		return nil, err
	}
	var parsed struct {
		TradeState    string `json:"trade_state"`
		TransactionID string `json:"transaction_id"`
		SuccessTime   string `json:"success_time"`
		Amount        struct {
			Total int64 `json:"total"`
		} `json:"amount"`
	}
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("解析微信支付查单响应失败：%w", err)
	}
	return &TradeState{
		TradeState:    parsed.TradeState,
		TransactionID: parsed.TransactionID,
		SuccessTime:   parsed.SuccessTime,
		AmountFen:     parsed.Amount.Total,
	}, nil
}

// CloseOrder 关闭未支付订单（POST /v3/pay/transactions/out-trade-no/{no}/close，成功返回 204）。
func (cl *Client) CloseOrder(ctx context.Context, outTradeNo string) error {
	if cl == nil || !cl.cfg.Ready() {
		return fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(outTradeNo) == "" {
		return errors.New("outTradeNo 不能为空")
	}
	urlPath := "/v3/pay/transactions/out-trade-no/" + url.PathEscape(outTradeNo) + "/close"
	_, err := cl.doJSON(ctx, http.MethodPost, urlPath, map[string]string{"mchid": cl.cfg.MchID})
	return err
}

// RefundState 退款结果（发起退款与退款查单共用）。
type RefundState struct {
	RefundID    string
	OutRefundNo string
	State       string // PROCESSING / SUCCESS / ABNORMAL / CLOSED
	RefundFen   int64  // amount.refund，整数分
	SuccessTime string
}

type refundJSON struct {
	RefundID    string `json:"refund_id"`
	OutRefundNo string `json:"out_refund_no"`
	Status      string `json:"status"`
	SuccessTime string `json:"success_time"`
	Amount      struct {
		Refund int64 `json:"refund"`
	} `json:"amount"`
}

func (r refundJSON) toState() *RefundState {
	return &RefundState{
		RefundID:    r.RefundID,
		OutRefundNo: r.OutRefundNo,
		State:       r.Status,
		RefundFen:   r.Amount.Refund,
		SuccessTime: r.SuccessTime,
	}
}

// refundNotifyURL 从支付回调地址推出退款回调地址（…/notify → …/refund-notify，§1.5 的两条公开路由）。
// 推不出来就返回空串（此时由商户平台配置的默认回调地址兜底），绝不瞎编一个 URL。
func (cl *Client) refundNotifyURL() string {
	n := strings.TrimSpace(cl.cfg.NotifyURL)
	if n == "" {
		return ""
	}
	if strings.HasSuffix(n, "/notify") {
		return strings.TrimSuffix(n, "/notify") + "/refund-notify"
	}
	return ""
}

// Refund 发起退款（§1.7：out_refund_no = R+订单号，金额 = 订单分）。
// 退款结果由 /api/pay/refund-notify 或 QueryRefund 兜底更新为 success/fail。
func (cl *Client) Refund(ctx context.Context, outTradeNo, outRefundNo string, totalFen, refundFen int64, reason string) (*RefundState, error) {
	if cl == nil || !cl.cfg.Ready() {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(outTradeNo) == "" {
		return nil, errors.New("outTradeNo 不能为空")
	}
	if strings.TrimSpace(outRefundNo) == "" {
		return nil, errors.New("outRefundNo 不能为空")
	}
	if refundFen <= 0 {
		return nil, fmt.Errorf("退款金额必须是正整数分（当前 %d）", refundFen)
	}
	if totalFen < refundFen {
		return nil, fmt.Errorf("退款金额 %d 分不能超过订单金额 %d 分", refundFen, totalFen)
	}
	req := map[string]any{
		"out_trade_no":  outTradeNo,
		"out_refund_no": outRefundNo,
		"reason":        reason,
		"amount": map[string]any{
			"refund":   refundFen,
			"total":    totalFen,
			"currency": "CNY",
		},
	}
	if n := cl.refundNotifyURL(); n != "" {
		req["notify_url"] = n
	}
	respBody, err := cl.doJSON(ctx, http.MethodPost, "/v3/refund/domestic/refunds", req)
	if err != nil {
		return nil, err
	}
	var parsed refundJSON
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("解析微信支付退款响应失败：%w", err)
	}
	return parsed.toState(), nil
}

// QueryRefund 退款查单（GET /v3/refund/domestic/refunds/{out_refund_no}）。
func (cl *Client) QueryRefund(ctx context.Context, outRefundNo string) (*RefundState, error) {
	if cl == nil || !cl.cfg.Ready() {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	if strings.TrimSpace(outRefundNo) == "" {
		return nil, errors.New("outRefundNo 不能为空")
	}
	urlPath := "/v3/refund/domestic/refunds/" + url.PathEscape(outRefundNo)
	respBody, err := cl.doJSON(ctx, http.MethodGet, urlPath, nil)
	if err != nil {
		return nil, err
	}
	var parsed refundJSON
	if err := json.Unmarshal(respBody, &parsed); err != nil {
		return nil, fmt.Errorf("解析微信支付退款查单响应失败：%w", err)
	}
	return parsed.toState(), nil
}

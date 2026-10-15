// 微信支付 HTTP 层（支付轮 §1.5）。
//
// 三条公开/半公开接口的共同红线：
//   - 金额一律用整数分比较（amountFen，§1.3），**绝不比较浮点**；
//   - 回调（notify / refund-notify）验签 → 解密 → 业务校验 → 幂等落库；
//     业务校验失败回可读的 4xx（让微信重试），**绝不 500、绝不 panic**；
//   - 密钥、证书、完整签名串绝不进日志、绝不进任何响应体。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
	"github.com/kiddyt00/sdy/server/internal/wxpay"
)

// payRT 运行期支付依赖。client == nil 表示未配置：/api/pay/prepay 回 503，其余功能照旧。
// mchID / appID 只用于校验回调里的 mchid / appid（wxpay.Client 的 cfg 是私有的，
// 这里单独留一份非敏感副本；APIv3 密钥、私钥一律不进这个结构体）。
type payRT struct {
	client *wxpay.Client
	mchID  string
	appID  string

	mu     sync.Mutex
	lastQ  map[string]int64 // 订单号 → 上次主动查单的 Unix 秒（§1.5 的 30 秒节流）
	lastQR map[string]int64 // 订单号 → 上次退款查单的 Unix 秒
}

// ready 支付是否可用（配置齐全且证书/私钥都读到了）。
func (p *payRT) ready() bool { return p != nil && p.client != nil }

// payConfFromEnv 从环境变量读支付配置（§1.2）。只从环境读，绝不入库、绝不进日志。
//
// 注意：§1.2 的环境变量表里没有 AppID，而 wxpay.Config 必须要有 AppID（回调要校验 appid），
// 所以这里复用小程序登录用的 WX_APPID —— 这是文档与实现的一处差异，已写进交付报告。
func payConfFromEnv() wxpay.Config {
	return wxpay.Config{
		AppID:            strings.TrimSpace(os.Getenv("WX_APPID")),
		MchID:            strings.TrimSpace(os.Getenv("WXPAY_MCHID")),
		SerialNo:         strings.TrimSpace(os.Getenv("WXPAY_SERIAL_NO")),
		APIv3Key:         os.Getenv("WXPAY_API_V3_KEY"),
		PrivateKeyPath:   strings.TrimSpace(os.Getenv("WXPAY_PRIVATE_KEY_PATH")),
		PlatformCertPath: strings.TrimSpace(os.Getenv("WXPAY_PLATFORM_CERT_PATH")),
		APIBase:          getenv("WXPAY_API_BASE", wxpay.DefaultAPIBase),
		NotifyURL:        getenv("WXPAY_NOTIFY_URL", wxpay.DefaultNotifyURL),
		Client:           &http.Client{Timeout: 10 * time.Second},
	}
}

// newPayRT 构造支付运行期依赖。**配置不齐/证书读不到都不算致命错误**：
// 返回 (nil, err)，调用方记一行 WARN 继续起服务（§1.2）。
func newPayRT(cfg wxpay.Config) (*payRT, error) {
	cl, err := wxpay.Load(cfg)
	if err != nil {
		return nil, err
	}
	return &payRT{client: cl, mchID: cfg.MchID, appID: cfg.AppID}, nil
}

// amountFen 元 → 整数分（§1.3 的唯一口径）：int64(math.Round(f*100))。
// 库里订单金额列仍是 REAL 元（不做数据迁移），但只要跟支付打交道就先转成分。
func amountFen(total float64) int64 { return int64(math.Round(total * 100)) }

// payNotConfiguredMsg prepay 未配置时的固定文案（§1.2 要求逐字一致）。
const payNotConfiguredMsg = "微信支付未配置（服务端缺少商户号 / 证书 / APIv3 密钥）"

// timeout 主动查单节流窗口：同一张单 30 秒内只查一次微信（§1.5）。
const payQueryGap int64 = 30

// allowQuery 节流：距上次查单超过 gap 秒才放行。返回 false 表示这次跳过。
func (p *payRT) allowQuery(orderID string, now int64) bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lastQ == nil {
		p.lastQ = map[string]int64{}
	}
	if t, ok := p.lastQ[orderID]; ok && now-t < payQueryGap {
		return false
	}
	p.lastQ[orderID] = now
	return true
}

// allowQueryRefund 退款查单的同类节流。
func (p *payRT) allowQueryRefund(orderID string, now int64) bool {
	if p == nil {
		return false
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.lastQR == nil {
		p.lastQR = map[string]int64{}
	}
	if t, ok := p.lastQR[orderID]; ok && now-t < payQueryGap {
		return false
	}
	p.lastQR[orderID] = now
	return true
}

// orderPayResp 取消/推进响应：订单字段仍然平铺在顶层（兼容既有客户端），
// 只有「已收款单退款没发起成功」时才多一个 refundError。
type orderPayResp struct {
	store.Order
	RefundError string `json:"refundError,omitempty"`
}

// ---------- POST /api/pay/prepay ----------

func handlePrepay(w http.ResponseWriter, r *http.Request, st *store.Store, pay *payRT) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	if !pay.ready() {
		writeJSON(w, 503, map[string]string{"error": payNotConfiguredMsg})
		return
	}
	ident, ok := identityOf(w, r, st)
	if !ok {
		return
	}
	// 空身份（既没 openid/手机号、也不是员工/管理员）直接回 400，与 GET /api/orders 同一口径：
	// 不能靠「谁的手机号都匹配不上」绕成 404，那样顾客端只会看到「订单不存在」而不知道为什么。
	if ident.Phone == "" && ident.OpenID == "" && !ident.Admin {
		writeJSON(w, 400, map[string]string{"error": "缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token"})
		return
	}
	var in struct {
		OrderID string `json:"orderId"`
	}
	if !decode(w, r, &in) {
		return
	}
	orderID := strings.TrimSpace(in.OrderID)
	if orderID == "" {
		writeJSON(w, 400, map[string]string{"error": "缺少订单号 orderId"})
		return
	}
	o, err := st.GetOrder(orderID)
	if err != nil {
		writeErr(w, err)
		return
	}
	// 归属：顾客只能付自己的单；员工/管理员放行（后台代客收款）。不是自己的单一律按
	// 「不存在」处理，不泄露订单是否存在（与 GET /api/orders/{id} 同一口径）。
	if !ident.Admin && !orderBelongsTo(o, ident) {
		writeJSON(w, 404, map[string]string{"error": "订单不存在"})
		return
	}
	now := time.Now().Unix()
	if o.Status != pricing.StatusPending {
		writeJSON(w, 400, map[string]string{"error": fmt.Sprintf("订单已「%s」，不能支付", pricing.StatusText(o.Status))})
		return
	}
	if o.Paid {
		writeJSON(w, 400, map[string]string{"error": "订单已收款，无需重复支付"})
		return
	}
	if o.PayExpireAt > 0 && o.PayExpireAt <= now {
		writeJSON(w, 400, map[string]string{"error": "订单已超时未付，请重新下单"})
		return
	}

	openID, msg, code := resolvePayer(st, o, ident)
	if code != 0 {
		writeJSON(w, code, map[string]string{"error": msg})
		return
	}
	if openID == "" {
		// 理论上 resolvePayer 已经拦住了；兜底防止拿空 openid 去调微信。
		writeJSON(w, 400, map[string]string{"error": "请在微信小程序里登录后再支付"})
		return
	}

	// 老单（上线前建的 pending 单，pay_expire_at=0）没有倒计时：第一次发起支付时给它一个窗口；
	// 新单用建单时就算好的截止时刻 —— 绝不在这里 now+900，否则每次点「去支付」都把倒计时重置。
	expireAt := o.PayExpireAt
	if expireAt <= 0 {
		expireAt = now + store.PayExpireSeconds()
	}
	cached, _, _, err := st.GetOrderPrepay(orderID)
	if err != nil {
		writeErr(w, err)
		return
	}
	prepayID := cached
	if prepayID == "" {
		prepayID, err = pay.client.Prepay(r.Context(), o.ID, orderDescription(o), amountFen(o.Total), openID, "")
		if err != nil {
			writePayErr(w, "微信支付下单失败", err)
			return
		}
		if err := st.SetPrepay(orderID, prepayID, expireAt); err != nil {
			writeErr(w, err)
			return
		}
	}
	params, err := pay.client.BuildPayParams(prepayID)
	if err != nil {
		writePayErr(w, "生成支付参数失败", err)
		return
	}
	writeJSON(w, 200, map[string]any{
		"outTradeNo": o.ID,
		"amountFen":  amountFen(o.Total),
		"payParams":  params,
		"expireAt":   expireAt,
	})
}

// resolvePayer 决定这一单用哪个 openid 付款，并处理「跨端补 openid」（§1.5）。
// 返回 (openid, 错误文案, HTTP 状态码)；状态码为 0 表示通过。
//
// 分支（§1.5 的四句话里有重叠，这里按「先看有没有微信身份，再看单子绑没绑微信」落地）：
//   - 订单没绑微信（openid=”）＋ 身份带 openid ＋ 手机号一致 → 补写 openid 后继续；
//   - 订单没绑微信 ＋ 身份带 openid ＋ 手机号不一致 → 403（这单是网页下单的，让顾客用下单手机号登录）；
//   - 订单没绑微信 ＋ 身份没有 openid（纯网页身份）→ 400「请在微信小程序里登录后再支付」；
//   - 订单绑了别人的微信 → 403「这个订单不是你的，无法支付」；
//   - 员工/管理员放行：用订单自己的 openid（代客收款），订单没绑微信就让他们引导顾客登录小程序。
func resolvePayer(st *store.Store, o store.Order, ident identity) (openID, msg string, code int) {
	if ident.Admin {
		if o.OpenID == "" {
			return "", "这个订单还没有绑定微信，请让顾客先用小程序登录后再支付", 400
		}
		return o.OpenID, "", 0
	}
	if ident.OpenID == "" {
		return "", "请在微信小程序里登录后再支付", 400
	}
	if o.OpenID == "" {
		if strings.TrimSpace(o.Phone) != strings.TrimSpace(ident.Phone) {
			return "", "这单是网页下单的，请用下单时的手机号登录小程序支付", 403
		}
		if err := st.AttachOpenID(o.ID, ident.OpenID); err != nil {
			return "", "补写订单微信标识失败：" + err.Error(), 500
		}
		return ident.OpenID, "", 0
	}
	if o.OpenID != ident.OpenID {
		return "", "这个订单不是你的，无法支付", 403
	}
	return o.OpenID, "", 0
}

// orderDescription 微信账单上的商品描述。
func orderDescription(o store.Order) string {
	desc := "啥都有快送订单 " + o.ID
	if len(o.Items) > 0 && strings.TrimSpace(o.Items[0].Name) != "" {
		desc = "啥都有快送 " + o.Items[0].Name
		if len(o.Items) > 1 {
			desc += fmt.Sprintf(" 等 %d 件", len(o.Items))
		}
	}
	return desc
}

// writePayErr 微信侧调用失败：未配置 → 503，其余 → 502（上游故障，不是客户端错误）。
func writePayErr(w http.ResponseWriter, what string, err error) {
	code := 502
	if errors.Is(err, wxpay.ErrNotConfigured) {
		code = 503
	}
	writeJSON(w, code, map[string]string{"error": what + "：" + err.Error()})
}

// ---------- 回调：POST /api/pay/notify ----------

// notifyOK 回调成功的应答体（微信要求 code=SUCCESS 才停止重推）。
func notifyOK(w http.ResponseWriter) {
	writeJSON(w, 200, map[string]string{"code": "SUCCESS", "message": "成功"})
}

// notifyFail 回调业务失败：**一定要回 4xx**，否则微信以为收到、不再重推。
func notifyFail(w http.ResponseWriter, status int, format string, args ...any) {
	writeJSON(w, status, map[string]string{"code": "FAIL", "message": fmt.Sprintf(format, args...)})
}

func handlePayNotify(w http.ResponseWriter, r *http.Request, st *store.Store, pay *payRT) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	if !pay.ready() {
		writeJSON(w, 503, map[string]string{"code": "FAIL", "message": payNotConfiguredMsg})
		return
	}
	n, ok := verifyNotify(w, r, pay)
	if !ok {
		return
	}
	if n.EventType != "TRANSACTION.SUCCESS" {
		// 非支付成功事件：不是本接口的业务，回 SUCCESS 让微信别重推。
		notifyOK(w)
		return
	}
	if n.TradeState != "SUCCESS" {
		notifyFail(w, 400, "交易状态不是 SUCCESS（%s）", n.TradeState)
		return
	}
	if pay.mchID != "" && n.MchID != pay.mchID {
		notifyFail(w, 400, "回调商户号与本机配置不一致")
		return
	}
	if pay.appID != "" && n.AppID != pay.appID {
		notifyFail(w, 400, "回调 AppID 与本机配置不一致")
		return
	}
	if strings.TrimSpace(n.OutTradeNo) == "" {
		notifyFail(w, 400, "回调缺少 out_trade_no")
		return
	}
	o, err := st.GetOrder(n.OutTradeNo)
	if err != nil {
		notifyFail(w, 404, "订单不存在：%s", n.OutTradeNo)
		return
	}
	// 金额不符 → 拒绝处理，**订单一个字段都不改**（只回 4xx 让微信重试/人工介入）。
	if got, want := n.AmountFen, amountFen(o.Total); got != want {
		log.Printf("WARN 支付回调金额不符：订单 %s 应为 %d 分，回调为 %d 分", o.ID, want, got)
		notifyFail(w, 400, "回调金额与订单不符")
		return
	}
	if err := st.MarkPaid(o.ID, n.TransactionID, n.SuccessTime); err != nil {
		if errors.Is(err, store.ErrConflict) {
			// 「已经记过账了」：这笔钱不会丢第二次，重推也不会改结果 → 回 SUCCESS 停止重推，只留 WARN 记录。
			log.Printf("WARN 支付回调冲突（不改数据，已回 SUCCESS）：%v", err)
			notifyOK(w)
			return
		}
		// 真正的落库故障：回 503（不是 500），微信会重推。
		log.Printf("WARN 支付回调落库失败：%v", err)
		notifyFail(w, 503, "落库失败，请重试")
		return
	}
	log.Printf("订单 %s 已收款（微信支付单号 %s）", o.ID, n.TransactionID)
	notifyOK(w)
}

// ---------- 回调：POST /api/pay/refund-notify ----------

func handleRefundNotify(w http.ResponseWriter, r *http.Request, st *store.Store, pay *payRT) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	if !pay.ready() {
		writeJSON(w, 503, map[string]string{"code": "FAIL", "message": payNotConfiguredMsg})
		return
	}
	n, ok := verifyNotify(w, r, pay)
	if !ok {
		return
	}
	if !strings.HasPrefix(n.EventType, "REFUND.") {
		notifyOK(w)
		return
	}
	if pay.mchID != "" && n.MchID != pay.mchID {
		notifyFail(w, 400, "回调商户号与本机配置不一致")
		return
	}
	orderID := refundOrderID(st, n.OutRefundNo)
	if orderID == "" {
		notifyFail(w, 404, "退款单号对应的订单不存在：%s", n.OutRefundNo)
		return
	}
	state := refundStateOf(n.RefundState)
	if err := st.MarkRefund(orderID, n.RefundID, state); err != nil {
		if errors.Is(err, store.ErrNotFound) {
			notifyFail(w, 404, "订单不存在：%s", orderID)
			return
		}
		log.Printf("WARN 退款回调落库失败：%v", err)
		notifyFail(w, 503, "落库失败，请重试")
		return
	}
	log.Printf("订单 %s 退款状态更新为 %s", orderID, state)
	notifyOK(w)
}

// refundOrderID 把 out_refund_no 还原成订单号：本项目退款单号是 `R`+订单号，
// 但「两种都认」——老数据/人工退款可能是裸订单号。
func refundOrderID(st *store.Store, outRefundNo string) string {
	no := strings.TrimSpace(outRefundNo)
	if no == "" {
		return ""
	}
	if _, err := st.GetOrder(no); err == nil {
		return no
	}
	if bare := strings.TrimPrefix(no, "R"); bare != no {
		if _, err := st.GetOrder(bare); err == nil {
			return bare
		}
	}
	return ""
}

// refundStateOf 微信退款状态 → 本项目的 refund_state（只允许 ”/processing/success/fail）。
func refundStateOf(wxState string) string {
	switch strings.ToUpper(strings.TrimSpace(wxState)) {
	case "SUCCESS":
		return store.RefundStateSuccess
	case "ABNORMAL", "CLOSED":
		return store.RefundStateFail
	case "PROCESSING":
		return store.RefundStateProcessing
	}
	return store.RefundStateProcessing
}

// verifyNotify 验签 + 解密；失败时自己写好响应并返回 false。
// 验签失败回 401（签名不对说明不是微信，绝不让它触发任何业务）。
func verifyNotify(w http.ResponseWriter, r *http.Request, pay *payRT) (*wxpay.Notify, bool) {
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		notifyFail(w, 400, "读取回调报文体失败")
		return nil, false
	}
	n, err := pay.client.VerifyAndDecryptNotify(r.Header, body)
	if err != nil {
		log.Printf("WARN 微信支付回调验签/解密失败：%v", err)
		notifyFail(w, 401, "验签失败")
		return nil, false
	}
	return n, true
}

// ---------- GET /api/pay/status ----------

func handlePayStatus(w http.ResponseWriter, r *http.Request, st *store.Store, pay *payRT) {
	if r.Method != http.MethodGet {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	ident, ok := identityOf(w, r, st)
	if !ok {
		return
	}
	if ident.Phone == "" && ident.OpenID == "" && !ident.Admin {
		writeJSON(w, 400, map[string]string{"error": "缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token"})
		return
	}
	orderID := strings.TrimSpace(r.URL.Query().Get("orderId"))
	if orderID == "" {
		writeJSON(w, 400, map[string]string{"error": "缺少订单号 orderId"})
		return
	}
	o, err := st.GetOrder(orderID)
	if err != nil {
		writeErr(w, err)
		return
	}
	if !ident.Admin && !orderBelongsTo(o, ident) {
		writeJSON(w, 404, map[string]string{"error": "订单不存在"})
		return
	}
	now := time.Now().Unix()
	// 本地未付 + 距上次查单 >30 秒 → 主动查单兜底落库。
	// 查单失败**绝不 500**：如实返回本地状态（顾客端下次再查、回调也会来）。
	if !o.Paid && pay.ready() && pay.allowQuery(o.ID, now) {
		if ts, qerr := pay.client.QueryOrder(r.Context(), o.ID); qerr != nil {
			log.Printf("WARN 订单 %s 主动查单失败（按本地状态返回）：%v", o.ID, qerr)
		} else if ts != nil && ts.TradeState == "SUCCESS" {
			if got, want := ts.AmountFen, amountFen(o.Total); got != want {
				log.Printf("WARN 订单 %s 查单金额不符：订单 %d 分，微信 %d 分", o.ID, want, got)
			} else if ts.TransactionID != "" {
				if err := st.MarkPaid(o.ID, ts.TransactionID, ts.SuccessTime); err == nil {
					o.Paid, o.TransactionID, o.PaidAt = true, ts.TransactionID, ts.SuccessTime
					log.Printf("订单 %s 查单兜底置为已收款（微信支付单号 %s）", o.ID, ts.TransactionID)
				} else {
					log.Printf("WARN 订单 %s 查单兜底落库失败：%v", o.ID, err)
				}
			}
		}
	}
	// 退款中且有退款单号 → 顺带查一次退款兜底。
	if o.RefundState == store.RefundStateProcessing && o.RefundID != "" && pay.ready() && pay.allowQueryRefund(o.ID, now) {
		if rs, qerr := pay.client.QueryRefund(r.Context(), "R"+o.ID); qerr != nil {
			log.Printf("WARN 订单 %s 退款查单失败（按本地状态返回）：%v", o.ID, qerr)
		} else if rs != nil {
			if err := st.MarkRefund(o.ID, rs.RefundID, refundStateOf(rs.State)); err == nil {
				o.RefundState = refundStateOf(rs.State)
				if rs.RefundID != "" {
					o.RefundID = rs.RefundID
				}
			}
		}
	}
	writeJSON(w, 200, map[string]any{
		"paid":          o.Paid,
		"status":        o.Status,
		"transactionId": o.TransactionID,
		"refundState":   o.RefundState,
		"expireAt":      o.PayExpireAt,
	})
}

// ---------- 已收款单取消 → 退款（§1.7）----------

// refundCancelledOrder 给「已收款但被取消」的单发起退款，返回非空的失败说明（"" 表示成功）。
//
// 关键：**退款失败绝不能影响取消**——订单此时已经是 cancelled，退不回来是钱的账，
// 不是订单的账。失败一律落成 refund_state='fail' + WARN 日志，并在响应里如实带出去，
// 后续由 refund-notify / pay/status 的 QueryRefund 兜底继续推进。
func refundCancelledOrder(ctx context.Context, st *store.Store, pay *payRT, o store.Order, reason string) string {
	outRefundNo := "R" + o.ID
	if !pay.ready() {
		_ = st.MarkRefund(o.ID, "", store.RefundStateFail)
		msg := "微信支付未配置，无法自动退款（请到微信商户平台手工退款）"
		log.Printf("WARN 订单 %s 已取消但无法退款：%s", o.ID, msg)
		return msg
	}
	total := amountFen(o.Total)
	rs, err := pay.client.Refund(ctx, o.ID, outRefundNo, total, total, reason)
	if err != nil {
		_ = st.MarkRefund(o.ID, "", store.RefundStateFail)
		log.Printf("WARN 订单 %s 已取消但退款请求失败：%v", o.ID, err)
		return "退款发起失败（订单已取消，请到商户平台手工退款）：" + err.Error()
	}
	state := refundStateOf(rs.State)
	if err := st.MarkRefund(o.ID, rs.RefundID, state); err != nil {
		log.Printf("WARN 订单 %s 退款已发起但状态落库失败：%v", o.ID, err)
		return "退款已发起但状态落库失败：" + err.Error()
	}
	log.Printf("订单 %s 已发起退款 %s（%d 分，状态 %s）", o.ID, outRefundNo, total, state)
	return ""
}

// ---------- 超时未付扫单（§1.6）----------

// DefaultSweepInterval 扫单间隔默认 60 秒。
const DefaultSweepInterval = 60 * time.Second

// sweepInterval 扫单间隔：默认 60s。
//
// 环境变量 PAY_SWEEP_INTERVAL 支持 "1s" / "500ms" 这类写法，**仅为端到端验收**
// （deploy/accept-pay.js 把 15 分钟压成几秒）；解析失败或非正数一律回退默认值，绝不 panic。
func sweepInterval() time.Duration {
	v := strings.TrimSpace(os.Getenv("PAY_SWEEP_INTERVAL"))
	if v == "" {
		return DefaultSweepInterval
	}
	d, err := time.ParseDuration(v)
	if err != nil || d <= 0 {
		return DefaultSweepInterval
	}
	return d
}

// sweepExpiredOrders 起一个 goroutine 定时扫单，ctx 结束就退出（容器优雅退出的要求）。
//
// 支付没开通（pay == nil / 未就绪）时**每轮直接跳过**，这是「未开通就不开未付倒计时」
// （见 store.NewOrderInput.PayWindow）之外的第二道保险：即使库里残留了 pay_expire_at>0
// 的老单，也不会在支付不可用的时候把正常订单误杀。
//
// 多副本/双容器同时跑是安全的：见 store.CancelExpiredUnpaid 的注释——
// 候选条件是「未付 + 待付款 + 已过期」，取消动作是 `WHERE paid=0 AND status='pending'`
// 的条件更新 + 同一事务内回补库存，两个进程同时扫到同一张单时只有一个能把
// RowsAffected 拿到 1，另一个拿 0 直接跳过：库存只回补一次、stock_log 只写一条。
func sweepExpiredOrders(ctx context.Context, st *store.Store, pay *payRT) {
	iv := sweepInterval()
	log.Printf("超时未付扫单已启动（间隔 %s，单次上限 50 单，未付有效期 %d 秒）", iv, store.PayExpireSeconds())
	t := time.NewTicker(iv)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Printf("超时未付扫单已停止")
			return
		case <-t.C:
			if pay == nil || !pay.ready() {
				continue
			}
			n, err := st.CancelExpiredUnpaid(time.Now().Unix(), 50)
			if err != nil {
				log.Printf("WARN 超时未付扫单失败：%v", err)
				continue
			}
			if n > 0 {
				log.Printf("超时未付自动取消 %d 单（已回补库存并写 pay_timeout 流水）", n)
			}
		}
	}
}

// parseOptionalJSON 解析可选请求体：空 body / 非法 JSON 都不算错误（mark-paid 的 note 是可选的）。
func parseOptionalJSON(r *http.Request, v any) {
	if r.Body == nil {
		return
	}
	defer r.Body.Close()
	_ = json.NewDecoder(io.LimitReader(r.Body, 1<<20)).Decode(v)
}

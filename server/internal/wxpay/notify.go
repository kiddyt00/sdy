// 回调验签与解密（§1.5 的 /api/pay/notify 与 /api/pay/refund-notify 共用）。
package wxpay

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// notifyTimestampTolerance 回调时间戳允许的时钟偏差。
// 超出即视为陈旧/重放请求直接拒绝；微信重试会带新的时间戳，因此不会影响正常回调。
const notifyTimestampTolerance = 5 * time.Minute

// Notify 解密后的回调业务字段。
//
// 说明：MchID / AppID 是在冻结字段之外**新增**的两个只读字段——§1.5 要求回调里校验
// mchid 与 appid，但原结构体没有承载它们的字段，调用方无从校验。新增字段不影响任何
// 既有字段的取值与签名。
type Notify struct {
	EventType     string // TRANSACTION.SUCCESS / REFUND.SUCCESS / REFUND.ABNORMAL / REFUND.CLOSED
	OutTradeNo    string // 支付事件：订单号
	TransactionID string // 支付事件：微信支付单号
	TradeState    string // 支付事件：SUCCESS
	SuccessTime   string // RFC3339
	OutRefundNo   string // 退款事件：退款单号（R+订单号）
	RefundID      string // 退款事件：微信退款单号
	RefundState   string // 退款事件：SUCCESS / ABNORMAL / CLOSED
	AmountFen     int64  // 支付事件取 amount.total；退款事件取 amount.refund（整数分）
	MchID         string // 新增字段：商户号（§1.5 要求校验）
	AppID         string // 新增字段：小程序 AppID（§1.5 要求校验）
}

// notifyEnvelope 回调报文的公共外壳。
type notifyEnvelope struct {
	ID           string `json:"id"`
	EventType    string `json:"event_type"`
	ResourceType string `json:"resource_type"`
	Resource     struct {
		Algorithm      string `json:"algorithm"`
		Ciphertext     string `json:"ciphertext"`
		Nonce          string `json:"nonce"`
		AssociatedData string `json:"associated_data"`
	} `json:"resource"`
}

// VerifyAndDecryptNotify 回调主流程：校验时间戳新鲜度 → 验签（平台公钥 + Wechatpay-* 头）
// → AES-256-GCM 解密 → 按 event_type 填 Notify。
//
// 说明：当前只支持单平台证书——Wechatpay-Serial 仅作记录不参与校验（换成 /
// 追加第二把平台证书时，需要在 Load 里支持多证书并在此按序列号选钥）。
// 任何一步失败都返回可读错误（调用方回 4xx 让微信重试，绝不 panic）。
func (cl *Client) VerifyAndDecryptNotify(headers http.Header, body []byte) (*Notify, error) {
	if cl == nil || cl.plat == nil || cl.cfg.APIv3Key == "" {
		return nil, fmt.Errorf("%w", ErrNotConfigured)
	}
	if headers == nil {
		return nil, errors.New("回调缺少 HTTP 头")
	}
	if len(body) == 0 {
		return nil, errors.New("回调报文体为空")
	}
	timestamp := headers.Get("Wechatpay-Timestamp")
	nonce := headers.Get("Wechatpay-Nonce")
	signature := headers.Get("Wechatpay-Signature")
	if timestamp == "" || nonce == "" || signature == "" {
		return nil, errors.New("回调缺少 Wechatpay-Timestamp / Wechatpay-Nonce / Wechatpay-Signature 头")
	}
	// 时间戳新鲜度：必须是整数秒，且与当前时间相差不超过 notifyTimestampTolerance。
	// 先挡陈旧请求（重放），再做验签——成本更低，且验签失败的老报文本来也该丢。
	ts, err := strconv.ParseInt(timestamp, 10, 64)
	if err != nil {
		return nil, fmt.Errorf("回调时间戳不合法（Wechatpay-Timestamp=%q 不是整数秒）：%w", timestamp, err)
	}
	drift := time.Since(time.Unix(ts, 0))
	if drift > notifyTimestampTolerance || drift < -notifyTimestampTolerance {
		return nil, fmt.Errorf("回调时间戳过期（Wechatpay-Timestamp=%s 与当前时间相差 %s，超过 %s，疑似重放）",
			timestamp, drift.Round(time.Second), notifyTimestampTolerance)
	}
	// Wechatpay-Serial 只做记录：本项目只配一把平台密钥。
	_ = headers.Get("Wechatpay-Serial")
	message := timestamp + "\n" + nonce + "\n" + string(body) + "\n"
	if err := verifySHA256(cl.plat, message, signature); err != nil {
		return nil, fmt.Errorf("回调验签失败（签名与平台证书不匹配）：%w", err)
	}

	var env notifyEnvelope
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, fmt.Errorf("解析回调报文失败：%w", err)
	}
	if env.Resource.Ciphertext == "" {
		return nil, errors.New("回调报文缺少 resource.ciphertext")
	}
	plain, err := aesGCMDecrypt(cl.cfg.APIv3Key, env.Resource.Nonce, env.Resource.AssociatedData, env.Resource.Ciphertext)
	if err != nil {
		return nil, err
	}
	return parseNotify(env.EventType, plain)
}

// parseNotify 按 event_type 把解密后的明文映射成 Notify。
func parseNotify(eventType string, plain []byte) (*Notify, error) {
	switch eventType {
	case "TRANSACTION.SUCCESS":
		var d struct {
			MchID         string `json:"mchid"`
			AppID         string `json:"appid"`
			OutTradeNo    string `json:"out_trade_no"`
			TransactionID string `json:"transaction_id"`
			TradeState    string `json:"trade_state"`
			SuccessTime   string `json:"success_time"`
			Amount        struct {
				Total int64 `json:"total"`
			} `json:"amount"`
		}
		if err := json.Unmarshal(plain, &d); err != nil {
			return nil, fmt.Errorf("解析支付回调明文失败：%w", err)
		}
		return &Notify{
			EventType:     eventType,
			OutTradeNo:    d.OutTradeNo,
			TransactionID: d.TransactionID,
			TradeState:    d.TradeState,
			SuccessTime:   d.SuccessTime,
			AmountFen:     d.Amount.Total,
			MchID:         d.MchID,
			AppID:         d.AppID,
		}, nil
	case "REFUND.SUCCESS", "REFUND.ABNORMAL", "REFUND.CLOSED":
		var d struct {
			MchID        string `json:"mchid"`
			OutRefundNo  string `json:"out_refund_no"`
			RefundID     string `json:"refund_id"`
			RefundStatus string `json:"refund_status"`
			SuccessTime  string `json:"success_time"`
			Amount       struct {
				Refund int64 `json:"refund"`
			} `json:"amount"`
		}
		if err := json.Unmarshal(plain, &d); err != nil {
			return nil, fmt.Errorf("解析退款回调明文失败：%w", err)
		}
		return &Notify{
			EventType:   eventType,
			OutRefundNo: d.OutRefundNo,
			RefundID:    d.RefundID,
			RefundState: d.RefundStatus,
			SuccessTime: d.SuccessTime,
			AmountFen:   d.Amount.Refund,
			MchID:       d.MchID,
		}, nil
	default:
		return nil, fmt.Errorf("不支持的微信支付回调事件类型：%q", eventType)
	}
}

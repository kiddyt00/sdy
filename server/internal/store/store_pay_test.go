package store

// 支付轮微信支付的 store 层单测：新列默认值 / 付款落库幂等与支付单号冲突 /
// 跨端补 openid / 超时扫单（含库存回补与流水）/ paid 过滤 / 老库升级与一次性回填。
// 全部用内存库（升级用例用临时文件库），不碰任何真实数据，也不需要任何微信证书。

import (
	"database/sql"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

// payOrder 下一张「支付已开通」时的单（§1.4：新单 paid=0、pay_expire_at=下单时刻+900）。
// PayWindow=true 就是 HTTP 层在 pay 就绪时传的值；支付未开通时的语义另有用例覆盖。
func payOrder(t *testing.T, st *Store, phone, openid string) Order {
	t.Helper()
	o, err := st.CreateOrder(NewOrderInput{
		CustomerName: "张三", Phone: phone, DeliveryType: "pickup", OpenID: openid,
		PayWindow: true,
		Items:     []NewOrderInputItem{{Code: "6901", Qty: 2}},
	})
	if err != nil {
		t.Fatalf("下单失败: %v", err)
	}
	return o
}

// forceExpire 把某单的付款截止时刻改成过去（模拟 15 分钟到期），payExpireAt=0 表示不改。
func forceExpire(t *testing.T, st *Store, id string, unix int64) {
	t.Helper()
	if _, err := st.DB().Exec(`UPDATE orders SET pay_expire_at=? WHERE id=?`, unix, id); err != nil {
		t.Fatalf("改写付款截止时刻失败: %v", err)
	}
}

// TestPayOrderDefaultsAndJSON 新单的支付列默认值 + openid 绝不进 JSON（§1.4 红线）。
func TestPayOrderDefaultsAndJSON(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	before := time.Now().Unix()
	o := payOrder(t, st, "13800001111", "o_customer")

	if o.Paid || o.PaidAt != "" || o.TransactionID != "" || o.RefundID != "" || o.RefundState != "" {
		t.Errorf("新单支付列应为空值，实际 %+v", o)
	}
	// 15 分钟倒计时：服务端自己算，不信前端（PAY_EXPIRE_SECONDS 覆盖见 main 层用例）。
	if o.PayExpireAt < before+DefaultPayExpireSeconds || o.PayExpireAt > time.Now().Unix()+DefaultPayExpireSeconds {
		t.Errorf("pay_expire_at 期望约 now+%d，实际 %d（now=%d）", DefaultPayExpireSeconds, o.PayExpireAt, before)
	}
	raw, err := json.Marshal(o)
	if err != nil {
		t.Fatalf("序列化订单失败: %v", err)
	}
	if strings.Contains(string(raw), "openid") {
		t.Errorf("openid 是服务端内部字段，绝不能进 JSON：%s", raw)
	}
	if !strings.Contains(string(raw), `"paid":false`) || !strings.Contains(string(raw), `"payExpireAt":`) {
		t.Errorf("支付字段应以 paid/payExpireAt 出现在 JSON 里：%s", raw)
	}
	// 库里也确实是默认值（不是只在结构体上填了零值）。
	var paid int
	var prepay, txn, refund string
	if err := st.DB().QueryRow(`SELECT paid, prepay_id, transaction_id, refund_state FROM orders WHERE id=?`, o.ID).
		Scan(&paid, &prepay, &txn, &refund); err != nil {
		t.Fatalf("读支付列失败: %v", err)
	}
	if paid != 0 || prepay != "" || txn != "" || refund != "" {
		t.Errorf("新单库里应 paid=0 且支付字段为空，实际 paid=%d prepay=%q txn=%q refund=%q", paid, prepay, txn, refund)
	}
}

// TestPayMarkPaidIdempotentAndConflict 付款落库：幂等、不覆盖、不 panic。
func TestPayMarkPaidIdempotentAndConflict(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	a := payOrder(t, st, "13800001111", "o_a")
	b := payOrder(t, st, "13800002222", "o_b")

	if err := st.MarkPaid(a.ID, "WX_TXN_1", "2026-11-01T10:00:00+08:00"); err != nil {
		t.Fatalf("标记已收款失败: %v", err)
	}
	got, err := st.GetOrder(a.ID)
	if err != nil {
		t.Fatalf("读订单失败: %v", err)
	}
	if !got.Paid || got.TransactionID != "WX_TXN_1" || got.PaidAt != "2026-11-01T10:00:00+08:00" {
		t.Errorf("付款字段没落库：%+v", got)
	}

	// ① 同一个 transaction_id 重复回调 → 成功且一个字段都不改（幂等）。
	if err := st.MarkPaid(a.ID, "WX_TXN_1", "2027-01-01T00:00:00+08:00"); err != nil {
		t.Fatalf("重复回调应幂等成功，实际 %v", err)
	}
	again, _ := st.GetOrder(a.ID)
	if again.PaidAt != got.PaidAt || again.TransactionID != got.TransactionID {
		t.Errorf("重复回调不该改数据：%+v", again)
	}

	// ② 已付款的单换个支付单号 → 冲突（绝不覆盖已有付款记录）。
	if err := st.MarkPaid(a.ID, "WX_TXN_OTHER", ""); !errors.Is(err, ErrConflict) {
		t.Errorf("换支付单号期望 ErrConflict，实际 %v", err)
	}

	// ③ 别的订单抢同一个 transaction_id → ErrConflict 且不 panic（唯一索引兜底）。
	if err := st.MarkPaid(b.ID, "WX_TXN_1", ""); !errors.Is(err, ErrConflict) {
		t.Fatalf("支付单号被占用期望 ErrConflict，实际 %v", err)
	}
	stillB, _ := st.GetOrder(b.ID)
	if stillB.Paid || stillB.TransactionID != "" {
		t.Errorf("冲突时不得改动 B 单：%+v", stillB)
	}

	// ④ 不存在的单 → ErrNotFound。
	if err := st.MarkPaid("M_NOPE", "WX_TXN_9", ""); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在的订单期望 ErrNotFound，实际 %v", err)
	}

	// ⑤ 现金标记（transaction_id 为空）可以给多张单用——空串不参与唯一索引。
	if err := st.MarkPaid(b.ID, "", ""); err != nil {
		t.Fatalf("现金标记失败: %v", err)
	}
	c := payOrder(t, st, "13800003333", "o_c")
	if err := st.MarkPaid(c.ID, "", ""); err != nil {
		t.Fatalf("第二张现金标记失败（空支付单号不该撞唯一索引）: %v", err)
	}
}

// TestPayAttachOpenIDOnlyWhenEmpty 跨端补 openid：只在订单 openid 为空时写。
func TestPayAttachOpenIDOnlyWhenEmpty(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	web := payOrder(t, st, "13800001111", "") // 网页下单：没有 openid

	if err := st.AttachOpenID(web.ID, "o_first"); err != nil {
		t.Fatalf("补写 openid 失败: %v", err)
	}
	if _, _, openid, err := st.GetOrderPrepay(web.ID); err != nil || openid != "o_first" {
		t.Fatalf("补写后应读到 o_first，实际 %q err=%v", openid, err)
	}
	// 已有 openid → 一行不改（顾客 A 的微信绝不能写到已绑定的单上）。
	if err := st.AttachOpenID(web.ID, "o_second"); err != nil {
		t.Fatalf("重复补写不该报错: %v", err)
	}
	if _, _, openid, _ := st.GetOrderPrepay(web.ID); openid != "o_first" {
		t.Errorf("已有 openid 时不该被覆盖，实际 %q", openid)
	}
	if err := st.AttachOpenID(web.ID, ""); !errors.Is(err, ErrBadInput) {
		t.Errorf("空 openid 期望 ErrBadInput，实际 %v", err)
	}
}

// TestPayPrepayAndRefundState prepay 缓存复用与退款状态机（幂等、不回退）。
func TestPayPrepayAndRefundState(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	o := payOrder(t, st, "13800001111", "o_a")
	deadline := time.Now().Unix() + 900

	if err := st.SetPrepay(o.ID, "prepay_1", deadline); err != nil {
		t.Fatalf("写 prepay 失败: %v", err)
	}
	prepayID, expireAt, openid, err := st.GetOrderPrepay(o.ID)
	if err != nil || prepayID != "prepay_1" || expireAt != deadline || openid != "o_a" {
		t.Fatalf("读 prepay 不符：%q %d %q err=%v", prepayID, expireAt, openid, err)
	}

	if err := st.MarkRefund(o.ID, "RF_1", RefundStateProcessing); err != nil {
		t.Fatalf("退款处理中失败: %v", err)
	}
	if err := st.MarkRefund(o.ID, "RF_1", RefundStateSuccess); err != nil {
		t.Fatalf("退款成功失败: %v", err)
	}
	r, _ := st.GetOrder(o.ID)
	if r.RefundID != "RF_1" || r.RefundState != RefundStateSuccess {
		t.Errorf("退款字段不对：%+v", r)
	}
	// 晚到的 PROCESSING 不能把 success 改回处理中（回调顺序不保证）。
	if err := st.MarkRefund(o.ID, "", RefundStateProcessing); err != nil {
		t.Fatalf("晚到回调不该报错: %v", err)
	}
	if r2, _ := st.GetOrder(o.ID); r2.RefundState != RefundStateSuccess || r2.RefundID != "RF_1" {
		t.Errorf("success 不该回退、refund_id 不该被清空：%+v", r2)
	}
	// 失败态可写（退款调用失败要如实体现）；success 之后不回退，所以换一张单验。
	o2 := payOrder(t, st, "13800002222", "o_b")
	if err := st.MarkPaid(o2.ID, "WX_TXN_2", ""); err != nil {
		t.Fatalf("标记已收款失败: %v", err)
	}
	if err := st.MarkRefund(o2.ID, "", RefundStateFail); err != nil {
		t.Fatalf("写失败态失败: %v", err)
	}
	if r3, _ := st.GetOrder(o2.ID); r3.RefundState != RefundStateFail {
		t.Errorf("退款失败应落库，实际 %+v", r3)
	}
	if err := st.MarkRefund(o.ID, "", "processing; DROP TABLE orders"); !errors.Is(err, ErrBadInput) {
		t.Errorf("非法退款状态期望 ErrBadInput，实际 %v", err)
	}
	if err := st.MarkRefund("M_NOPE", "", RefundStateSuccess); !errors.Is(err, ErrNotFound) {
		t.Errorf("不存在的订单期望 ErrNotFound，实际 %v", err)
	}
}

// TestPayCancelExpiredUnpaid 超时扫单：到期才取消、回补库存写 pay_timeout 流水、重复扫不双补。
func TestPayCancelExpiredUnpaid(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	now := time.Now().Unix()

	expired := payOrder(t, st, "13800001111", "o_a")    // 到期未付
	fresh := payOrder(t, st, "13800002222", "o_b")      // 还没到期
	paidOne := payOrder(t, st, "13800003333", "o_c")    // 已付款（即便到期也不该被扫）
	noDeadline := payOrder(t, st, "13800004444", "o_d") // 老库回填的老单：pay_expire_at=0
	forceExpire(t, st, expired.ID, now-1)
	forceExpire(t, st, fresh.ID, now+600)
	forceExpire(t, st, paidOne.ID, now-1)
	forceExpire(t, st, noDeadline.ID, 0)
	if err := st.MarkPaid(paidOne.ID, "WX_TXN_1", ""); err != nil {
		t.Fatalf("标记已收款失败: %v", err)
	}
	stockBefore := stockOf(t, st, "6901") // 120 - 2*4 = 112

	n, err := st.CancelExpiredUnpaid(now, 50)
	if err != nil {
		t.Fatalf("扫单失败: %v", err)
	}
	if n != 1 {
		t.Fatalf("只该取消 1 单（到期的未付款单），实际 %d", n)
	}
	got, _ := st.GetOrder(expired.ID)
	if got.Status != pricing.StatusCancelled || got.Paid {
		t.Errorf("到期未付单应 cancelled 且仍未付款：%+v", got)
	}
	// 回补库存 + 流水（§1.6 要求 kind=pay_timeout、reason=超时未付自动取消）
	if s := stockOf(t, st, "6901"); s != stockBefore+2 {
		t.Errorf("库存应回补 2 件（%v→%v），实际 %v", stockBefore, stockBefore+2, s)
	}
	if c := countLogs(t, st, StockKindPayTimeout, "超时未付自动取消"); c != 1 {
		t.Errorf("pay_timeout 流水期望 1 条，实际 %d", c)
	}
	var loggedOrderID string
	if err := st.DB().QueryRow(`SELECT order_id FROM stock_log WHERE kind=? ORDER BY id DESC LIMIT 1`,
		StockKindPayTimeout).Scan(&loggedOrderID); err != nil {
		t.Fatalf("读流水 order_id 失败: %v", err)
	}
	if loggedOrderID != expired.ID {
		t.Errorf("流水 order_id 应回填 %s，实际 %q", expired.ID, loggedOrderID)
	}

	// 未到期 / 已付款 / pay_expire_at=0 的单一个都没动。
	if f, _ := st.GetOrder(fresh.ID); f.Status != pricing.StatusPending {
		t.Errorf("未到期的单不该被取消：%+v", f)
	}
	if p, _ := st.GetOrder(paidOne.ID); p.Status != pricing.StatusPending || !p.Paid {
		t.Errorf("已付款的单不该被扫：%+v", p)
	}
	if d, _ := st.GetOrder(noDeadline.ID); d.Status != pricing.StatusPending {
		t.Errorf("pay_expire_at=0（老单）不该被扫：%+v", d)
	}

	// 再扫一次：幂等，不重复取消、不重复回补（第 27 轮那个「回补两遍」的坑）。
	again, err := st.CancelExpiredUnpaid(now+10, 50)
	if err != nil {
		t.Fatalf("第二次扫单失败: %v", err)
	}
	if again != 0 {
		t.Errorf("第二次扫单应 0 单，实际 %d", again)
	}
	if s := stockOf(t, st, "6901"); s != stockBefore+2 {
		t.Errorf("重复扫单不得重复回补库存，期望 %v 实际 %v", stockBefore+2, s)
	}
	if c := countLogs(t, st, StockKindPayTimeout, "超时未付自动取消"); c != 1 {
		t.Errorf("重复扫单不得重复写流水，期望 1 条实际 %d", c)
	}
	// limit 生效：<=0 按 50 处理（不报错即可），limit=1 只取消 1 单。
	two := payOrder(t, st, "13800005555", "o_e")
	two2 := payOrder(t, st, "13800006666", "o_f")
	forceExpire(t, st, two.ID, now-2)
	forceExpire(t, st, two2.ID, now-3)
	if one, err := st.CancelExpiredUnpaid(now, 1); err != nil || one != 1 {
		t.Errorf("limit=1 应只取消 1 单，实际 %d err=%v", one, err)
	}
	if rest, err := st.CancelExpiredUnpaid(now, 0); err != nil || rest != 1 {
		t.Errorf("limit<=0 应回退 50 并扫掉剩下 1 单，实际 %d err=%v", rest, err)
	}
}

// TestPayOrderFilterPaid 后台「待付款 / 待备货」队列靠 paid 过滤（§1.5）。
func TestPayOrderFilterPaid(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)
	unpaid := payOrder(t, st, "13800001111", "o_a")
	paidOne := payOrder(t, st, "13800001111", "o_a")
	other := payOrder(t, st, "13800002222", "o_b")
	if err := st.MarkPaid(paidOne.ID, "WX_TXN_1", ""); err != nil {
		t.Fatalf("标记已收款失败: %v", err)
	}
	if err := st.MarkPaid(other.ID, "WX_TXN_2", ""); err != nil {
		t.Fatalf("标记已收款失败: %v", err)
	}

	list, total, err := st.ListOrdersFiltered(OrderFilter{Paid: "0"})
	if err != nil || total != 1 || len(list) != 1 || list[0].ID != unpaid.ID {
		t.Fatalf("paid=0 应只剩未付款那一单，实际 total=%d list=%+v err=%v", total, list, err)
	}
	list, total, err = st.ListOrdersFiltered(OrderFilter{Paid: "1"})
	if err != nil || total != 2 {
		t.Fatalf("paid=1 期望 2 单，实际 total=%d err=%v", total, err)
	}
	// 空值＝不过滤，老调用方行为不变。
	if _, total, err := st.ListOrdersFiltered(OrderFilter{}); err != nil || total != 3 {
		t.Fatalf("paid 为空应不过滤，实际 total=%d err=%v", total, err)
	}
	// 过滤与顾客归属叠加：顾客只能看到自己的单。
	if _, total, err := st.ListOrdersFiltered(OrderFilter{Paid: "1", Phone: "13800001111"}); err != nil || total != 1 {
		t.Fatalf("paid=1 + 手机号过滤期望 1 单，实际 total=%d err=%v", total, err)
	}
	if _, _, err := st.ListOrdersFiltered(OrderFilter{Paid: "yes"}); !errors.Is(err, ErrBadInput) {
		t.Errorf("非法 paid 期望 ErrBadInput，实际 %v", err)
	}
}

// TestPayMigratesPrePayDatabase 老库升级（0.9.0 上线路径）+ 一次性老单回填的回归锁。
//
// 真实风险：paid 列由 ALTER TABLE 补出来、默认 0。若不管老单，升级后「支付上线之前」的
// pending 老单会全变成未收款——后台「待备货」队列（只列已付款）把它们整批踢出，
// 顾客端还会显示「待付款」+ 倒计时。所以首次补列时必须把老单按已收款回填，
// 且只能跑一次（第二次 Open 一个字段都不许改）。
func TestPayMigratesPrePayDatabase(t *testing.T) {
	path := filepath.Join(t.TempDir(), "prepay.db")

	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatalf("打开老库失败: %v", err)
	}
	oldSchema := []string{
		`CREATE TABLE orders (
			id TEXT PRIMARY KEY,
			customer_name TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			address TEXT NOT NULL DEFAULT '',
			delivery_type TEXT NOT NULL DEFAULT 'pickup',
			subtotal REAL NOT NULL DEFAULT 0,
			delivery_fee REAL NOT NULL DEFAULT 0,
			total REAL NOT NULL DEFAULT 0,
			status TEXT NOT NULL DEFAULT 'pending',
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT ''
		)`,
		`CREATE TABLE wx_user (
			openid TEXT PRIMARY KEY,
			unionid TEXT NOT NULL DEFAULT '',
			phone TEXT NOT NULL DEFAULT '',
			nickname TEXT NOT NULL DEFAULT '',
			created_at TEXT NOT NULL DEFAULT '',
			updated_at TEXT NOT NULL DEFAULT '',
			last_login_at TEXT NOT NULL DEFAULT ''
		)`,
	}
	for _, s := range oldSchema {
		if _, err := db.Exec(s); err != nil {
			t.Fatalf("造老库失败: %v", err)
		}
	}
	// 老库里两种单：待备货的 pending（必须回填成已收款）与已取消的（不许回填）。
	if _, err := db.Exec(`INSERT INTO orders (id,customer_name,phone,total,status,created_at,updated_at)
		VALUES ('M_OLD_PENDING','老张','13800000000',12.5,'pending','2026-10-01 08:00:00','2026-10-01 08:00:00')`); err != nil {
		t.Fatalf("写老单失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO orders (id,customer_name,phone,total,status,created_at,updated_at)
		VALUES ('M_OLD_CANCELLED','老李','13800009999',8,'cancelled','2026-09-01 08:00:00','2026-09-01 09:00:00')`); err != nil {
		t.Fatalf("写老取消单失败: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO wx_user (openid,phone,nickname) VALUES ('o_old','13800000000','老张')`); err != nil {
		t.Fatalf("写老微信用户失败: %v", err)
	}
	if err := db.Close(); err != nil {
		t.Fatalf("关闭老库失败: %v", err)
	}

	st, err := Open(path, pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("老库升级失败: %v", err)
	}
	t.Cleanup(func() { st.Close() })

	// ① pending 老单：回填 paid=1，paid_at 用 created_at（不是 now，绝不污染「今日已收款」）。
	old, err := st.GetOrder("M_OLD_PENDING")
	if err != nil {
		t.Fatalf("升级后读老单失败: %v", err)
	}
	if !old.Paid {
		t.Errorf("支付上线前的 pending 老单必须回填为已收款，否则会被踢出备货队列：%+v", old)
	}
	if old.PaidAt != "2026-10-01 08:00:00" {
		t.Errorf("paid_at 应等于 created_at，实际 %q", old.PaidAt)
	}
	if old.PayExpireAt != 0 {
		t.Errorf("老单 pay_expire_at 必须保持 0（不参与超时扫单），实际 %d", old.PayExpireAt)
	}
	if old.TransactionID != "" {
		t.Errorf("老单不该有微信支付单号，实际 %q", old.TransactionID)
	}

	// ② 老库里已取消的单不回填（它不在备货队列里，也不该留收款痕迹）。
	cancelled, err := st.GetOrder("M_OLD_CANCELLED")
	if err != nil {
		t.Fatalf("升级后读老取消单失败: %v", err)
	}
	if cancelled.Paid {
		t.Errorf("已取消的老单不该被回填为已收款：%+v", cancelled)
	}

	// ③ 两个新索引齐备（老库靠 ALTER TABLE 才有列，索引必须建在 postMigrateStmts）。
	var idx int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='index' AND name IN ('idx_orders_transaction','idx_orders_pay_expire')`).
		Scan(&idx); err != nil {
		t.Fatalf("查索引失败: %v", err)
	}
	if idx != 2 {
		t.Errorf("期望 2 个新索引，实际 %d", idx)
	}
	// 多个「无支付单号」的已付款单能共存（部分唯一索引只约束非空值）。
	var n int
	if err := st.DB().QueryRow(`SELECT COUNT(*) FROM orders WHERE transaction_id=''`).Scan(&n); err != nil || n != 2 {
		t.Fatalf("空支付单号应可共存，实际 n=%d err=%v", n, err)
	}

	// ④ 升级后新建的单不受回填影响：paid=0、pay_expire_at>0。
	seed(t, st)
	fresh := payOrder(t, st, "13800001111", "o_new")
	if fresh.Paid || fresh.PayExpireAt <= time.Now().Unix() {
		t.Errorf("升级后的新单应 paid=0 且未到期：%+v", fresh)
	}

	// ⑤ 连跑两次迁移（模拟重启）：第二次不许改任何数据。
	st.Close()
	st2, err := Open(path, pricing.DefaultConfig())
	if err != nil {
		t.Fatalf("第二次打开（重启）失败: %v", err)
	}
	t.Cleanup(func() { st2.Close() })
	againFresh, err := st2.GetOrder(fresh.ID)
	if err != nil {
		t.Fatalf("重启后读新单失败: %v", err)
	}
	if againFresh.Paid || againFresh.PayExpireAt != fresh.PayExpireAt {
		t.Errorf("重启不该把当天未付款单刷成已付款：%+v（原 %+v）", againFresh, fresh)
	}
	if c2, _ := st2.GetOrder("M_OLD_CANCELLED"); c2.Paid {
		t.Errorf("重启后已取消的老单仍不该被回填：%+v", c2)
	}
	if o2, _ := st2.GetOrder("M_OLD_PENDING"); !o2.Paid || o2.PaidAt != "2026-10-01 08:00:00" {
		t.Errorf("重启不该改动已回填的老单：%+v", o2)
	}
}

// TestPayWindowNoCountdownWithoutPay 支付未开通时**不写未付倒计时**（支付轮修正）。
//
// 背景（必修缺陷）：pay 未就绪时 prepay 一律 503，顾客付不了款；若照样写下单时刻+900，
// §1.6 扫单 15 分钟后就会把正常订单自动取消并回补库存 → 老板备货队列恒空、店铺停摆。
func TestPayWindowNoCountdownWithoutPay(t *testing.T) {
	st := newTestStore(t)
	seed(t, st)

	// HTTP 层在 pay == nil / 未就绪时传的就是 PayWindow=false。
	o, err := st.CreateOrder(NewOrderInput{
		CustomerName: "张三", Phone: "13800001111", DeliveryType: "pickup",
		Items: []NewOrderInputItem{{Code: "6901", Qty: 2}},
	})
	if err != nil {
		t.Fatalf("下单失败: %v", err)
	}
	if o.PayExpireAt != 0 {
		t.Fatalf("支付未开通的单 pay_expire_at 必须是 0（不参与扫单），实际 %d", o.PayExpireAt)
	}

	// 时间推得再远也不会被扫单取消（候选条件要求 pay_expire_at>0）。
	n, err := st.CancelExpiredUnpaid(time.Now().Unix()+365*24*3600, 50)
	if err != nil {
		t.Fatalf("扫单失败: %v", err)
	}
	if n != 0 {
		t.Fatalf("支付未开通时不该取消任何单，实际取消 %d 单", n)
	}
	if got, _ := st.GetOrder(o.ID); got.Status != pricing.StatusPending || got.Paid {
		t.Errorf("支付未开通的单必须保持待付款：%+v", got)
	}

	// 对照组：PayWindow=true（支付就绪）才写倒计时。
	live := payOrder(t, st, "13800002222", "o_b")
	if live.PayExpireAt <= time.Now().Unix() {
		t.Errorf("支付就绪的单应有未付倒计时，实际 pay_expire_at=%d", live.PayExpireAt)
	}
}

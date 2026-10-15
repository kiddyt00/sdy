// 微信支付（支付轮 §1.4/§1.6）的数据层：付款落库、prepay 缓存、退款状态、超时扫单。
//
// 设计口径（§1.3）：订单金额列仍是 REAL 元（历史数据一个字节都不动），
// 所有跟支付打交道的金额都由调用方用 amountFen() 转成整数分后传进来，
// 这里不做任何浮点比较。
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

// 退款状态机的取值（§1.5：只允许这四个）。
const (
	RefundStateNone       = ""
	RefundStateProcessing = "processing"
	RefundStateSuccess    = "success"
	RefundStateFail       = "fail"
)

// ValidRefundState 校验退款状态是否合法。
func ValidRefundState(s string) bool {
	switch s {
	case RefundStateNone, RefundStateProcessing, RefundStateSuccess, RefundStateFail:
		return true
	}
	return false
}

// MarkPaid 把订单标记为已收款（幂等）。
//
// 幂等语义：
//   - 订单已 paid=1 且 transaction_id 相同 → 直接成功（微信重复回调走这条）；
//   - 订单已 paid=1 但 transaction_id 不同 → ErrConflict（绝不覆盖已有的付款记录）；
//   - transaction_id 已被**别的**订单占用 → ErrConflict（idx_orders_transaction 唯一索引兜底，
//     这里先查一次只是为了给出可读错误，不让 UNIQUE 冲突冒成 500/panic）。
//
// transactionID 允许为空（后台「标记已收款」的现金单没有微信支付单号）。
// 条件更新 `WHERE id=? AND paid=0` 保证两个并发回调只有一个能改到数据。
func (s *Store) MarkPaid(orderID, transactionID, paidAt string) error {
	orderID = strings.TrimSpace(orderID)
	transactionID = strings.TrimSpace(transactionID)
	if orderID == "" {
		return fmt.Errorf("%w: 缺少订单号", ErrBadInput)
	}
	if strings.TrimSpace(paidAt) == "" {
		paidAt = nowStr()
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer tx.Rollback()

	var paid int
	var curTxn string
	err = tx.QueryRow(`SELECT paid, transaction_id FROM orders WHERE id=?`, orderID).Scan(&paid, &curTxn)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: 订单 %s", ErrNotFound, orderID)
	}
	if err != nil {
		return err
	}
	if paid != 0 {
		if curTxn == transactionID {
			// 重复回调：数据一个字段都不改，直接成功。
			_ = tx.Rollback()
			return nil
		}
		return fmt.Errorf("%w: 订单 %s 已收款（微信支付单号 %q），不能再用 %q 覆盖",
			ErrConflict, orderID, curTxn, transactionID)
	}
	if transactionID != "" {
		var other string
		err := tx.QueryRow(`SELECT id FROM orders WHERE transaction_id=? AND id<>?`, transactionID, orderID).Scan(&other)
		if err == nil {
			return fmt.Errorf("%w: 微信支付单号 %s 已属于订单 %s", ErrConflict, transactionID, other)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return err
		}
	}
	res, err := tx.Exec(`UPDATE orders SET paid=1, paid_at=?, transaction_id=?, updated_at=?
		WHERE id=? AND paid=0`, paidAt, transactionID, nowStr(), orderID)
	if err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			return fmt.Errorf("%w: 微信支付单号 %s 已被占用", ErrConflict, transactionID)
		}
		return fmt.Errorf("标记已收款失败: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return fmt.Errorf("%w: 订单 %s 已收款", ErrConflict, orderID)
	}
	return tx.Commit()
}

// AttachOpenID 给「网页下单（openid 为空）」的订单补写 openid（§1.5 跨端补 openid）。
// 只在订单 openid 仍为空时写入，已有 openid 时一行不改 —— 重复调用幂等，
// 也不会把顾客 A 的 openid 写到已绑定的订单上。
func (s *Store) AttachOpenID(orderID, openid string) error {
	orderID = strings.TrimSpace(orderID)
	openid = strings.TrimSpace(openid)
	if orderID == "" || openid == "" {
		return fmt.Errorf("%w: 订单号与 openid 都不能为空", ErrBadInput)
	}
	if _, err := s.db.Exec(`UPDATE orders SET openid=?, updated_at=? WHERE id=? AND openid=''`,
		openid, nowStr(), orderID); err != nil {
		return fmt.Errorf("补写订单 openid 失败: %w", err)
	}
	return nil
}

// SetPrepay 缓存一次 JSAPI 下单得到的 prepay_id，并落定该单的付款截止时刻（Unix 秒）。
//
// expireAt 由调用方决定：老单（pay_expire_at=0）传「现在 + PayExpireSeconds()」给它一个窗口，
// 新单传建单时算好的截止时刻（**不要用 now+900 覆盖**，否则每次点「去支付」都会把倒计时重置）。
// 重复调用幂等：后写的 prepay_id 覆盖先写的（同一张单重开收银台是正常操作）。
func (s *Store) SetPrepay(orderID, prepayID string, expireAt int64) error {
	orderID = strings.TrimSpace(orderID)
	prepayID = strings.TrimSpace(prepayID)
	if orderID == "" {
		return fmt.Errorf("%w: 缺少订单号", ErrBadInput)
	}
	res, err := s.db.Exec(`UPDATE orders SET prepay_id=?, pay_expire_at=?, updated_at=? WHERE id=?`,
		prepayID, expireAt, nowStr(), orderID)
	if err != nil {
		return fmt.Errorf("写入 prepay_id 失败: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return fmt.Errorf("%w: 订单 %s", ErrNotFound, orderID)
	}
	return nil
}

// GetOrderPrepay 读订单的 prepay 缓存与付款截止时刻。
// 返回的 openid 只给服务端自己用（决定要不要跨端补 openid、以及 prepay 的 payer），
// 绝不进任何 HTTP 响应体。
func (s *Store) GetOrderPrepay(orderID string) (prepayID string, expireAt int64, openid string, err error) {
	orderID = strings.TrimSpace(orderID)
	if orderID == "" {
		return "", 0, "", fmt.Errorf("%w: 缺少订单号", ErrBadInput)
	}
	err = s.db.QueryRow(`SELECT prepay_id, pay_expire_at, openid FROM orders WHERE id=?`, orderID).
		Scan(&prepayID, &expireAt, &openid)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, "", fmt.Errorf("%w: 订单 %s", ErrNotFound, orderID)
	}
	if err != nil {
		return "", 0, "", err
	}
	return prepayID, expireAt, openid, nil
}

// MarkRefund 更新退款状态（幂等）。
//
//   - state 只允许 "" / processing / success / fail，其它值返回 ErrBadInput；
//   - refund_id 只在非空时写入（重复回调/查单回填都写同一个值，天然幂等）；
//   - 已经是 success 的单**不回退**（微信回调顺序不保证，晚到的 PROCESSING 不能把成功改回处理中）；
//   - refund_at 只在首次变成 success 时落一次。
func (s *Store) MarkRefund(orderID, refundID, state string) error {
	orderID = strings.TrimSpace(orderID)
	refundID = strings.TrimSpace(refundID)
	state = strings.TrimSpace(state)
	if orderID == "" {
		return fmt.Errorf("%w: 缺少订单号", ErrBadInput)
	}
	if !ValidRefundState(state) {
		return fmt.Errorf("%w: 退款状态只能是 '' / processing / success / fail", ErrBadInput)
	}
	now := nowStr()
	refundAt := ""
	if state == RefundStateSuccess {
		refundAt = now
	}
	res, err := s.db.Exec(`UPDATE orders SET
			refund_id    = CASE WHEN ?<>'' THEN ? ELSE refund_id END,
			refund_state = CASE WHEN refund_state='success' AND ?<>'success' THEN refund_state ELSE ? END,
			refund_at    = CASE WHEN ?<>'' AND refund_at='' THEN ? ELSE refund_at END,
			updated_at   = ?
		WHERE id=?`, refundID, refundID, state, state, refundAt, refundAt, now, orderID)
	if err != nil {
		return fmt.Errorf("更新退款状态失败: %w", err)
	}
	if n, err := res.RowsAffected(); err != nil {
		return err
	} else if n == 0 {
		return fmt.Errorf("%w: 订单 %s", ErrNotFound, orderID)
	}
	return nil
}

// CancelExpiredUnpaid 超时未付自动取消（§1.6），返回真正取消掉的单数。
//
// 一个事务里做三件事：挑候选（paid=0 且 status=pending 且 pay_expire_at>0 且已到期）
// → 逐单回补库存并写 stock_log(kind=pay_timeout) → 条件更新 status=cancelled。
//
// 幂等与并发安全（双容器/多副本同时跑也安全）：
//   - 候选条件是 `paid=0 AND status='pending' AND pay_expire_at<=?`，取消后 status 变成
//     cancelled、付款后 paid 变成 1，两个条件都不再成立 → 同一个单不会被扫第二次；
//   - 真正落库用 `UPDATE ... WHERE id=? AND paid=0 AND status='pending'`（条件更新），
//     即便两个进程同时读到同一批候选，也只有一个能把 status 改成 cancelled，另一个
//     RowsAffected=0；SQLite 的写事务 + busy_timeout 保证两者串行，不会双写；
//   - 库是本地 SQLite 文件：跨容器共享同一个卷，写事务互斥，不存在「各写一份」。
//
// limit<=0 时按 50 处理。nowUnix 由调用方传入（便于测试与「同一时刻」语义）。
func (s *Store) CancelExpiredUnpaid(nowUnix int64, limit int) (int, error) {
	if limit <= 0 {
		limit = 50
	}
	tx, err := s.db.Begin()
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()

	rows, err := tx.Query(`SELECT id FROM orders
		WHERE paid=0 AND status=? AND pay_expire_at>0 AND pay_expire_at<=?
		ORDER BY pay_expire_at, id LIMIT ?`, pricing.StatusPending, nowUnix, limit)
	if err != nil {
		return 0, fmt.Errorf("查询超时未付订单失败: %w", err)
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return 0, err
	}

	now := nowStr()
	cancelled := 0
	for _, id := range ids {
		// 先做条件更新把单「占住」，再回补库存：两步同一个事务，
		// 命中 0 行说明这单已被别人付款/取消/推进，这次直接放过——
		// 绝不能先回补再发现没占住（那会把库存补两遍）。
		res, err := tx.Exec(`UPDATE orders SET status=?, updated_at=? WHERE id=? AND paid=0 AND status=?`,
			pricing.StatusCancelled, now, id, pricing.StatusPending)
		if err != nil {
			return cancelled, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return cancelled, err
		}
		if n == 0 {
			continue
		}
		if err := s.restoreStockTx(tx, id, "系统", now, StockKindPayTimeout, "超时未付自动取消"); err != nil {
			return cancelled, err
		}
		cancelled++
	}
	if err := tx.Commit(); err != nil {
		return 0, err
	}
	return cancelled, nil
}

// restoreStockTx 在事务内按订单明细回补库存并逐行写流水。
// kind/reason 由调用方给（超时扫单用 pay_timeout）。
// 商品已删除 / 并发删除时走 logLostReturn：写一条 delta=0 的异常流水 + WARN，不失败。
func (s *Store) restoreStockTx(tx *sql.Tx, orderID, operator, at, kind, reason string) error {
	rows, err := tx.Query(`SELECT code,name,qty FROM order_item WHERE order_id=? ORDER BY code`, orderID)
	if err != nil {
		return fmt.Errorf("查询订单明细失败: %w", err)
	}
	type line struct {
		code, name string
		qty        float64
	}
	var lines []line
	for rows.Next() {
		var l line
		if err := rows.Scan(&l.code, &l.name, &l.qty); err != nil {
			rows.Close()
			return err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	for _, l := range lines {
		var before float64
		var unit string
		err := tx.QueryRow(`SELECT stock,unit FROM product WHERE code=?`, l.code).Scan(&before, &unit)
		if errors.Is(err, sql.ErrNoRows) {
			s.logLostReturn(tx, orderID, l.code, l.name, "", l.qty, operator, at, "商品已删除，未回补")
			continue
		}
		if err != nil {
			return err
		}
		res, err := tx.Exec(`UPDATE product SET stock=stock+?, sync_status='pending', updated_at=? WHERE code=?`,
			l.qty, at, l.code)
		if err != nil {
			return err
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			s.logLostReturn(tx, orderID, l.code, l.name, unit, l.qty, operator, at, "商品已删除，未回补")
			continue
		}
		if _, err := tx.Exec(`INSERT INTO stock_log
			(at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			time.Now().UnixMilli(), at, kind, l.code, l.name, unit,
			l.qty, before, before+l.qty, reason, operator, orderID); err != nil {
			return fmt.Errorf("写入库存回补流水失败: %w", err)
		}
	}
	return nil
}

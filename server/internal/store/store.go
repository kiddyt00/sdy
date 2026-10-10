// Package store 提供 SQLite 数据访问层（M4）。
// 数据模型对齐《开发计划》M4：product / barcode_lib / customer / orders / order_item / sync_batch。
package store

import (
	"database/sql"
	"errors"
	"fmt"
	"math"
	"time"

	_ "modernc.org/sqlite" // 纯 Go 驱动，CGO_ENABLED=0 可静态编译

	"github.com/kiddyt00/sdy/server/internal/pricing"
)

// 领域错误：调用方用 errors.Is 判断，映射到 HTTP 状态码。
var (
	ErrNotFound  = errors.New("资源不存在")
	ErrConflict  = errors.New("状态冲突")
	ErrBadInput  = errors.New("参数不合法")
	ErrStockLess = errors.New("库存不足")
)

// Product 商品档案层（还包含经营数据：进价、售价、库存、比价参考价）。
type Product struct {
	Code        string  `json:"code"`
	Name        string  `json:"name"`
	Brand       string  `json:"brand,omitempty"`
	Spec        string  `json:"spec,omitempty"`
	Category    string  `json:"category,omitempty"`
	Img         string  `json:"img,omitempty"`
	CostPrice   float64 `json:"costPrice"`
	SalePrice   float64 `json:"salePrice"`
	RefPrice    float64 `json:"refPrice,omitempty"` // 牵牛花参考价（比价防线基线）
	Unit        string  `json:"unit,omitempty"`
	Stock       float64 `json:"stock"`
	IsWholesale bool    `json:"isWholesale,omitempty"`
	SyncStatus  string  `json:"syncStatus,omitempty"` // synced / pending
	CreatedAt   string  `json:"createdAt,omitempty"`
	UpdatedAt   string  `json:"updatedAt,omitempty"`
}

// LibEntry 条码字典层：任何扫码先命中这里；命中即不再调云端（D6）。
type LibEntry struct {
	Code      string `json:"code"`
	Name      string `json:"name"`
	Spec      string `json:"spec,omitempty"`
	Source    string `json:"source"` // product / lib / cloud
	Status    string `json:"status"` // found / not_found
	Hits      int    `json:"hits"`
	ExpiresAt string `json:"expiresAt,omitempty"` // not_found 标记 TTL（默认 90 天）
	UpdatedAt string `json:"updatedAt,omitempty"`
}

// OrderItem 订单行。
type OrderItem struct {
	Code  string  `json:"code"`
	Name  string  `json:"name"`
	Price float64 `json:"price"`
	Qty   float64 `json:"qty"`
}

// Order 订单（状态机：pending → delivering / ready → done；pending → cancelled）。
type Order struct {
	ID           string      `json:"id"`
	CustomerName string      `json:"customerName"`
	Phone        string      `json:"phone"`
	Address      string      `json:"address,omitempty"`
	DeliveryType string      `json:"deliveryType"` // pickup / delivery
	Subtotal     float64     `json:"subtotal"`
	DeliveryFee  float64     `json:"deliveryFee"`
	Total        float64     `json:"total"`
	Status       string      `json:"status"`
	Items        []OrderItem `json:"items"`
	CreatedAt    string      `json:"createdAt"`
	UpdatedAt    string      `json:"updatedAt,omitempty"`
}

// NewOrderInput 下单入参（只带条码与数量，价格与库存一律以服务端为准）。
type NewOrderInput struct {
	CustomerName string              `json:"customerName"`
	Phone        string              `json:"phone"`
	Address      string              `json:"address"`
	DeliveryType string              `json:"deliveryType"`
	Items        []NewOrderInputItem `json:"items"`
}

// NewOrderInputItem 下单行入参。
type NewOrderInputItem struct {
	Code string  `json:"code"`
	Qty  float64 `json:"qty"`
}

// Store 数据访问对象。
type Store struct {
	db  *sql.DB
	cfg pricing.Config
}

var schemaStmts = []string{
	`CREATE TABLE IF NOT EXISTS product (
		code TEXT PRIMARY KEY,
		name TEXT NOT NULL DEFAULT '',
		brand TEXT NOT NULL DEFAULT '',
		spec TEXT NOT NULL DEFAULT '',
		category TEXT NOT NULL DEFAULT '',
		img TEXT NOT NULL DEFAULT '',
		cost_price REAL NOT NULL DEFAULT 0,
		sale_price REAL NOT NULL DEFAULT 0,
		ref_price REAL NOT NULL DEFAULT 0,
		unit TEXT NOT NULL DEFAULT '',
		stock REAL NOT NULL DEFAULT 0,
		is_wholesale INTEGER NOT NULL DEFAULT 0,
		sync_status TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS barcode_lib (
		code TEXT PRIMARY KEY,
		name TEXT NOT NULL DEFAULT '',
		spec TEXT NOT NULL DEFAULT '',
		source TEXT NOT NULL DEFAULT 'lib',
		status TEXT NOT NULL DEFAULT 'found',
		hits INTEGER NOT NULL DEFAULT 0,
		expires_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS customer (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		phone TEXT NOT NULL UNIQUE,
		name TEXT NOT NULL DEFAULT '',
		tags TEXT NOT NULL DEFAULT '',
		note TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS orders (
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
	`CREATE TABLE IF NOT EXISTS order_item (
		order_id TEXT NOT NULL,
		code TEXT NOT NULL,
		name TEXT NOT NULL DEFAULT '',
		price REAL NOT NULL DEFAULT 0,
		qty REAL NOT NULL DEFAULT 0,
		PRIMARY KEY (order_id, code)
	)`,
	`CREATE TABLE IF NOT EXISTS sync_batch (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		kind TEXT NOT NULL DEFAULT '',
		filename TEXT NOT NULL DEFAULT '',
		total INTEGER NOT NULL DEFAULT 0,
		ok INTEGER NOT NULL DEFAULT 0,
		diff INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT ''
	)`,
}

// Open 打开（或创建）数据库并建表。
func Open(path string, cfg pricing.Config) (*Store, error) {
	dsn := path
	if path != ":memory:" {
		dsn = path + "?_pragma=busy_timeout(5000)&_pragma=journal_mode(WAL)&_pragma=foreign_keys(1)"
	}
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开数据库失败: %w", err)
	}
	if path == ":memory:" {
		// 内存库需限制连接数，避免每个连接看到不同的库
		db.SetMaxOpenConns(1)
	}
	s := &Store{db: db, cfg: cfg}
	for _, stmt := range schemaStmts {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("建表失败: %w", err)
		}
	}
	return s, nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

// DB 暴露底层连接（仅供测试与迁移使用）。
func (s *Store) DB() *sql.DB { return s.db }

func nowStr() string { return time.Now().Format(time.RFC3339) }

/* ------------------------------ 商品 ------------------------------ */

// UpsertProduct 新增或覆盖商品档案。
func (s *Store) UpsertProduct(p Product) (Product, error) {
	if p.Code == "" {
		return Product{}, fmt.Errorf("%w: 条码不能为空", ErrBadInput)
	}
	if p.CreatedAt == "" {
		p.CreatedAt = nowStr()
	}
	p.UpdatedAt = nowStr()
	_, err := s.db.Exec(`INSERT INTO product
		(code,name,brand,spec,category,img,cost_price,sale_price,ref_price,unit,stock,is_wholesale,sync_status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
		ON CONFLICT(code) DO UPDATE SET
			name=excluded.name, brand=excluded.brand, spec=excluded.spec, category=excluded.category,
			img=excluded.img, cost_price=excluded.cost_price, sale_price=excluded.sale_price,
			ref_price=excluded.ref_price, unit=excluded.unit, stock=excluded.stock,
			is_wholesale=excluded.is_wholesale, sync_status=excluded.sync_status, updated_at=excluded.updated_at`,
		p.Code, p.Name, p.Brand, p.Spec, p.Category, p.Img, p.CostPrice, p.SalePrice,
		p.RefPrice, p.Unit, p.Stock, boolInt(p.IsWholesale), p.SyncStatus, p.CreatedAt, p.UpdatedAt)
	if err != nil {
		return Product{}, fmt.Errorf("写入商品失败: %w", err)
	}
	// 建档即沉淀进条码字典层（永久缓存，D6）
	if err := s.UpsertLib(LibEntry{Code: p.Code, Name: p.Name, Spec: p.Spec, Source: "product", Status: "found"}); err != nil {
		return Product{}, err
	}
	return s.GetProduct(p.Code)
}

// GetProduct 按条码取商品。
func (s *Store) GetProduct(code string) (Product, error) {
	row := s.db.QueryRow(`SELECT code,name,brand,spec,category,img,cost_price,sale_price,ref_price,
		unit,stock,is_wholesale,sync_status,created_at,updated_at FROM product WHERE code=?`, code)
	p, err := scanProduct(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Product{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, code)
	}
	return p, err
}

// ListProducts 全量商品（可按分类/关键字过滤）。
func (s *Store) ListProducts(keyword, category string) ([]Product, error) {
	q := `SELECT code,name,brand,spec,category,img,cost_price,sale_price,ref_price,
		unit,stock,is_wholesale,sync_status,created_at,updated_at FROM product`
	var conds []string
	var args []any
	if keyword != "" {
		conds = append(conds, `(name LIKE ? OR code LIKE ?)`)
		args = append(args, "%"+keyword+"%", "%"+keyword+"%")
	}
	if category != "" {
		conds = append(conds, `category = ?`)
		args = append(args, category)
	}
	if len(conds) > 0 {
		q += " WHERE " + joinAnd(conds)
	}
	q += " ORDER BY code"
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, fmt.Errorf("查询商品失败: %w", err)
	}
	defer rows.Close()
	out := []Product{}
	for rows.Next() {
		p, err := scanProduct(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// SetStock 直接改数（D8：库存一律手动调整，扫码只读）。
func (s *Store) SetStock(code string, stock float64) (Product, error) {
	if stock < 0 {
		return Product{}, fmt.Errorf("%w: 库存不能为负", ErrBadInput)
	}
	res, err := s.db.Exec(`UPDATE product SET stock=?, sync_status='pending', updated_at=? WHERE code=?`,
		stock, nowStr(), code)
	if err != nil {
		return Product{}, err
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return Product{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, code)
	}
	return s.GetProduct(code)
}

func scanProduct(sc interface{ Scan(...any) error }) (Product, error) {
	var p Product
	var wholesale int
	err := sc.Scan(&p.Code, &p.Name, &p.Brand, &p.Spec, &p.Category, &p.Img, &p.CostPrice,
		&p.SalePrice, &p.RefPrice, &p.Unit, &p.Stock, &wholesale, &p.SyncStatus, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return Product{}, err
	}
	p.IsWholesale = wholesale != 0
	return p, nil
}

/* ------------------------------ 条码字典 ------------------------------ */

// UpsertLib 写入/刷新条码字典项；命中次数自增由 TouchLib 负责。
func (s *Store) UpsertLib(e LibEntry) error {
	if e.Code == "" {
		return fmt.Errorf("%w: 条码不能为空", ErrBadInput)
	}
	if e.Source == "" {
		e.Source = "lib"
	}
	if e.Status == "" {
		e.Status = "found"
	}
	_, err := s.db.Exec(`INSERT INTO barcode_lib (code,name,spec,source,status,hits,expires_at,updated_at)
		VALUES (?,?,?,?,?,0,?,?)
		ON CONFLICT(code) DO UPDATE SET name=excluded.name, spec=excluded.spec,
			source=excluded.source, status=excluded.status, expires_at=excluded.expires_at,
			updated_at=excluded.updated_at`, e.Code, e.Name, e.Spec, e.Source, e.Status, e.ExpiresAt, nowStr())
	return err
}

// GetLib 取字典项；not_found 标记过期视为未命中（使用系统当前时间）。
func (s *Store) GetLib(code string) (LibEntry, bool) {
	return s.GetLibAt(code, time.Now())
}

// GetLibAt 取字典项，并按传入时间判断 not_found 标记是否过期（便于注入时钟测试）。
func (s *Store) GetLibAt(code string, now time.Time) (LibEntry, bool) {
	row := s.db.QueryRow(`SELECT code,name,spec,source,status,hits,expires_at,updated_at
		FROM barcode_lib WHERE code=?`, code)
	var e LibEntry
	err := row.Scan(&e.Code, &e.Name, &e.Spec, &e.Source, &e.Status, &e.Hits, &e.ExpiresAt, &e.UpdatedAt)
	if err != nil {
		return LibEntry{}, false
	}
	if e.Status == "not_found" && e.ExpiresAt != "" && now.After(parseTime(e.ExpiresAt)) {
		return LibEntry{}, false
	}
	return e, true
}

// TouchLib 命中次数 +1。
func (s *Store) TouchLib(code string) {
	_, _ = s.db.Exec(`UPDATE barcode_lib SET hits=hits+1, updated_at=? WHERE code=?`, nowStr(), code)
}

// ListLib 全量字典项（最近更新的排前面；limit<=0 表示默认 200 条，便于扫码台查看「本地条码库」）。
func (s *Store) ListLib(limit int) ([]LibEntry, error) {
	if limit <= 0 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT code,name,spec,source,status,hits,expires_at,updated_at
		FROM barcode_lib ORDER BY updated_at DESC, code LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("查询条码字典失败: %w", err)
	}
	defer rows.Close()
	out := []LibEntry{}
	for rows.Next() {
		var e LibEntry
		if err := rows.Scan(&e.Code, &e.Name, &e.Spec, &e.Source, &e.Status, &e.Hits, &e.ExpiresAt, &e.UpdatedAt); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

/* ------------------------------ 订单 ------------------------------ */

// stateFlow 订单状态机：pending → delivering / ready → done；pending → cancelled。
var stateFlow = map[string][]string{
	"pending":    {"delivering", "ready", "cancelled"},
	"delivering": {"done"},
	"ready":      {"done"},
	"done":       {},
	"cancelled":  {},
}

// CreateOrder 事务下单：校验 → 扣库存 → 写订单（库存与前缀校验都在同一事务内，避免超卖）。
func (s *Store) CreateOrder(in NewOrderInput) (Order, error) {
	if in.DeliveryType != "pickup" && in.DeliveryType != "delivery" {
		return Order{}, fmt.Errorf("%w: 配送方式只能是 pickup / delivery", ErrBadInput)
	}
	if in.CustomerName == "" || in.Phone == "" {
		return Order{}, fmt.Errorf("%w: 姓名与手机号必填", ErrBadInput)
	}
	if in.DeliveryType == "delivery" && in.Address == "" {
		return Order{}, fmt.Errorf("%w: 配送需填写地址", ErrBadInput)
	}
	if len(in.Items) == 0 {
		return Order{}, fmt.Errorf("%w: 购物车为空", ErrBadInput)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback()

	items := make([]OrderItem, 0, len(in.Items))
	var subtotal float64
	for _, it := range in.Items {
		if it.Qty <= 0 {
			return Order{}, fmt.Errorf("%w: 数量必须大于 0", ErrBadInput)
		}
		var name string
		var price, stock float64
		err := tx.QueryRow(`SELECT name, sale_price, stock FROM product WHERE code=?`, it.Code).
			Scan(&name, &price, &stock)
		if errors.Is(err, sql.ErrNoRows) {
			return Order{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, it.Code)
		}
		if err != nil {
			return Order{}, err
		}
		if stock < it.Qty {
			return Order{}, fmt.Errorf("%w: %s 仅剩 %v", ErrStockLess, name, stock)
		}
		if _, err := tx.Exec(`UPDATE product SET stock=stock-?, updated_at=? WHERE code=?`,
			it.Qty, nowStr(), it.Code); err != nil {
			return Order{}, err
		}
		items = append(items, OrderItem{Code: it.Code, Name: name, Price: price, Qty: it.Qty})
		subtotal += price * it.Qty
	}

	fee, err := pricing.DeliveryFee(in.DeliveryType, subtotal, s.cfg)
	if err != nil {
		return Order{}, err
	}
	o := Order{
		ID:           fmt.Sprintf("M%d", time.Now().UnixNano()),
		CustomerName: in.CustomerName, Phone: in.Phone, Address: in.Address,
		DeliveryType: in.DeliveryType, Subtotal: round2(subtotal), DeliveryFee: fee,
		Total: round2(subtotal + fee), Status: "pending", Items: items, CreatedAt: nowStr(),
	}
	if _, err := tx.Exec(`INSERT INTO orders
		(id,customer_name,phone,address,delivery_type,subtotal,delivery_fee,total,status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		o.ID, o.CustomerName, o.Phone, o.Address, o.DeliveryType, o.Subtotal, o.DeliveryFee, o.Total,
		o.Status, o.CreatedAt, o.CreatedAt); err != nil {
		return Order{}, err
	}
	for _, it := range items {
		if _, err := tx.Exec(`INSERT INTO order_item (order_id,code,name,price,qty) VALUES (?,?,?,?,?)`,
			o.ID, it.Code, it.Name, it.Price, it.Qty); err != nil {
			return Order{}, err
		}
	}
	if _, err := tx.Exec(`INSERT INTO customer (phone,name,created_at) VALUES (?,?,?)
		ON CONFLICT(phone) DO NOTHING`, in.Phone, in.CustomerName, o.CreatedAt); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(); err != nil {
		return Order{}, err
	}
	return s.GetOrder(o.ID)
}

// GetOrder 读单，连带明细。
func (s *Store) GetOrder(id string) (Order, error) {
	row := s.db.QueryRow(`SELECT id,customer_name,phone,address,delivery_type,subtotal,delivery_fee,
		total,status,created_at,updated_at FROM orders WHERE id=?`, id)
	var o Order
	err := row.Scan(&o.ID, &o.CustomerName, &o.Phone, &o.Address, &o.DeliveryType, &o.Subtotal,
		&o.DeliveryFee, &o.Total, &o.Status, &o.CreatedAt, &o.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Order{}, fmt.Errorf("%w: 订单 %s", ErrNotFound, id)
	}
	if err != nil {
		return Order{}, err
	}
	rows, err := s.db.Query(`SELECT code,name,price,qty FROM order_item WHERE order_id=? ORDER BY code`, id)
	if err != nil {
		return Order{}, err
	}
	defer rows.Close()
	o.Items = []OrderItem{}
	for rows.Next() {
		var it OrderItem
		if err := rows.Scan(&it.Code, &it.Name, &it.Price, &it.Qty); err != nil {
			return Order{}, err
		}
		o.Items = append(o.Items, it)
	}
	return o, rows.Err()
}

// ListOrders 订单列表（status 为空表示全部）。
func (s *Store) ListOrders(status string) ([]Order, error) {
	q := `SELECT id FROM orders`
	var args []any
	if status != "" {
		q += ` WHERE status=?`
		args = append(args, status)
	}
	q += ` ORDER BY created_at DESC, id DESC`
	rows, err := s.db.Query(q, args...)
	if err != nil {
		return nil, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	out := []Order{}
	for _, id := range ids {
		o, err := s.GetOrder(id)
		if err != nil {
			return nil, err
		}
		out = append(out, o)
	}
	return out, nil
}

// AdvanceOrder 状态流转；非法流转返回 ErrConflict。
func (s *Store) AdvanceOrder(id, to string) (Order, error) {
	o, err := s.GetOrder(id)
	if err != nil {
		return Order{}, err
	}
	if !canAdvance(o.Status, to) {
		return Order{}, fmt.Errorf("%w: 状态不允许从「%s」变更为「%s」", ErrConflict, o.Status, to)
	}
	if to == "cancelled" {
		return s.cancel(id, o)
	}
	if _, err := s.db.Exec(`UPDATE orders SET status=?, updated_at=? WHERE id=?`, to, nowStr(), id); err != nil {
		return Order{}, err
	}
	return s.GetOrder(id)
}

// cancel 取消订单并回补库存（仅 pending 可取消，由调用方保证）。
func (s *Store) cancel(id string, o Order) (Order, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback()
	for _, it := range o.Items {
		if _, err := tx.Exec(`UPDATE product SET stock=stock+?, sync_status='pending', updated_at=? WHERE code=?`,
			it.Qty, nowStr(), it.Code); err != nil {
			return Order{}, err
		}
	}
	if _, err := tx.Exec(`UPDATE orders SET status='cancelled', updated_at=? WHERE id=?`, nowStr(), id); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(); err != nil {
		return Order{}, err
	}
	return s.GetOrder(id)
}

func canAdvance(from, to string) bool {
	for _, allow := range stateFlow[from] {
		if allow == to {
			return true
		}
	}
	return false
}

/* ------------------------------ 顾客 / 同步批次 ------------------------------ */

// TouchCustomer 记录顾客档案（下单自动建档，不覆盖已有备注）。
func (s *Store) TouchCustomer(phone, name string) error {
	if phone == "" {
		return fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	_, err := s.db.Exec(`INSERT INTO customer (phone,name,created_at) VALUES (?,?,?)
		ON CONFLICT(phone) DO UPDATE SET name=excluded.name`, phone, name, nowStr())
	return err
}

// RecordSyncBatch 记录一次同步批次（M3 对账结果入库）。
func (s *Store) RecordSyncBatch(kind, filename string, total, ok, diff int) error {
	_, err := s.db.Exec(`INSERT INTO sync_batch (kind,filename,total,ok,diff,created_at) VALUES (?,?,?,?,?,?)`,
		kind, filename, total, ok, diff, nowStr())
	return err
}

/* ------------------------------ 小工具 ------------------------------ */

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func round2(f float64) float64 {
	return math.Floor(f*100+0.5) / 100
}

// parseTime 解析 RFC3339；解析失败返回零值时间（视为已过期）。
func parseTime(rfc3339 string) time.Time {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		return time.Time{}
	}
	return t
}

func joinAnd(conds []string) string {
	out := ""
	for i, c := range conds {
		if i > 0 {
			out += " AND "
		}
		out += c
	}
	return out
}

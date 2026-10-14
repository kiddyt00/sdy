// Package store 提供 SQLite 数据访问层（M4）。
// 数据模型对齐《开发计划》M4：product / barcode_lib / customer / orders / order_item / sync_batch。
package store

import (
	"crypto/rand"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"log"
	"math"
	"strconv"
	"strings"
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
	// ErrDuplicated（第 27 轮）：下单幂等命中——同一个 clientToken 已经出过单了。
	// 这不是失败：调用方应把已存在的那张订单按 200 返回给客户端（绝不重复扣库存）。
	ErrDuplicated = errors.New("重复下单")
)

// Product 商品档案层（还包含经营数据：进价、售价、库存、比价参考价）。
type Product struct {
	Code      string  `json:"code"`
	Name      string  `json:"name"`
	Brand     string  `json:"brand,omitempty"`
	Spec      string  `json:"spec,omitempty"`
	Category  string  `json:"category,omitempty"`
	Img       string  `json:"img,omitempty"`
	CostPrice float64 `json:"costPrice"`
	SalePrice float64 `json:"salePrice"`
	// WholesalePrice 批发价（任务池⑦，D24）：0 表示未设批发价（批发客户也按零售价）。
	// 顾客等级非零售且本值大于 0 时，有效价取本值，且不参与零售比价防线。
	WholesalePrice float64 `json:"wholesalePrice,omitempty"`
	RefPrice       float64 `json:"refPrice,omitempty"` // 牵牛花参考价（比价防线基线）
	Unit           string  `json:"unit,omitempty"`
	Stock          float64 `json:"stock"`
	IsWholesale    bool    `json:"isWholesale,omitempty"`
	// Price 有效价（服务端按顾客等级算好的「这件商品这个顾客买多少钱」）。
	// 始终下发不带 omitempty：页面一律读 price，价格口径只有服务端一个真源（D12）。
	// 零售场景下 price == salePrice。
	Price float64 `json:"price"`
	Tier  string  `json:"tier,omitempty"` // 该次请求所用顾客等级（retail/wholesale/vip）
	// OnSale 上架状态（任务池⑥，D23）：下架只在顾客端生效——商品不再出现在商城、
	// 不能加购下单；档案、库存、历史订单与条码字典都不动。始终下发（不 omitempty），
	// 否则 false 会被前端当成「字段缺失」而误判为上架。
	OnSale bool `json:"onSale"`
	// IsDemo 内置示例数据标记（第 27 轮 / 审计 E-P0-1）：只有 seedIfEmpty 写入的 6 条演示商品
	// 为 true，店里真实建档/第三方脚本灌的数据一律 false。管理后台据此把演示数据和真货分开。
	// 始终下发（不 omitempty），否则 false 会被前端当成「字段缺失」。
	IsDemo     bool   `json:"isDemo"`
	SyncStatus string `json:"syncStatus,omitempty"` // synced / pending
	CreatedAt  string `json:"createdAt,omitempty"`
	UpdatedAt  string `json:"updatedAt,omitempty"`
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
// ClientToken（第 27 轮）：端上生成的幂等键。同一次结算重试（手抖连点、网络超时重发）
// 必须复用同一个 token，服务端才认得出「这是刚才那单」而不是新单。
type NewOrderInput struct {
	CustomerName string              `json:"customerName"`
	Phone        string              `json:"phone"`
	Address      string              `json:"address"`
	DeliveryType string              `json:"deliveryType"`
	Items        []NewOrderInputItem `json:"items"`
	ClientToken  string              `json:"clientToken"`
}

// NewOrderInputItem 下单行入参。
type NewOrderInputItem struct {
	Code string  `json:"code"`
	Qty  float64 `json:"qty"`
}

// Address 顾客收货地址簿条目（D18）：按手机号归档，顾客端一键带出、管理端可见。
// 订单里的地址仍是下单当时的快照，地址簿只负责「少打字」，改地址簿不影响历史订单。
type Address struct {
	ID        int64  `json:"id"`
	Phone     string `json:"phone"`
	Contact   string `json:"contact"`
	Address   string `json:"address"`
	IsDefault bool   `json:"isDefault,omitempty"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
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
		wholesale_price REAL NOT NULL DEFAULT 0,
		ref_price REAL NOT NULL DEFAULT 0,
		unit TEXT NOT NULL DEFAULT '',
		stock REAL NOT NULL DEFAULT 0,
		is_wholesale INTEGER NOT NULL DEFAULT 0,
		on_sale INTEGER NOT NULL DEFAULT 1,
		is_demo INTEGER NOT NULL DEFAULT 0,
		sync_status TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`,
	// 第 27 轮补索引：分类页按 category 过滤、顾客端商城按 on_sale 过滤。
	`CREATE INDEX IF NOT EXISTS idx_product_category ON product(category)`,
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
		tier TEXT NOT NULL DEFAULT 'retail',
		tags TEXT NOT NULL DEFAULT '',
		note TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE TABLE IF NOT EXISTS customer_address (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		phone TEXT NOT NULL DEFAULT '',
		contact TEXT NOT NULL DEFAULT '',
		address TEXT NOT NULL DEFAULT '',
		is_default INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS idx_customer_address_phone ON customer_address(phone)`,
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
		client_token TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT ''
	)`,
	// 第 27 轮：下单幂等键。索引见 postMigrateStmts —— 它建在老库靠 ALTER TABLE 才有的列上。
	// 第 27 轮：订单归属查询（顾客只看自己的单）与状态筛选/对账排序都要用。
	`CREATE INDEX IF NOT EXISTS idx_orders_phone ON orders(phone)`,
	`CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at)`,
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
	// 任务池⑧ / D25：库存流水落库。库存一律手动调整（D8），所以每次变更都要能回答
	// 「谁、什么时候、为什么、从多少到多少」——以前这份审计只存在浏览器 localStorage 里。
	// 第 27 轮补 order_id：下单扣减/取消回补的流水要能追溯回订单。
	`CREATE TABLE IF NOT EXISTS stock_log (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		at INTEGER NOT NULL DEFAULT 0,
		ts TEXT NOT NULL DEFAULT '',
		kind TEXT NOT NULL DEFAULT 'adjust',
		code TEXT NOT NULL DEFAULT '',
		name TEXT NOT NULL DEFAULT '',
		unit TEXT NOT NULL DEFAULT '',
		delta REAL NOT NULL DEFAULT 0,
		before_qty REAL NOT NULL DEFAULT 0,
		after_qty REAL NOT NULL DEFAULT 0,
		reason TEXT NOT NULL DEFAULT '',
		operator TEXT NOT NULL DEFAULT '',
		order_id TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS idx_stock_log_code ON stock_log(code)`,
	// 第 27 轮：地址簿能力令牌。手机号是弱身份（谁都能填），所以「读/删别人的地址簿」
	// 需要一个只有本机保存过的随机 key 才能过——老板（管理员/员工）按手机号直查不受限。
	`CREATE TABLE IF NOT EXISTS addr_key (
		phone TEXT PRIMARY KEY,
		key TEXT NOT NULL,
		created_at TEXT NOT NULL
	)`,
	// 任务池⑧ / D25：配送员名单落库（原来只在 localStorage：换台设备就没人可派单）。
	`CREATE TABLE IF NOT EXISTS courier (
		name TEXT PRIMARY KEY,
		phone TEXT NOT NULL DEFAULT '',
		sort INTEGER NOT NULL DEFAULT 0,
		active INTEGER NOT NULL DEFAULT 1
	)`,
	// 任务池⑧ / D25：门店抬头等键值配置落库（小票表头，跨设备要一致）。
	`CREATE TABLE IF NOT EXISTS setting (
		k TEXT PRIMARY KEY,
		v TEXT NOT NULL DEFAULT ''
	)`,
	// 第 23 轮（D28）：微信登录绑定。openid 只代表「这台微信」——用来免去重复登录，
	// 业务身份仍是手机号（D24/D26），等级永远以 customer.tier 为准。
	`CREATE TABLE IF NOT EXISTS wx_user (
		openid TEXT PRIMARY KEY,
		unionid TEXT NOT NULL DEFAULT '',
		phone TEXT NOT NULL DEFAULT '',
		nickname TEXT NOT NULL DEFAULT '',
		avatar TEXT NOT NULL DEFAULT '',
		role TEXT NOT NULL DEFAULT 'customer',
		staff_token TEXT NOT NULL DEFAULT '',
		created_at TEXT NOT NULL DEFAULT '',
		updated_at TEXT NOT NULL DEFAULT '',
		last_login_at TEXT NOT NULL DEFAULT ''
	)`,
	`CREATE INDEX IF NOT EXISTS idx_wx_user_phone ON wx_user(phone)`,
}

// postMigrateStmts 建在「老库要靠 ALTER TABLE 才有的列」上的索引，必须在 ensureColumn 之后执行。
// 放进 schemaStmts 会踩这个坑：老库的 CREATE TABLE IF NOT EXISTS 是空操作、列还不存在，
// 建索引直接报 `no such column: client_token`，服务反复重启起不来（第 27 轮生产实测踩过）。
var postMigrateStmts = []string{
	// 第 27 轮：下单幂等键。部分唯一索引让「空 token 的老单」互不冲突，
	// 同一个小程序端生成的 clientToken 重试只会命中同一张订单（绝不重复扣库存）。
	`CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_client_token ON orders(client_token) WHERE client_token<>''`,
	// 第 26 轮：员工令牌每次鉴权都要按 staff_token 查，没有索引就是全表扫。
	`CREATE INDEX IF NOT EXISTS idx_wx_user_staff_token ON wx_user(staff_token)`,
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
	// 老库升级：product.on_sale 是任务池⑥ 新增列，已存在的库要靠 ALTER TABLE 补上。
	if err := ensureColumn(db, "product", "on_sale", "INTEGER NOT NULL DEFAULT 1"); err != nil {
		db.Close()
		return nil, err
	}
	// 任务池⑦（D24）：商品批发价 + 顾客等级，同样幂等补列，老库不清库。
	for _, c := range []struct{ table, column, decl string }{
		{"product", "wholesale_price", "REAL NOT NULL DEFAULT 0"},
		{"customer", "tier", "TEXT NOT NULL DEFAULT 'retail'"},
		// 第 25 轮（D31）：微信头像与昵称——昵称从登录参数挪到可单独保存的档案字段。
		{"wx_user", "avatar", "TEXT NOT NULL DEFAULT ''"},
		// 第 26 轮（D32）：角色（顾客 / 员工）与员工会话令牌——后台管角色，登录时选身份。
		{"wx_user", "role", "TEXT NOT NULL DEFAULT 'customer'"},
		{"wx_user", "staff_token", "TEXT NOT NULL DEFAULT ''"},
		// 第 27 轮：orders.client_token（下单幂等键）与 stock_log.order_id（回补流水可追溯订单）。
		{"orders", "client_token", "TEXT NOT NULL DEFAULT ''"},
		{"stock_log", "order_id", "TEXT NOT NULL DEFAULT ''"},
		// 第 27 轮（审计 E-P0-1）：内置示例数据标记，老库里的存量商品一律视为真实商品（0）。
		{"product", "is_demo", "INTEGER NOT NULL DEFAULT 0"},
	} {
		if err := ensureColumn(db, c.table, c.column, c.decl); err != nil {
			db.Close()
			return nil, err
		}
	}
	// 补完列再建依赖这些列的索引（老库升级路径，见 postMigrateStmts 注释）。
	for _, stmt := range postMigrateStmts {
		if _, err := db.Exec(stmt); err != nil {
			db.Close()
			return nil, fmt.Errorf("建索引失败: %w", err)
		}
	}
	// 任务池⑧（D25）：配送员名单首次给一份 4 人雏形种子（只种一次，删空后不复活）。
	if err := s.seedCouriers(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

// defaultCouriers 4 人配送雏形，与前端 Admin.DEFAULT_COURIERS 同一份名单。
var defaultCouriers = []Courier{{Name: "老张"}, {Name: "小李"}, {Name: "阿强"}, {Name: "小美"}}

// seedCouriers 首次启动灌入默认配送员。用 setting 里的标记位保证「只种一次」：
// 老板把名单删空后重启服务，不会又冒出来。
func (s *Store) seedCouriers() error {
	var v string
	err := s.db.QueryRow(`SELECT v FROM setting WHERE k='seed:courier'`).Scan(&v)
	if err == nil {
		return nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("读取初始化标记失败: %w", err)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("初始化配送员失败: %w", err)
	}
	defer tx.Rollback()
	for i, c := range defaultCouriers {
		if _, err := tx.Exec(`INSERT INTO courier (name,phone,sort,active) VALUES (?,?,?,1)
			ON CONFLICT(name) DO NOTHING`, c.Name, c.Phone, i); err != nil {
			return fmt.Errorf("写入默认配送员失败: %w", err)
		}
	}
	if _, err := tx.Exec(`INSERT INTO setting (k,v) VALUES ('seed:courier','1')`); err != nil {
		return fmt.Errorf("写入初始化标记失败: %w", err)
	}
	return tx.Commit()
}

// ensureColumn 幂等补列（老库升级用）：列已存在则什么都不做。
// 表名/列名/类型都是代码内常量，不接受外部输入。
func ensureColumn(db *sql.DB, table, column, decl string) error {
	rows, err := db.Query(`PRAGMA table_info(` + table + `)`)
	if err != nil {
		return fmt.Errorf("读取表结构失败: %w", err)
	}
	defer rows.Close()
	has := false
	for rows.Next() {
		var cid, notnull, pk int
		var name, ctype string
		var dflt any
		if err := rows.Scan(&cid, &name, &ctype, &notnull, &dflt, &pk); err != nil {
			return fmt.Errorf("读取表结构失败: %w", err)
		}
		if name == column {
			has = true
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("读取表结构失败: %w", err)
	}
	if has {
		return nil
	}
	if _, err := db.Exec(`ALTER TABLE ` + table + ` ADD COLUMN ` + column + ` ` + decl); err != nil {
		return fmt.Errorf("升级表结构失败（%s.%s）: %w", table, column, err)
	}
	return nil
}

// Close 关闭数据库。
func (s *Store) Close() error { return s.db.Close() }

// DB 暴露底层连接（仅供测试与迁移使用）。
func (s *Store) DB() *sql.DB { return s.db }

func nowStr() string { return time.Now().Format(time.RFC3339) }

/* ------------------------------ 商品 ------------------------------ */

// UpsertProduct 新增或覆盖商品档案。
func (s *Store) UpsertProduct(p Product) (Product, error) {
	p.Code = strings.TrimSpace(p.Code)
	p.Name = strings.TrimSpace(p.Name)
	if p.Code == "" {
		return Product{}, fmt.Errorf("%w: 条码不能为空", ErrBadInput)
	}
	if p.Name == "" {
		return Product{}, fmt.Errorf("%w: 商品名称不能为空", ErrBadInput)
	}
	if p.CostPrice < 0 || p.SalePrice < 0 || p.RefPrice < 0 || p.WholesalePrice < 0 {
		return Product{}, fmt.Errorf("%w: 价格不能为负数", ErrBadInput)
	}
	if math.IsNaN(p.CostPrice) || math.IsNaN(p.SalePrice) || math.IsNaN(p.RefPrice) ||
		math.IsNaN(p.WholesalePrice) || math.IsNaN(p.Stock) {
		return Product{}, fmt.Errorf("%w: 价格/库存必须是数字", ErrBadInput)
	}
	if p.Stock < 0 {
		return Product{}, fmt.Errorf("%w: 库存不能为负", ErrBadInput)
	}
	// 归一化：单位/分类留空时给默认值，避免页面出现空白列
	if p.Unit == "" {
		p.Unit = "件"
	}
	if p.Category == "" {
		p.Category = "未分类"
	}
	// 价格防线（M2 规则，服务端为准）：零售价不得超过牵牛花参考价的 MaxRetailRatio；
	// 批发商品按配置豁免。前端改价同样会被这里拒绝，页面把错误原文展示给店主。
	if r := pricing.CheckRetailPrice(p.SalePrice, p.RefPrice, p.IsWholesale, s.cfg); !r.OK {
		return Product{}, fmt.Errorf("%w: %s", ErrBadInput, r.Msg)
	}
	if p.CreatedAt == "" {
		p.CreatedAt = nowStr()
	}
	p.UpdatedAt = nowStr()
	// 注意：写入语句刻意不包含 on_sale（D23，与库存同理）——编辑商品档案不改变上下架状态，
	// 新建商品默认上架，上下架只走 SetProductsOnSale / POST /api/products/onsale。
	// is_demo（第 27 轮）同理不在 ON CONFLICT 里覆盖：演示标记只由首次灌种子时写在插入语句上，
	// 后来老板编辑这条商品（或第三方脚本按条码覆盖）都不会把标记抹掉，前端筛选口径才稳定。
	// 批发价（D24）随档案一起覆盖：调用方必须把 wholesalePrice 一并传（0 表示未设批发价），
	// 与 img 同理——漏传会把已设的批发价清零（规则 19⑤）。
	_, err := s.db.Exec(`INSERT INTO product
		(code,name,brand,spec,category,img,cost_price,sale_price,wholesale_price,ref_price,unit,stock,is_wholesale,on_sale,is_demo,sync_status,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)
		ON CONFLICT(code) DO UPDATE SET
			name=excluded.name, brand=excluded.brand, spec=excluded.spec, category=excluded.category,
			img=excluded.img, cost_price=excluded.cost_price, sale_price=excluded.sale_price,
			wholesale_price=excluded.wholesale_price,
			ref_price=excluded.ref_price, unit=excluded.unit, stock=excluded.stock,
			is_wholesale=excluded.is_wholesale, sync_status=excluded.sync_status, updated_at=excluded.updated_at`,
		p.Code, p.Name, p.Brand, p.Spec, p.Category, p.Img, p.CostPrice, p.SalePrice, p.WholesalePrice,
		p.RefPrice, p.Unit, p.Stock, boolInt(p.IsWholesale), boolInt(p.IsDemo), p.SyncStatus, p.CreatedAt, p.UpdatedAt)
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
	row := s.db.QueryRow(`SELECT code,name,brand,spec,category,img,cost_price,sale_price,wholesale_price,ref_price,
		unit,stock,is_wholesale,on_sale,is_demo,sync_status,created_at,updated_at FROM product WHERE code=?`, code)
	p, err := scanProduct(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Product{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, code)
	}
	return p, err
}

// ListProducts 全量商品（可按分类/关键字过滤）。
func (s *Store) ListProducts(keyword, category string) ([]Product, error) {
	return s.listProducts(keyword, category, false)
}

// ListOnSaleProducts 只返回已上架商品（顾客端商城用，任务池⑥ / D23）。
// 管理端必须用 ListProducts，否则下架商品会从经营台消失、无法再上架。
func (s *Store) ListOnSaleProducts(keyword, category string) ([]Product, error) {
	return s.listProducts(keyword, category, true)
}

// CategoryStat 分类及其商品件数（顾客端分类页用，第 24 轮 / D29）。
type CategoryStat struct {
	Name  string `json:"name"`
	Count int    `json:"count"`
}

// ListCategories 列出分类与件数。顾客端只该看上架商品，所以 onSaleOnly=true；
// 留空（含只有空格）的分类归到「未分类」，与建档时的归一化同口径（一处真源）。
func (s *Store) ListCategories(onSaleOnly bool) ([]CategoryStat, error) {
	q := `SELECT COALESCE(NULLIF(TRIM(category),''),'未分类') AS c, COUNT(*) FROM product`
	if onSaleOnly {
		q += ` WHERE on_sale = 1`
	}
	q += ` GROUP BY c ORDER BY COUNT(*) DESC, c ASC`
	rows, err := s.db.Query(q)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []CategoryStat{}
	for rows.Next() {
		var c CategoryStat
		if err := rows.Scan(&c.Name, &c.Count); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

func (s *Store) listProducts(keyword, category string, onSaleOnly bool) ([]Product, error) {
	q := `SELECT code,name,brand,spec,category,img,cost_price,sale_price,wholesale_price,ref_price,
		unit,stock,is_wholesale,on_sale,is_demo,sync_status,created_at,updated_at FROM product`
	var conds []string
	var args []any
	if onSaleOnly {
		conds = append(conds, `on_sale = 1`)
	}
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

// 库存变更类型（stock_log.kind，任务池⑧ / D25；第 27 轮补下单/取消两种）。
const (
	StockKindIn     = "stock_in"      // 入库（qty 为入库正数）
	StockKindAdjust = "adjust"        // 直接改数（qty 为增减量，可正可负）
	StockKindTake   = "stock_take"    // 盘点（qty 为实盘数）
	StockKindOrder  = "order_out"     // 下单扣减（第 27 轮）
	StockKindCancel = "cancel_return" // 取消订单回补（第 27 轮）
	maxStockLog     = 500             // 流水只留最近 500 条，免得库无限长大
)

// 低库存阈值（第 27 轮单一真源）：工作时台与设置接口都用这一个值。
const LowStockThreshold = 5

// StockLog 一条库存流水（任务池⑧ / D25）。
// D8 规定库存一律手动调整，所以每一次变更都要留下「谁、为什么、从多少到多少」。
// OrderID（第 27 轮）：下单扣减/取消回补的流水挂到订单号上，便于「这单动了哪些库存」对账。
type StockLog struct {
	ID      int64   `json:"id"`
	At      int64   `json:"at"`   // epoch 毫秒（前端时间显示用）
	TS      string  `json:"ts"`   // RFC3339，便于阅读与以后导出
	Kind    string  `json:"kind"` // stock_in / adjust / stock_take / order_out / cancel_return
	Code    string  `json:"code"`
	Name    string  `json:"name"`
	Unit    string  `json:"unit"`
	Delta   float64 `json:"delta"`
	Before  float64 `json:"before"`
	After   float64 `json:"after"`
	Reason  string  `json:"reason"`
	By      string  `json:"by"`
	OrderID string  `json:"orderId,omitempty"`
}

// SetStock 直接改数（D8：库存一律手动调整，扫码只读）。
// 值为绝对值；为不留「无审计的库存变更」，它同样写一条流水（D25）。
func (s *Store) SetStock(code string, stock float64) (Product, error) {
	if math.IsNaN(stock) || math.IsInf(stock, 0) {
		return Product{}, fmt.Errorf("%w: 库存数量无效", ErrBadInput)
	}
	if stock < 0 {
		return Product{}, fmt.Errorf("%w: 库存不能为负", ErrBadInput)
	}
	cur, err := s.GetProduct(code)
	if err != nil {
		return Product{}, err
	}
	if cur.Stock == stock {
		return cur, nil // 没变就不写流水，免得刷一堆 0 变更
	}
	if _, err := s.ChangeStock(code, StockKindAdjust, stock-cur.Stock, "直接改数", "老板"); err != nil {
		return Product{}, err
	}
	return s.GetProduct(code)
}

// ChangeStock 库存变更的**唯一入口**：一个事务里改 product.stock + 写 stock_log。
// 库存为负、商品不存在、数量无效都在提交前拦下，不会留下「改了库存却没流水」的中间态。
func (s *Store) ChangeStock(code, kind string, qty float64, reason, by string) (StockLog, error) {
	code = strings.TrimSpace(code)
	kind = strings.TrimSpace(kind)
	reason = strings.TrimSpace(reason)
	by = strings.TrimSpace(by)
	if code == "" {
		return StockLog{}, fmt.Errorf("%w: 商品条码不能为空", ErrBadInput)
	}
	if math.IsNaN(qty) || math.IsInf(qty, 0) {
		return StockLog{}, fmt.Errorf("%w: 变更数量无效", ErrBadInput)
	}
	switch kind {
	case StockKindIn:
		if qty <= 0 {
			return StockLog{}, fmt.Errorf("%w: 入库数量必须为正数", ErrBadInput)
		}
	case StockKindAdjust:
		if qty == 0 {
			return StockLog{}, fmt.Errorf("%w: 改数数量不能为 0", ErrBadInput)
		}
	case StockKindTake:
		if qty < 0 {
			return StockLog{}, fmt.Errorf("%w: 实盘数量不能为负", ErrBadInput)
		}
	default:
		return StockLog{}, fmt.Errorf("%w: 库存操作类型只能是 stock_in / adjust / stock_take", ErrBadInput)
	}
	if by == "" {
		by = "老板"
	}
	tx, err := s.db.Begin()
	if err != nil {
		return StockLog{}, fmt.Errorf("开启库存事务失败: %w", err)
	}
	defer tx.Rollback()

	var (
		name, unit string
		before     float64
	)
	err = tx.QueryRow(`SELECT name, unit, stock FROM product WHERE code=?`, code).Scan(&name, &unit, &before)
	if errors.Is(err, sql.ErrNoRows) {
		return StockLog{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, code)
	}
	if err != nil {
		return StockLog{}, fmt.Errorf("读取商品失败: %w", err)
	}
	after := before + qty // stock_in / adjust：qty 是增量
	if kind == StockKindTake {
		after = qty // 盘点：qty 是实盘数
	}
	if after < 0 {
		return StockLog{}, fmt.Errorf("%w: 库存不能为负（当前 %v %s）", ErrBadInput, before, unit)
	}
	if _, err := tx.Exec(`UPDATE product SET stock=?, sync_status='pending', updated_at=? WHERE code=?`,
		after, nowStr(), code); err != nil {
		return StockLog{}, fmt.Errorf("更新库存失败: %w", err)
	}
	now := time.Now()
	res, err := tx.Exec(`INSERT INTO stock_log
		(at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		now.UnixMilli(), now.Format(time.RFC3339), kind, code, name, unit,
		after-before, before, after, reason, by, "")
	if err != nil {
		return StockLog{}, fmt.Errorf("写入库存流水失败: %w", err)
	}
	id, _ := res.LastInsertId()
	// 只保留最近 maxStockLog 条（审计足够用，库不会无限长大）。
	if _, err := tx.Exec(`DELETE FROM stock_log WHERE id NOT IN
		(SELECT id FROM stock_log ORDER BY id DESC LIMIT ?)`, maxStockLog); err != nil {
		return StockLog{}, fmt.Errorf("清理库存流水失败: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return StockLog{}, fmt.Errorf("提交库存事务失败: %w", err)
	}
	return StockLog{
		ID: id, At: now.UnixMilli(), TS: now.Format(time.RFC3339), Kind: kind,
		Code: code, Name: name, Unit: unit,
		Delta: round2(after - before), Before: before, After: after,
		Reason: reason, By: by,
	}, nil
}

// ListStockLog 最近的库存流水，最新在前（limit ≤ 0 或超过上限时取 500）。
func (s *Store) ListStockLog(limit int) ([]StockLog, error) {
	if limit <= 0 || limit > maxStockLog {
		limit = maxStockLog
	}
	rows, err := s.db.Query(`SELECT id,at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id
		FROM stock_log ORDER BY id DESC LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("查询库存流水失败: %w", err)
	}
	defer rows.Close()
	out := []StockLog{}
	for rows.Next() {
		var e StockLog
		if err := rows.Scan(&e.ID, &e.At, &e.TS, &e.Kind, &e.Code, &e.Name, &e.Unit,
			&e.Delta, &e.Before, &e.After, &e.Reason, &e.By, &e.OrderID); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// DeleteProduct 删除商品档案。
// 约束：库存必须已盘点为 0（否则库存无处交代），且不能有进行中的订单引用该商品
// （已完成/已取消订单只留历史行，不阻塞删除）。条码字典层保留不动（D6 永久沉淀）。
func (s *Store) DeleteProduct(code string) error {
	p, err := s.GetProduct(code)
	if err != nil {
		return err
	}
	if p.Stock != 0 {
		return fmt.Errorf("%w: 库存为 %.4g %s，请先盘点为 0 再删除", ErrConflict, p.Stock, p.Unit)
	}
	var refs int
	err = s.db.QueryRow(`SELECT COUNT(*) FROM order_item oi
		JOIN orders o ON o.id = oi.order_id
		WHERE oi.code = ? AND o.status NOT IN ('done','cancelled')`, code).Scan(&refs)
	if err != nil {
		return fmt.Errorf("查询订单引用失败: %w", err)
	}
	if refs > 0 {
		return fmt.Errorf("%w: 有 %d 个进行中的订单包含该商品，不能删除", ErrConflict, refs)
	}
	if _, err := s.db.Exec(`DELETE FROM product WHERE code = ?`, code); err != nil {
		return fmt.Errorf("删除商品失败: %w", err)
	}
	return nil
}

// SetProductsOnSale 批量上架 / 下架（任务池⑥，D23）。
// 语义：只动 product.on_sale。档案字段、库存、历史订单、条码字典一律不动；
// 已经是目标状态的不写库；返回真正发生变化的条码，便于前端如实汇报。
func (s *Store) SetProductsOnSale(codes []string, on bool) ([]string, error) {
	clean := make([]string, 0, len(codes))
	seen := make(map[string]bool, len(codes))
	for _, c := range codes {
		c = strings.TrimSpace(c)
		if c == "" || seen[c] {
			continue
		}
		seen[c] = true
		clean = append(clean, c)
	}
	if len(clean) == 0 {
		return nil, fmt.Errorf("%w: 请至少选择一个商品", ErrBadInput)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer tx.Rollback()
	changed := []string{}
	for _, code := range clean {
		var cur int
		err := tx.QueryRow(`SELECT on_sale FROM product WHERE code=?`, code).Scan(&cur)
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("%w: 商品 %s", ErrNotFound, code)
		}
		if err != nil {
			return nil, err
		}
		if (cur != 0) == on {
			continue
		}
		if _, err := tx.Exec(`UPDATE product SET on_sale=?, updated_at=? WHERE code=?`,
			boolInt(on), nowStr(), code); err != nil {
			return nil, fmt.Errorf("更新上下架状态失败: %w", err)
		}
		changed = append(changed, code)
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return changed, nil
}

func scanProduct(sc interface{ Scan(...any) error }) (Product, error) {
	var p Product
	var wholesale, onSale, isDemo int
	err := sc.Scan(&p.Code, &p.Name, &p.Brand, &p.Spec, &p.Category, &p.Img, &p.CostPrice,
		&p.SalePrice, &p.WholesalePrice, &p.RefPrice, &p.Unit, &p.Stock, &wholesale, &onSale, &isDemo,
		&p.SyncStatus, &p.CreatedAt, &p.UpdatedAt)
	if err != nil {
		return Product{}, err
	}
	p.IsWholesale = wholesale != 0
	p.OnSale = onSale != 0
	p.IsDemo = isDemo != 0
	// 有效价默认等于零售价；带上 phone 的请求会由 HTTP 层按顾客等级改写（D24）。
	p.Price = p.SalePrice
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
// 状态字面量统一取 pricing 包常量，避免「文案一处、状态串又一处」。
var stateFlow = map[string][]string{
	pricing.StatusPending:    {pricing.StatusDelivering, pricing.StatusReady, pricing.StatusCancelled},
	pricing.StatusDelivering: {pricing.StatusDone},
	pricing.StatusReady:      {pricing.StatusDone},
	pricing.StatusDone:       {},
	pricing.StatusCancelled:  {},
}

// CreateOrder 事务下单：幂等检查 → 校验 → 原子扣库存（+流水）→ 写订单。
// 全流程在同一个事务里，任何一步校验失败都整单回滚——不会出现「扣了库存单没成立」。
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
	// 合并重复条码：购物车里同一件商品出现两行时，order_item 的主键 (order_id,code)
	// 会撞车导致整单 500。这里按 code 累加数量，语义上等价于「一共买了几件」。
	merged := make([]NewOrderInputItem, 0, len(in.Items))
	idx := make(map[string]int, len(in.Items))
	for _, it := range in.Items {
		code := strings.TrimSpace(it.Code)
		if code == "" {
			return Order{}, fmt.Errorf("%w: 商品条码不能为空", ErrBadInput)
		}
		if it.Qty <= 0 {
			return Order{}, fmt.Errorf("%w: 数量必须大于 0", ErrBadInput)
		}
		if i, ok := idx[code]; ok {
			merged[i].Qty += it.Qty
			continue
		}
		idx[code] = len(merged)
		merged = append(merged, NewOrderInputItem{Code: code, Qty: it.Qty})
	}

	tx, err := s.db.Begin()
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback()

	// 幂等（第 27 轮）：同一个 clientToken 只认一张单，重试直接返回已存在的那张，
	// 绝不再扣一次库存。token 为空（老客户端 / 老数据）不走幂等，保持旧行为。
	if tk := strings.TrimSpace(in.ClientToken); tk != "" {
		var id string
		err := tx.QueryRow(`SELECT id FROM orders WHERE client_token=?`, tk).Scan(&id)
		if err == nil {
			return Order{}, fmt.Errorf("%w: 重复下单 %s", ErrDuplicated, id)
		}
		if !errors.Is(err, sql.ErrNoRows) {
			return Order{}, fmt.Errorf("查询下单幂等键失败: %w", err)
		}
	}

	// 顾客等级决定这一单用零售价还是批发价（D24）。手机号即身份（延续 D18），
	// 没有档案就是零售；等级改动只影响之后的单，旧单价格是下单当时的快照。
	// NormalizeTier 会把库里的脏值（如 'foo'）归一到零售，避免脏等级算出怪价。
	tier := pricing.TierRetail
	if err := tx.QueryRow(`SELECT tier FROM customer WHERE phone=?`, in.Phone).Scan(&tier); err != nil &&
		!errors.Is(err, sql.ErrNoRows) {
		return Order{}, err
	}
	tier = pricing.NormalizeTier(tier)

	now := nowStr()
	items := make([]OrderItem, 0, len(merged))
	logIDs := make([]int64, 0, len(merged))
	var subtotal float64
	for _, it := range merged {
		var name string
		var price, wholesale float64
		var onSale int
		err := tx.QueryRow(`SELECT name, sale_price, wholesale_price, on_sale FROM product WHERE code=?`, it.Code).
			Scan(&name, &price, &wholesale, &onSale)
		if errors.Is(err, sql.ErrNoRows) {
			return Order{}, fmt.Errorf("%w: 商品 %s", ErrNotFound, it.Code)
		}
		if err != nil {
			return Order{}, err
		}
		// 下架商品不能下单（D23）：顾客端购物车可能停留在下架之前，服务端兜底拦住。
		if onSale == 0 {
			return Order{}, fmt.Errorf("%w: 商品「%s」已下架，请从购物车移除后重新结算", ErrConflict, name)
		}
		// 原子扣减：条件写进 UPDATE，避免「先读后判再写」的竞态（两个并发事务同时读到
		// 同一库存后各自扣减 → 负库存）。RowsAffected==0 即库存不足或商品已不在。
		res, err := tx.Exec(`UPDATE product SET stock=stock-?, sync_status='pending', updated_at=?
			WHERE code=? AND on_sale=1 AND stock>=?`, it.Qty, now, it.Code, it.Qty)
		if err != nil {
			return Order{}, fmt.Errorf("扣减库存失败: %w", err)
		}
		if n, err := res.RowsAffected(); err != nil {
			return Order{}, fmt.Errorf("扣减库存失败: %w", err)
		} else if n == 0 {
			// 回读剩余数量只为把话说明白；整单会因 defer tx.Rollback() 回滚，
			// 前面已经扣掉的行不会留下痕迹。
			var left float64
			_ = tx.QueryRow(`SELECT stock FROM product WHERE code=?`, it.Code).Scan(&left)
			return Order{}, fmt.Errorf("%w: 库存不足：%s（还剩 %v 件）", ErrStockLess, name, left)
		}
		// 价格以服务端算的为准，不信任前端传来的价（D12/D24）。
		unit := pricing.EffectivePrice(tier, price, wholesale)
		items = append(items, OrderItem{Code: it.Code, Name: name, Price: unit, Qty: it.Qty})
		subtotal += unit * it.Qty
		// 每一次扣减都留一条流水（D25：库存变了必须有账）。operator 写「下单」，
		// order_id 先留空，拿到订单号后统一回填（见下）。扣减后的库存回读一次，
		// 让流水带上真实的「从多少到多少」——账要能对得上。
		after := 0.0
		if err := tx.QueryRow(`SELECT stock FROM product WHERE code=?`, it.Code).Scan(&after); err != nil {
			return Order{}, fmt.Errorf("读取扣减后库存失败: %w", err)
		}
		lr, err := tx.Exec(`INSERT INTO stock_log
			(at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			time.Now().UnixMilli(), now, StockKindOrder, it.Code, name, unit,
			-it.Qty, after+it.Qty, after, "下单扣减", "下单", "")
		if err != nil {
			return Order{}, fmt.Errorf("写入库存流水失败: %w", err)
		}
		if id, err := lr.LastInsertId(); err == nil {
			logIDs = append(logIDs, id)
		}
	}

	// 起送价（第 27 轮）：按 round2 后的货款比较，minOrder<=0 表示不限起送。
	// 起送价存在 setting 表（k=store.minOrder），下单时实时读——老板改完立刻生效。
	if gap := pricing.MinOrderGap(pricing.Round2(subtotal), s.minOrderTx(tx)); gap > 0 {
		return Order{}, fmt.Errorf("%w: 还差 %s 元起送", ErrBadInput, trimFloat(gap))
	}

	fee, err := pricing.DeliveryFee(in.DeliveryType, subtotal, s.cfg)
	if err != nil {
		return Order{}, err
	}
	o := Order{
		ID:           fmt.Sprintf("M%d", time.Now().UnixNano()),
		CustomerName: in.CustomerName, Phone: in.Phone, Address: in.Address,
		DeliveryType: in.DeliveryType, Subtotal: pricing.Round2(subtotal), DeliveryFee: fee,
		Total: pricing.Round2(subtotal + fee), Status: "pending", Items: items, CreatedAt: now,
	}
	if _, err := tx.Exec(`INSERT INTO orders
		(id,customer_name,phone,address,delivery_type,subtotal,delivery_fee,total,status,client_token,created_at,updated_at)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		o.ID, o.CustomerName, o.Phone, o.Address, o.DeliveryType, o.Subtotal, o.DeliveryFee, o.Total,
		o.Status, strings.TrimSpace(in.ClientToken), now, now); err != nil {
		// 两个并发请求带同一个 token：唯一索引只会放行一个，输的那个回滚改读已存在的单。
		if strings.Contains(err.Error(), "UNIQUE") {
			return Order{}, fmt.Errorf("%w: 并发重复下单", ErrDuplicated)
		}
		return Order{}, err
	}
	for _, it := range items {
		if _, err := tx.Exec(`INSERT INTO order_item (order_id,code,name,price,qty) VALUES (?,?,?,?,?)`,
			o.ID, it.Code, it.Name, it.Price, it.Qty); err != nil {
			return Order{}, err
		}
	}
	// 回填流水的订单号：先插订单拿到号，才能把扣减流水挂到单上。
	for _, id := range logIDs {
		if _, err := tx.Exec(`UPDATE stock_log SET order_id=? WHERE id=?`, o.ID, id); err != nil {
			return Order{}, fmt.Errorf("回填库存流水订单号失败: %w", err)
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

// GetOrderByClientToken 按幂等键取已存在的订单（重复下单时返回原单用，绝不重复扣库存）。
func (s *Store) GetOrderByClientToken(token string) (Order, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return Order{}, fmt.Errorf("%w: 缺少幂等键 clientToken", ErrBadInput)
	}
	var id string
	err := s.db.QueryRow(`SELECT id FROM orders WHERE client_token=?`, token).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return Order{}, fmt.Errorf("%w: 订单（clientToken %s）", ErrNotFound, token)
	}
	if err != nil {
		return Order{}, err
	}
	return s.GetOrder(id)
}

// OrderFilter 订单查询过滤（第 27 轮）。
// Phone 为空 = 员工/管理员看全量；非空 = 只看该手机号的订单（顾客侧）。
// Limit<=0 表示不分页（工作台统计要全量）；Offset 只在分页时生效。
type OrderFilter struct {
	Phone  string
	Status string
	Limit  int
	Offset int
}

// ListOrdersFiltered 按过滤条件返回一页订单与**符合条件的总数**。
// total 与 items 是两个口径：total 是「按过滤条件一共有多少单」，items 是当前页
// （以前 total 直接等于页大小，前端根本没法判断「还有没有下一页」）。
func (s *Store) ListOrdersFiltered(f OrderFilter) ([]Order, int, error) {
	var conds []string
	var args []any
	if phone := strings.TrimSpace(f.Phone); phone != "" {
		conds = append(conds, `phone = ?`)
		args = append(args, phone)
	}
	if status := strings.TrimSpace(f.Status); status != "" {
		conds = append(conds, `status = ?`)
		args = append(args, status)
	}
	where := ""
	if len(conds) > 0 {
		where = " WHERE " + joinAnd(conds)
	}
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM orders`+where, args...).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("统计订单数失败: %w", err)
	}
	q := `SELECT id FROM orders` + where + ` ORDER BY created_at DESC, id DESC`
	qargs := append([]any{}, args...)
	if f.Limit > 0 {
		q += ` LIMIT ? OFFSET ?`
		qargs = append(qargs, f.Limit, f.Offset)
	}
	rows, err := s.db.Query(q, qargs...)
	if err != nil {
		return nil, 0, err
	}
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return nil, 0, err
		}
		ids = append(ids, id)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	out := []Order{}
	for _, id := range ids {
		o, err := s.GetOrder(id)
		if err != nil {
			return nil, 0, err
		}
		out = append(out, o)
	}
	return out, total, nil
}

// ListOrders 全量订单（status 为空表示全部）。工作台统计用，保留原签名。
func (s *Store) ListOrders(status string) ([]Order, error) {
	out, _, err := s.ListOrdersFiltered(OrderFilter{Status: status})
	return out, err
}

// AdvanceOrder 状态流转；非法流转返回 ErrConflict。
func (s *Store) AdvanceOrder(id, to string) (Order, error) {
	o, err := s.GetOrder(id)
	if err != nil {
		return Order{}, err
	}
	if !canAdvance(o.Status, to) {
		return Order{}, fmt.Errorf("%w: 状态不允许从「%s」变更为「%s」", ErrConflict,
			pricing.StatusText(o.Status), pricing.StatusText(to))
	}
	if to == pricing.StatusCancelled {
		return s.CancelOrder(id, "顾客")
	}
	if _, err := s.db.Exec(`UPDATE orders SET status=?, updated_at=? WHERE id=?`, to, nowStr(), id); err != nil {
		return Order{}, err
	}
	return s.GetOrder(id)
}

// CancelOrder 取消订单并回补库存，**回补必须写 stock_log**（第 27 轮修：以前回补不写流水，
// 库存凭空多出来没账）。operator 用员工名或「顾客」；商品已被删除时回补无处可去，
// 记一条异常流水 + WARN 日志，但**不算失败**（订单该取消还是要取消）。
func (s *Store) CancelOrder(id, operator string) (Order, error) {
	id = strings.TrimSpace(id)
	operator = strings.TrimSpace(operator)
	if operator == "" {
		operator = "顾客"
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Order{}, err
	}
	defer tx.Rollback()

	// 事务内重读状态：判定与写入必须在同一个事务里，避免并发取消重复回补。
	var status string
	err = tx.QueryRow(`SELECT status FROM orders WHERE id=?`, id).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		return Order{}, fmt.Errorf("%w: 订单 %s", ErrNotFound, id)
	}
	if err != nil {
		return Order{}, err
	}
	if status == pricing.StatusCancelled {
		// 已经取消了：直接返回，不回补第二次（幂等）。
		// 必须先结束事务再回读：内存库只开一个连接，事务没结束就去读会一直等连接（死锁）。
		_ = tx.Rollback()
		return s.GetOrder(id)
	}
	if !canAdvance(status, pricing.StatusCancelled) {
		return Order{}, fmt.Errorf("%w: 订单已「%s」，不能再取消", ErrConflict, pricing.StatusText(status))
	}

	rows, err := tx.Query(`SELECT code,name,qty FROM order_item WHERE order_id=? ORDER BY code`, id)
	if err != nil {
		return Order{}, fmt.Errorf("查询订单明细失败: %w", err)
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
			return Order{}, err
		}
		lines = append(lines, l)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return Order{}, err
	}

	now := nowStr()
	for _, l := range lines {
		var before float64
		var unit string
		err := tx.QueryRow(`SELECT stock,unit FROM product WHERE code=?`, l.code).Scan(&before, &unit)
		if errors.Is(err, sql.ErrNoRows) {
			s.logLostReturn(tx, id, l.code, l.name, "", l.qty, operator, now, "商品已删除，未回补")
			continue
		}
		if err != nil {
			return Order{}, err
		}
		res, err := tx.Exec(`UPDATE product SET stock=stock+?, sync_status='pending', updated_at=? WHERE code=?`,
			l.qty, now, l.code)
		if err != nil {
			return Order{}, err
		}
		if n, err := res.RowsAffected(); err != nil || n == 0 {
			// 查到了却更新 0 行（并发删除）：同样按「回补丢失」记账，不失败。
			s.logLostReturn(tx, id, l.code, l.name, unit, l.qty, operator, now, "商品已删除，未回补")
			continue
		}
		if _, err := tx.Exec(`INSERT INTO stock_log
			(at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id)
			VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
			time.Now().UnixMilli(), now, StockKindCancel, l.code, l.name, unit,
			l.qty, before, before+l.qty, "取消订单回补", operator, id); err != nil {
			return Order{}, fmt.Errorf("写入取消回补流水失败: %w", err)
		}
	}
	if _, err := tx.Exec(`UPDATE orders SET status=?, updated_at=? WHERE id=?`,
		pricing.StatusCancelled, now, id); err != nil {
		return Order{}, err
	}
	if err := tx.Commit(); err != nil {
		return Order{}, err
	}
	return s.GetOrder(id)
}

// logLostReturn 记录「回补丢失」：商品已删除时回补无处可去。写一条 delta=0 的异常流水
// （D25 精神：库存相关的事都要有账）+ 一行 WARN 日志，但绝不阻断取消流程。
func (s *Store) logLostReturn(tx *sql.Tx, orderID, code, name, unit string, qty float64, operator, at, reason string) {
	log.Printf("[WARN] 订单 %s 取消回补失败：商品 %s（%s）已删除，%v %s 未回补",
		orderID, code, name, qty, unit)
	_, _ = tx.Exec(`INSERT INTO stock_log
		(at,ts,kind,code,name,unit,delta,before_qty,after_qty,reason,operator,order_id)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		time.Now().UnixMilli(), at, StockKindCancel, code, name, unit, 0, 0, 0, reason, operator, orderID)
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

// Customer 顾客档案（任务池⑦，D24）。手机号即身份，无账号体系（延续 D18）。
type Customer struct {
	Phone string `json:"phone"`
	Name  string `json:"name,omitempty"`
	// Tier 等级：retail（零售，默认）/ wholesale（批发）/ vip（白名单）。
	Tier string `json:"tier"`
	Tags string `json:"tags,omitempty"`
	Note string `json:"note,omitempty"`
}

// GetCustomerTier 取顾客等级；查无此人返回零售（不报错——绝大多数顾客没有档案）。
func (s *Store) GetCustomerTier(phone string) (string, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return pricing.TierRetail, nil
	}
	var tier string
	err := s.db.QueryRow(`SELECT tier FROM customer WHERE phone=?`, phone).Scan(&tier)
	if errors.Is(err, sql.ErrNoRows) {
		return pricing.TierRetail, nil
	}
	if err != nil {
		return "", err
	}
	return pricing.NormalizeTier(tier), nil
}

// SetCustomerTier 设定顾客等级（不存在则建档）。等级是「之后下单」的价格口径，
// 不会回头改历史订单的价格快照。
func (s *Store) SetCustomerTier(phone, name, tier string) (Customer, error) {
	phone = strings.TrimSpace(phone)
	name = strings.TrimSpace(name)
	tier = strings.TrimSpace(tier)
	if phone == "" {
		return Customer{}, fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	if !pricing.ValidTier(tier) {
		return Customer{}, fmt.Errorf("%w: 顾客等级只能是 retail / wholesale / vip", ErrBadInput)
	}
	tier = pricing.NormalizeTier(tier)
	// 名字留空时保留原名字（只改等级不该抹掉姓名）。tags/note 不在本接口维护范围。
	if _, err := s.db.Exec(`INSERT INTO customer (phone,name,tier,created_at) VALUES (?,?,?,?)
		ON CONFLICT(phone) DO UPDATE SET tier=excluded.tier,
			name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE customer.name END`,
		phone, name, tier, nowStr()); err != nil {
		return Customer{}, fmt.Errorf("写入顾客等级失败: %w", err)
	}
	return s.GetCustomer(phone)
}

// EnsureCustomer 保证顾客档案存在（微信首次绑手机号时建档）。
// **不覆盖已有姓名与等级**：只补空姓名，等级永远由老板在管理端设定（D24）——
// 登录只是让老板知道「这台微信是谁」，不是提权手段。管理端维护的姓名是唯一真源（D15）。
func (s *Store) EnsureCustomer(phone, name string) (Customer, error) {
	phone = strings.TrimSpace(phone)
	name = strings.TrimSpace(name)
	if !ValidPhone(phone) {
		return Customer{}, fmt.Errorf("%w: 手机号格式不对（要 11 位、1 开头）", ErrBadInput)
	}
	if len([]rune(name)) > 20 {
		name = string([]rune(name)[:20])
	}
	if _, err := s.db.Exec(`INSERT INTO customer (phone,name,tier,created_at) VALUES (?,?,?,?)
		ON CONFLICT(phone) DO UPDATE SET name=CASE WHEN customer.name='' THEN excluded.name ELSE customer.name END`,
		phone, name, pricing.TierRetail, nowStr()); err != nil {
		return Customer{}, fmt.Errorf("建档失败: %w", err)
	}
	return s.GetCustomer(phone)
}

// GetCustomer 取顾客档案（含等级）。
func (s *Store) GetCustomer(phone string) (Customer, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return Customer{}, fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	var c Customer
	err := s.db.QueryRow(`SELECT phone,name,tier,tags,note FROM customer WHERE phone=?`, phone).
		Scan(&c.Phone, &c.Name, &c.Tier, &c.Tags, &c.Note)
	if errors.Is(err, sql.ErrNoRows) {
		return Customer{}, fmt.Errorf("%w: 顾客 %s", ErrNotFound, phone)
	}
	if err != nil {
		return Customer{}, err
	}
	c.Tier = pricing.NormalizeTier(c.Tier)
	return c, nil
}

// ListCustomers 列出所有有档案的顾客（按建档时间倒序），管理端等级维护用。
func (s *Store) ListCustomers() ([]Customer, error) {
	rows, err := s.db.Query(`SELECT phone,name,tier,tags,note FROM customer ORDER BY created_at DESC`)
	if err != nil {
		return nil, fmt.Errorf("查询顾客失败: %w", err)
	}
	defer rows.Close()
	out := []Customer{}
	for rows.Next() {
		var c Customer
		if err := rows.Scan(&c.Phone, &c.Name, &c.Tier, &c.Tags, &c.Note); err != nil {
			return nil, err
		}
		c.Tier = pricing.NormalizeTier(c.Tier)
		out = append(out, c)
	}
	return out, rows.Err()
}

// SetCustomerNote 维护顾客备注与标签（任务池⑧ / D25；等级另走 SetCustomerTier）。
// 手机号即身份，查无此人则建档；姓名留空时保留原名。
func (s *Store) SetCustomerNote(phone, name, tags, note string) (Customer, error) {
	phone = strings.TrimSpace(phone)
	name = strings.TrimSpace(name)
	tags = strings.TrimSpace(tags)
	note = strings.TrimSpace(note)
	if phone == "" {
		return Customer{}, fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	if len([]rune(tags)) > 60 {
		return Customer{}, fmt.Errorf("%w: 标签不能超过 60 字", ErrBadInput)
	}
	if len([]rune(note)) > 200 {
		return Customer{}, fmt.Errorf("%w: 备注不能超过 200 字", ErrBadInput)
	}
	if _, err := s.db.Exec(`INSERT INTO customer (phone,name,tags,note,created_at) VALUES (?,?,?,?,?)
		ON CONFLICT(phone) DO UPDATE SET tags=excluded.tags, note=excluded.note,
			name=CASE WHEN excluded.name<>'' THEN excluded.name ELSE customer.name END`,
		phone, name, tags, note, nowStr()); err != nil {
		return Customer{}, fmt.Errorf("写入顾客备注失败: %w", err)
	}
	return s.GetCustomer(phone)
}

// WxUser 微信登录绑定（第 23 轮 / D28）：openid 只代表「这台微信」，
// 用来免去顾客每次重复输入；业务身份仍是手机号（D24/D26）。
type WxUser struct {
	OpenID    string `json:"openid"`
	UnionID   string `json:"unionid,omitempty"`
	Phone     string `json:"phone,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	Avatar    string `json:"avatar,omitempty"`
	Role      string `json:"role"`
	CreatedAt string `json:"createdAt,omitempty"`
	UpdatedAt string `json:"updatedAt,omitempty"`
	LastLogin string `json:"lastLoginAt,omitempty"`
}

// 第 26 轮（D32）：微信账号的两种角色。后台（管理端 / 员工管理页）改这一列，
// 小程序登录时按它决定「能不能以员工身份进来」。**登录本身永远不提权**。
const (
	RoleCustomer = "customer"
	RoleStaff    = "staff"
)

// ValidRole 角色白名单：只认顾客与员工两个值，避免写进乱七八糟的字符串。
func ValidRole(r string) bool {
	return r == RoleCustomer || r == RoleStaff
}

// ValidPhone 大陆手机号粗校验：11 位、1 开头、全数字，防止把乱码绑成顾客身份。
func ValidPhone(p string) bool {
	if len(p) != 11 || p[0] != '1' {
		return false
	}
	for i := 0; i < len(p); i++ {
		if p[i] < '0' || p[i] > '9' {
			return false
		}
	}
	return true
}

// BindWxUser 记录一次微信登录（openid 为主键），手机号与昵称头像都是可选：
// 第 25 轮（D31）起**登录不再要求手机号**——手机号只是下单时填的收货信息，
// 价格身份由它承载，但「这台微信是谁」与「手机号是多少」是两件事。
// phone 传空＝只刷新登录时间、保留原绑定；传新号＝换绑（一个 openid 只对一个手机号，
// 反过来一家人共用一个手机号下单是允许的）。
// **不碰顾客等级**：批发/白名单只能由老板在管理端设定，登录永远不能自动提权（D24）。
func (s *Store) BindWxUser(openid, unionid, phone, nickname, avatar string) (WxUser, error) {
	openid = strings.TrimSpace(openid)
	unionid = strings.TrimSpace(unionid)
	phone = strings.TrimSpace(phone)
	nickname = strings.TrimSpace(nickname)
	avatar = strings.TrimSpace(avatar)
	if openid == "" {
		return WxUser{}, fmt.Errorf("%w: openid 不能为空", ErrBadInput)
	}
	if phone != "" && !ValidPhone(phone) {
		return WxUser{}, fmt.Errorf("%w: 手机号格式不对（要 11 位、1 开头）", ErrBadInput)
	}
	if r := []rune(nickname); len(r) > 20 {
		// 老板维护的姓名优先，微信昵称只是兜底：超长就截断，绝不让登录因为昵称而失败。
		nickname = string(r[:20])
	}
	if len([]rune(avatar)) > 512 {
		return WxUser{}, fmt.Errorf("%w: 头像地址过长", ErrBadInput)
	}
	now := nowStr()
	if _, err := s.db.Exec(`INSERT INTO wx_user (openid,unionid,phone,nickname,avatar,created_at,updated_at,last_login_at)
		VALUES (?,?,?,?,?,?,?,?)
		ON CONFLICT(openid) DO UPDATE SET
			unionid=CASE WHEN excluded.unionid<>'' THEN excluded.unionid ELSE wx_user.unionid END,
			phone=CASE WHEN excluded.phone<>'' THEN excluded.phone ELSE wx_user.phone END,
			nickname=CASE WHEN excluded.nickname<>'' THEN excluded.nickname ELSE wx_user.nickname END,
			avatar=CASE WHEN excluded.avatar<>'' THEN excluded.avatar ELSE wx_user.avatar END,
			updated_at=excluded.updated_at,
			last_login_at=excluded.last_login_at`,
		openid, unionid, phone, nickname, avatar, now, now, now); err != nil {
		return WxUser{}, fmt.Errorf("写入微信登录失败: %w", err)
	}
	u, _, err := s.GetWxUser(openid)
	return u, err
}

// UpdateWxProfile 保存微信头像与昵称（第 25 轮 / D31）。
// 空值＝保留原值（头像昵称是可选的，别因为一次空提交把已有的擦掉）。
func (s *Store) UpdateWxProfile(openid, nickname, avatar string) (WxUser, error) {
	openid = strings.TrimSpace(openid)
	if openid == "" {
		return WxUser{}, fmt.Errorf("%w: openid 不能为空", ErrBadInput)
	}
	nickname = strings.TrimSpace(nickname)
	avatar = strings.TrimSpace(avatar)
	if r := []rune(nickname); len(r) > 20 {
		nickname = string(r[:20])
	}
	if len([]rune(avatar)) > 512 {
		return WxUser{}, fmt.Errorf("%w: 头像地址过长", ErrBadInput)
	}
	old, ok, err := s.GetWxUser(openid)
	if err != nil {
		return WxUser{}, err
	}
	if !ok {
		return WxUser{}, fmt.Errorf("%w: 微信用户 %s", ErrNotFound, openid)
	}
	if nickname == "" {
		nickname = old.Nickname
	}
	if avatar == "" {
		avatar = old.Avatar
	}
	if _, err := s.db.Exec(`UPDATE wx_user SET nickname=?, avatar=?, updated_at=? WHERE openid=?`,
		nickname, avatar, nowStr(), openid); err != nil {
		return WxUser{}, fmt.Errorf("保存微信头像昵称失败: %w", err)
	}
	u, _, err := s.GetWxUser(openid)
	return u, err
}

// GetWxUser 按 openid 取绑定记录；没有记录返回 false（不是错误：新顾客第一次进来必然没有）。
func (s *Store) GetWxUser(openid string) (WxUser, bool, error) {
	openid = strings.TrimSpace(openid)
	if openid == "" {
		return WxUser{}, false, fmt.Errorf("%w: openid 不能为空", ErrBadInput)
	}
	var u WxUser
	err := s.db.QueryRow(`SELECT openid,unionid,phone,nickname,avatar,role,created_at,updated_at,last_login_at
		FROM wx_user WHERE openid=?`, openid).
		Scan(&u.OpenID, &u.UnionID, &u.Phone, &u.Nickname, &u.Avatar, &u.Role, &u.CreatedAt, &u.UpdatedAt, &u.LastLogin)
	if errors.Is(err, sql.ErrNoRows) {
		return WxUser{}, false, nil
	}
	if err != nil {
		return WxUser{}, false, err
	}
	if u.Role == "" {
		u.Role = RoleCustomer
	}
	return u, true, nil
}

// ListWxUsers 最近的微信登录绑定（管理端审阅用：谁把哪台微信绑到了哪个手机号）。
// 绑定不会自动提权（D24），但老板要能看见「有人绑了我的老顾客手机号」这件事。
func (s *Store) ListWxUsers(limit int) ([]WxUser, error) {
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	rows, err := s.db.Query(`SELECT openid,unionid,phone,nickname,avatar,role,created_at,updated_at,last_login_at
		FROM wx_user ORDER BY last_login_at DESC, openid LIMIT ?`, limit)
	if err != nil {
		return nil, fmt.Errorf("查询微信绑定失败: %w", err)
	}
	defer rows.Close()
	out := make([]WxUser, 0, 16)
	for rows.Next() {
		var u WxUser
		if err := rows.Scan(&u.OpenID, &u.UnionID, &u.Phone, &u.Nickname, &u.Avatar, &u.Role,
			&u.CreatedAt, &u.UpdatedAt, &u.LastLogin); err != nil {
			return nil, err
		}
		if u.Role == "" {
			u.Role = RoleCustomer
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// SetWxUserRole 后台改角色（第 26 轮 / D32）：顾客 ↔ 员工。
// 降级为顾客时顺手清掉员工令牌——免得「人已经被撤了，手机上的工作台还能用」。
func (s *Store) SetWxUserRole(openid, role string) (WxUser, error) {
	openid = strings.TrimSpace(openid)
	role = strings.TrimSpace(role)
	if openid == "" {
		return WxUser{}, fmt.Errorf("%w: openid 不能为空", ErrBadInput)
	}
	if !ValidRole(role) {
		return WxUser{}, fmt.Errorf("%w: 角色只能是 customer（顾客）或 staff（员工）", ErrBadInput)
	}
	res, err := s.db.Exec(`UPDATE wx_user SET role=?, staff_token=CASE WHEN ?=? THEN staff_token ELSE '' END, updated_at=? WHERE openid=?`,
		role, role, RoleStaff, nowStr(), openid)
	if err != nil {
		return WxUser{}, fmt.Errorf("设置角色失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return WxUser{}, fmt.Errorf("%w: 微信用户 %s（让它先用小程序登录一次）", ErrNotFound, openid)
	}
	u, _, err := s.GetWxUser(openid)
	return u, err
}

// RotateStaffToken 员工登录时换发一枚新令牌（每次登录轮换，旧的立刻失效）。
// 令牌只是「这台手机是员工」的凭据，能看的都还是同一套接口；32 字节随机，够用。
func (s *Store) RotateStaffToken(openid string) (string, error) {
	openid = strings.TrimSpace(openid)
	if openid == "" {
		return "", fmt.Errorf("%w: openid 不能为空", ErrBadInput)
	}
	buf := make([]byte, 32)
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成员工令牌失败: %w", err)
	}
	token := hex.EncodeToString(buf)
	res, err := s.db.Exec(`UPDATE wx_user SET staff_token=?, updated_at=? WHERE openid=?`, token, nowStr(), openid)
	if err != nil {
		return "", fmt.Errorf("保存员工令牌失败: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return "", fmt.Errorf("%w: 微信用户 %s", ErrNotFound, openid)
	}
	return token, nil
}

// GetStaffByToken 用令牌换员工身份；令牌不存在、或那个人已经不是员工了，都返回 false。
func (s *Store) GetStaffByToken(token string) (WxUser, bool, error) {
	token = strings.TrimSpace(token)
	if token == "" {
		return WxUser{}, false, nil
	}
	var u WxUser
	err := s.db.QueryRow(`SELECT openid,unionid,phone,nickname,avatar,role,created_at,updated_at,last_login_at
		FROM wx_user WHERE staff_token=? AND role=?`, token, RoleStaff).
		Scan(&u.OpenID, &u.UnionID, &u.Phone, &u.Nickname, &u.Avatar, &u.Role, &u.CreatedAt, &u.UpdatedAt, &u.LastLogin)
	if errors.Is(err, sql.ErrNoRows) {
		return WxUser{}, false, nil
	}
	if err != nil {
		return WxUser{}, false, err
	}
	return u, true, nil
}

// Courier 配送员（任务池⑧ / D25）：原来只存在浏览器 localStorage，换台设备就没人可派单。
type Courier struct {
	Name  string `json:"name"`
	Phone string `json:"phone,omitempty"`
}

// ListCouriers 配送员名单（按登记顺序）。
func (s *Store) ListCouriers() ([]Courier, error) {
	rows, err := s.db.Query(`SELECT name,phone FROM courier WHERE active=1 ORDER BY sort, name`)
	if err != nil {
		return nil, fmt.Errorf("查询配送员失败: %w", err)
	}
	defer rows.Close()
	out := []Courier{}
	for rows.Next() {
		var c Courier
		if err := rows.Scan(&c.Name, &c.Phone); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}

// SaveCourier 新增/修改配送员；remove=true 时删除。返回最新名单。
// 约束：姓名必填且 ≤ 12 字；至少保留一位（没有配送员就没法给配送单派单）。
func (s *Store) SaveCourier(name, phone string, remove bool) ([]Courier, error) {
	name = strings.TrimSpace(name)
	phone = strings.TrimSpace(phone)
	if name == "" {
		return nil, fmt.Errorf("%w: 配送员姓名不能为空", ErrBadInput)
	}
	if len([]rune(name)) > 12 {
		return nil, fmt.Errorf("%w: 配送员姓名不能超过 12 字", ErrBadInput)
	}
	if remove {
		var n int
		if err := s.db.QueryRow(`SELECT COUNT(*) FROM courier WHERE active=1`).Scan(&n); err != nil {
			return nil, fmt.Errorf("查询配送员失败: %w", err)
		}
		if n <= 1 {
			return nil, fmt.Errorf("%w: 至少要保留一位配送员", ErrConflict)
		}
		res, err := s.db.Exec(`DELETE FROM courier WHERE name=?`, name)
		if err != nil {
			return nil, fmt.Errorf("删除配送员失败: %w", err)
		}
		if k, _ := res.RowsAffected(); k == 0 {
			return nil, fmt.Errorf("%w: 配送员 %s", ErrNotFound, name)
		}
		return s.ListCouriers()
	}
	if _, err := s.db.Exec(`INSERT INTO courier (name,phone,sort,active)
		VALUES (?,?,COALESCE((SELECT MAX(sort) FROM courier),-1)+1,1)
		ON CONFLICT(name) DO UPDATE SET phone=excluded.phone, active=1`, name, phone); err != nil {
		return nil, fmt.Errorf("写入配送员失败: %w", err)
	}
	return s.ListCouriers()
}

// Settings 门店抬头 + 规则参数（小票表头与「钱」的口径都要跨设备一致，所以落库，D25）。
// 第 27 轮（单一真源）：把低库存阈值、起送价、配送费、免运费门槛一起随 GET /api/settings
// 下发，前端不再各自硬编码 5 / 30 / 3 这些数字。
type Settings struct {
	Name    string `json:"name"`
	Phone   string `json:"phone"`
	Address string `json:"address"`
	Footer  string `json:"footer"`
	// LowStock 低库存阈值（默认 5，取值 <=0 时回落到 LowStockThreshold）。
	LowStock float64 `json:"lowStock"`
	// MinOrder 起送价：货款低于它就拒单（0 或负数表示不限起送）。
	MinOrder float64 `json:"minOrder"`
	// DeliveryFee 未达门槛时的配送费；MinFree 免运费门槛（<=0 表示永不包邮）。
	DeliveryFee float64 `json:"deliveryFee"`
	MinFree     float64 `json:"minFree"`
}

// defaultSettings 门店抬头默认值，与前端 Admin.DEFAULT_STORE 保持一致。
var defaultSettings = Settings{
	Name: "家庭超市", Footer: "谢谢惠顾，欢迎再来！",
	LowStock: LowStockThreshold, MinOrder: 0, DeliveryFee: 3, MinFree: 30,
}

// 规则参数的 setting 键（第 27 轮）。起送价与低库存阈值可由老板在管理端改；
// 配送费/免运费门槛本轮仍以服务端配置（pricing.Config）为真源，只做下发。
const (
	settingMinOrder = "store.minOrder"
	settingLowStock = "store.lowStock"
)

// GetSettings 读门店抬头与规则参数；一项都没存过就用默认值。
// 返回值永远是「可以照着用」的全量配置：页面拿到就能直接显示，不必自己兜底。
func (s *Store) GetSettings() (Settings, error) {
	out := defaultSettings
	out.DeliveryFee = s.cfg.DeliveryFee
	out.MinFree = s.cfg.MinFree
	rows, err := s.db.Query(`SELECT k,v FROM setting WHERE k LIKE 'store.%'`)
	if err != nil {
		return out, fmt.Errorf("查询门店设置失败: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return out, err
		}
		switch k {
		case "store.name":
			if v != "" {
				out.Name = v
			}
		case "store.phone":
			out.Phone = v
		case "store.address":
			out.Address = v
		case "store.footer":
			if v != "" {
				out.Footer = v
			}
		case settingMinOrder:
			if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
				out.MinOrder = pricing.Round2(n)
			}
		case settingLowStock:
			if n, err := strconv.ParseFloat(v, 64); err == nil && n > 0 {
				out.LowStock = n
			}
		}
	}
	return out, rows.Err()
}

// SaveSettings 保存门店抬头与规则参数。店名必填且 ≤ 20 字（小票表头必须有店名），
// 页脚留空则回到默认那句（与前端 setStoreInfo 同规则）。
// 规则参数：MinOrder/LowStock 传 0 或负数表示「回默认」（不限起送 / 阈值 5），
// 这样管理端只改店名时不会把老板设过的起送价莫名其妙留着或清成怪值。
func (s *Store) SaveSettings(in Settings) (Settings, error) {
	in.Name = strings.TrimSpace(in.Name)
	in.Phone = strings.TrimSpace(in.Phone)
	in.Address = strings.TrimSpace(in.Address)
	in.Footer = strings.TrimSpace(in.Footer)
	if in.Name == "" {
		return Settings{}, fmt.Errorf("%w: 请填写店名", ErrBadInput)
	}
	if len([]rune(in.Name)) > 20 {
		return Settings{}, fmt.Errorf("%w: 店名不能超过 20 字", ErrBadInput)
	}
	if in.MinOrder < 0 {
		return Settings{}, fmt.Errorf("%w: 起送价不能为负数", ErrBadInput)
	}
	if in.LowStock < 0 {
		return Settings{}, fmt.Errorf("%w: 低库存阈值不能为负数", ErrBadInput)
	}
	if in.Footer == "" {
		in.Footer = defaultSettings.Footer
	}
	minOrder := 0.0
	if in.MinOrder > 0 {
		minOrder = pricing.Round2(in.MinOrder)
	}
	lowStock := 0.0
	if in.LowStock > 0 {
		lowStock = in.LowStock
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Settings{}, fmt.Errorf("开启设置事务失败: %w", err)
	}
	defer tx.Rollback()
	for _, kv := range [][2]string{
		{"store.name", in.Name}, {"store.phone", in.Phone},
		{"store.address", in.Address}, {"store.footer", in.Footer},
		{settingMinOrder, strconv.FormatFloat(minOrder, 'f', -1, 64)},
		{settingLowStock, strconv.FormatFloat(lowStock, 'f', -1, 64)},
	} {
		if _, err := tx.Exec(`INSERT INTO setting (k,v) VALUES (?,?)
			ON CONFLICT(k) DO UPDATE SET v=excluded.v`, kv[0], kv[1]); err != nil {
			return Settings{}, fmt.Errorf("写入门店设置失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Settings{}, fmt.Errorf("提交设置事务失败: %w", err)
	}
	return s.GetSettings()
}

// minOrderTx 在事务里读起送价（POST /api/orders 用）：老板改完立刻生效，不必重启。
// 没配、解析失败或 <=0 都表示「不限起送」。
func (s *Store) minOrderTx(tx *sql.Tx) float64 {
	var v string
	if err := tx.QueryRow(`SELECT v FROM setting WHERE k=?`, settingMinOrder).Scan(&v); err != nil {
		return 0
	}
	n, err := strconv.ParseFloat(strings.TrimSpace(v), 64)
	if err != nil || n <= 0 {
		return 0
	}
	return pricing.Round2(n)
}

// trimFloat 把金额格式化成最短的十进制字符串（12.30 → "12.3"），用于「还差 X 元起送」
// 这类给人看的错误文案，避免 %v 打出 12.340000000000001 这种浮点噪声。
func trimFloat(v float64) string {
	return strconv.FormatFloat(pricing.Round2(v), 'f', -1, 64)
}

// ListAddresses 列出某手机号的收货地址簿，默认地址排最前（D18）。
func (s *Store) ListAddresses(phone string) ([]Address, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return nil, fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	rows, err := s.db.Query(`SELECT id,phone,contact,address,is_default,created_at,updated_at
		FROM customer_address WHERE phone = ? ORDER BY is_default DESC, id ASC`, phone)
	if err != nil {
		return nil, fmt.Errorf("查询收货地址失败: %w", err)
	}
	defer rows.Close()
	out := []Address{}
	for rows.Next() {
		var a Address
		var def int
		if err := rows.Scan(&a.ID, &a.Phone, &a.Contact, &a.Address, &def, &a.CreatedAt, &a.UpdatedAt); err != nil {
			return nil, fmt.Errorf("读取收货地址失败: %w", err)
		}
		a.IsDefault = def == 1
		out = append(out, a)
	}
	return out, rows.Err()
}

// SaveAddress 新增或修改一条收货地址（D18）。
// 语义：同一手机号的第一条地址自动成为默认；is_default=true 时把其它条目的默认标记清掉；
// 不传 is_default 的编辑不会摘掉现有默认标记（避免「改个门牌把默认地址弄丢」）。
func (s *Store) SaveAddress(a Address) (Address, error) {
	a.Phone = strings.TrimSpace(a.Phone)
	a.Contact = strings.TrimSpace(a.Contact)
	a.Address = strings.TrimSpace(a.Address)
	if a.Phone == "" {
		return Address{}, fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	if a.Contact == "" {
		return Address{}, fmt.Errorf("%w: 收货人不能为空", ErrBadInput)
	}
	if len([]rune(a.Contact)) > 20 {
		return Address{}, fmt.Errorf("%w: 收货人不能超过 20 字", ErrBadInput)
	}
	if a.Address == "" {
		return Address{}, fmt.Errorf("%w: 送货地址不能为空", ErrBadInput)
	}
	if len([]rune(a.Address)) > 120 {
		return Address{}, fmt.Errorf("%w: 送货地址不能超过 120 字", ErrBadInput)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return Address{}, fmt.Errorf("保存地址失败: %w", err)
	}
	defer tx.Rollback()
	var count int
	if err := tx.QueryRow(`SELECT COUNT(*) FROM customer_address WHERE phone = ?`, a.Phone).Scan(&count); err != nil {
		return Address{}, fmt.Errorf("查询地址数失败: %w", err)
	}
	if count == 0 {
		a.IsDefault = true // 第一条地址就是默认地址
	}
	a.UpdatedAt = nowStr()
	if a.ID == 0 {
		if a.CreatedAt == "" {
			a.CreatedAt = a.UpdatedAt
		}
		r, err := tx.Exec(`INSERT INTO customer_address (phone,contact,address,is_default,created_at,updated_at)
			VALUES (?,?,?,?,?,?)`, a.Phone, a.Contact, a.Address, boolInt(a.IsDefault), a.CreatedAt, a.UpdatedAt)
		if err != nil {
			return Address{}, fmt.Errorf("新增地址失败: %w", err)
		}
		a.ID, err = r.LastInsertId()
		if err != nil {
			return Address{}, fmt.Errorf("新增地址失败: %w", err)
		}
	} else {
		var r sql.Result
		if a.IsDefault {
			r, err = tx.Exec(`UPDATE customer_address SET contact=?,address=?,is_default=1,updated_at=?
				WHERE id=? AND phone=?`, a.Contact, a.Address, a.UpdatedAt, a.ID, a.Phone)
		} else {
			r, err = tx.Exec(`UPDATE customer_address SET contact=?,address=?,updated_at=?
				WHERE id=? AND phone=?`, a.Contact, a.Address, a.UpdatedAt, a.ID, a.Phone)
		}
		if err != nil {
			return Address{}, fmt.Errorf("修改地址失败: %w", err)
		}
		if n, _ := r.RowsAffected(); n == 0 {
			return Address{}, fmt.Errorf("%w: 地址不存在", ErrNotFound)
		}
	}
	if a.IsDefault {
		if _, err := tx.Exec(`UPDATE customer_address SET is_default=0 WHERE phone=? AND id<>?`, a.Phone, a.ID); err != nil {
			return Address{}, fmt.Errorf("设置默认地址失败: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return Address{}, fmt.Errorf("保存地址失败: %w", err)
	}
	// 回读一次，返回库里的事实（含自动补上的 created_at）
	return s.GetAddress(a.Phone, a.ID)
}

// GetAddress 按编号取一条地址。
func (s *Store) GetAddress(phone string, id int64) (Address, error) {
	var a Address
	var def int
	err := s.db.QueryRow(`SELECT id,phone,contact,address,is_default,created_at,updated_at
		FROM customer_address WHERE id=? AND phone=?`, id, strings.TrimSpace(phone)).
		Scan(&a.ID, &a.Phone, &a.Contact, &a.Address, &def, &a.CreatedAt, &a.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return Address{}, fmt.Errorf("%w: 地址不存在", ErrNotFound)
	}
	if err != nil {
		return Address{}, fmt.Errorf("查询地址失败: %w", err)
	}
	a.IsDefault = def == 1
	return a, nil
}

// DeleteAddress 删除一条地址；删掉的若是默认地址，自动把剩下最早的一条顶为默认（D18）。
func (s *Store) DeleteAddress(phone string, id int64) error {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	if id <= 0 {
		return fmt.Errorf("%w: 地址编号不合法", ErrBadInput)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("删除地址失败: %w", err)
	}
	defer tx.Rollback()
	var def int
	err = tx.QueryRow(`SELECT is_default FROM customer_address WHERE id=? AND phone=?`, id, phone).Scan(&def)
	if errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("%w: 地址不存在", ErrNotFound)
	}
	if err != nil {
		return fmt.Errorf("查询地址失败: %w", err)
	}
	if _, err := tx.Exec(`DELETE FROM customer_address WHERE id=? AND phone=?`, id, phone); err != nil {
		return fmt.Errorf("删除地址失败: %w", err)
	}
	if def == 1 {
		if _, err := tx.Exec(`UPDATE customer_address SET is_default=1
			WHERE id = (SELECT id FROM customer_address WHERE phone=? ORDER BY id ASC LIMIT 1)`, phone); err != nil {
			return fmt.Errorf("顶替默认地址失败: %w", err)
		}
	}
	return tx.Commit()
}

// RecordSyncBatch 记录一次同步批次（M3 对账结果入库）。
func (s *Store) RecordSyncBatch(kind, filename string, total, ok, diff int) error {
	_, err := s.db.Exec(`INSERT INTO sync_batch (kind,filename,total,ok,diff,created_at) VALUES (?,?,?,?,?,?)`,
		kind, filename, total, ok, diff, nowStr())
	return err
}

/* ------------------------------ 地址簿能力令牌（第 27 轮） ------------------------------ */

// AddressKey 能力令牌：手机号是「谁」，令牌是「凭据」。
// 手机号是能被猜到的（一串 11 位数字），只拿手机号就能读写别人的收货地址簿
// （姓名+门牌）显然是泄漏；所以第一次保存地址时服务端发一枚 32 位 hex 随机令牌，
// 客户端存本地、之后读写地址簿都要带上。令牌丢了不影响历史订单（订单地址是快照）。
//
// 设计取舍：令牌**不是**登录凭据，只保护地址簿这一个能力面；手机号用户依然能
// 不登录直接下单（延续 D18 的「少打字优先」），只是看不到别人存过的地址。
// GetAddressKey 取某手机号的令牌；没发过返回空串（不是错误）。
func (s *Store) GetAddressKey(phone string) (string, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return "", nil
	}
	var key string
	err := s.db.QueryRow(`SELECT key FROM addr_key WHERE phone=?`, phone).Scan(&key)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	if err != nil {
		return "", fmt.Errorf("读取地址令牌失败: %w", err)
	}
	return key, nil
}

// EnsureAddressKey 取令牌，没有就生成一枚并持久化（POST /api/addresses 用）。
// 已发过的手机号**复用同一枚**，不轮换——否则顾客换台设备就读不到自己的地址了。
func (s *Store) EnsureAddressKey(phone string) (string, error) {
	phone = strings.TrimSpace(phone)
	if phone == "" {
		return "", fmt.Errorf("%w: 手机号不能为空", ErrBadInput)
	}
	if key, err := s.GetAddressKey(phone); err != nil || key != "" {
		return key, err
	}
	buf := make([]byte, 16) // 16 字节 = 32 位 hex
	if _, err := rand.Read(buf); err != nil {
		return "", fmt.Errorf("生成地址令牌失败: %w", err)
	}
	key := hex.EncodeToString(buf)
	// ON CONFLICT DO NOTHING + 回读：并发首次保存时以先落库的那枚为准。
	if _, err := s.db.Exec(`INSERT INTO addr_key (phone,key,created_at) VALUES (?,?,?)
		ON CONFLICT(phone) DO NOTHING`, phone, key, nowStr()); err != nil {
		return "", fmt.Errorf("保存地址令牌失败: %w", err)
	}
	return s.GetAddressKey(phone)
}

// CheckAddressKey 校验「手机号 + 令牌」是否匹配。手机号没发过令牌时返回 false
// （而不是「无令牌即放行」——那等于没有这道门）。
func (s *Store) CheckAddressKey(phone, key string) (bool, error) {
	phone = strings.TrimSpace(phone)
	key = strings.TrimSpace(key)
	if phone == "" || key == "" {
		return false, nil
	}
	var want string
	err := s.db.QueryRow(`SELECT key FROM addr_key WHERE phone=?`, phone).Scan(&want)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("读取地址令牌失败: %w", err)
	}
	return want == key, nil
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

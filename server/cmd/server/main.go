// Command server 独立小程序商城后端（M4）。
//
// 只用标准库：net/http + database/sql(modernc.org/sqlite)。
// 启动：ADDR=127.0.0.1:8093 DB_PATH=./data/sdy.db ./server
// 云端条码：BARCODE_APPCODE=xxx（不配置则纯本地模式，离线可用）。
package main

import (
	"bytes"
	"context"
	"encoding/csv"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/kiddyt00/sdy/server/internal/barcode"
	"github.com/kiddyt00/sdy/server/internal/pricing"
	"github.com/kiddyt00/sdy/server/internal/store"
)

func main() {
	addr := getenv("ADDR", "127.0.0.1:8093")
	dbPath := getenv("DB_PATH", filepath.Join("data", "sdy.db"))
	gateway := getenv("BARCODE_GATEWAY", "https://gscode.market.alicloudapi.com/getBarcode")
	appcode := os.Getenv("BARCODE_APPCODE")
	staticDir := getenv("STATIC_DIR", ".")

	// 微信登录（第 23 轮 / D28）：AppID 是公开信息，AppSecret 只从环境变量读，
	// 绝不落库、绝不进日志（D13）。WX_API_BASE 可注入，便于测试用假微信服务器。
	wxc := wxConf{
		appid:   strings.TrimSpace(os.Getenv("WX_APPID")),
		secret:  strings.TrimSpace(os.Getenv("WX_SECRET")),
		apiBase: strings.TrimRight(getenv("WX_API_BASE", "https://api.weixin.qq.com"), "/"),
		client:  &http.Client{Timeout: 8 * time.Second},
	}
	if wxc.ready() {
		log.Printf("微信登录已启用（AppID %s）", wxc.appid)
	} else {
		log.Printf("微信登录未配置（缺少 WX_APPID / WX_SECRET，/api/wx/login 会返回 503）")
	}

	if dir := filepath.Dir(dbPath); dir != "" && dir != "." {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			log.Fatalf("创建数据目录失败: %v", err)
		}
	}
	st, err := store.Open(dbPath, pricing.DefaultConfig())
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	if err := seedIfEmpty(st); err != nil {
		log.Fatalf("初始化示例商品失败: %v", err)
	}

	var cloud barcode.CloudFunc
	if appcode != "" {
		cloud = aliCloud(gateway, appcode)
		log.Printf("条码云端已启用: %s", gateway)
	} else {
		log.Printf("条码云端未配置（纯本地模式，字典层仍可永久沉淀）")
	}
	resolver := barcode.New(st, barcode.DefaultConfig(), cloud)

	srv := &http.Server{
		Addr:              addr,
		Handler:           withCORS(withLogging(routes(st, resolver, staticDir, appcode != "", wxc))),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	// 优雅退出：容器滚动更新时不丢请求
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	go func() {
		log.Printf("商城后端已启动 http://%s", addr)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("监听失败: %v", err)
		}
	}()
	<-stop
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_ = srv.Shutdown(ctx)
	log.Printf("已优雅退出")
}

/* ------------------------------ 路由 ------------------------------ */

// orderResp 下单响应（第 27 轮幂等）：订单字段仍然平铺在顶层（嵌入 store.Order），
// 只有「这次是重复提交、返回的是原来那张单」时才多一个 duplicated 标记。
type orderResp struct {
	store.Order
	Duplicated bool `json:"duplicated,omitempty"`
}

// addressResp 保存地址的响应（第 27 轮地址簿能力令牌）：地址字段平铺（嵌入 store.Address），
// 另带 ok 与 key——key 只在第一次保存该手机号的地址时生成，之后每次都是同一个。
type addressResp struct {
	store.Address
	OK  bool   `json:"ok"`
	Key string `json:"key,omitempty"`
}

func routes(st *store.Store, res *barcode.Resolver, staticDir string, cloudEnabled bool, wxc wxConf) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"ok": true, "time": time.Now().Format(time.RFC3339),
			"circuitOpen": res.CircuitOpen(), "cloudFails": res.Fails(),
			"cloudConfigured": cloudEnabled,
		})
	})

	// 管理端鉴权通道（第 27 轮，默认关）：口令没配 → 两个端点都如实返回「通道未启用」，
	// 管理接口一律放行（见 adminauth.go）。这两个端点**永远公开**，否则没人能登录。
	mux.HandleFunc("/api/admin/login", adminLogin)
	mux.HandleFunc("/api/admin/logout", adminLogout)

	// 商品：列表 / 建档 / 手动改库存（D8）
	mux.HandleFunc("/api/products", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// onSale=1 只回上架商品（顾客端商城用，D23）；不带参数回全量（管理端用）。
			// phone 带上时按该顾客等级给有效价 price（D24）；不带 phone 一律零售价。
			// 第 28 轮（§7.2）扩参：sort/limit/offset + 真实 total/hasMore，全部向后兼容。
			query := r.URL.Query()
			sort := strings.TrimSpace(query.Get("sort"))
			if sort == "" {
				sort = store.ProductSortDefault
			}
			if !store.ValidProductSort(sort) {
				writeJSON(w, 400, map[string]string{"error": "排序方式不支持：" + sort})
				return
			}
			limit, msg := queryCount(r, "limit", 0)
			if msg != "" {
				writeJSON(w, 400, map[string]string{"error": msg})
				return
			}
			offset, msg := queryCount(r, "offset", 0)
			if msg != "" {
				writeJSON(w, 400, map[string]string{"error": msg})
				return
			}
			if limit > 200 {
				limit = 200 // 上限 200：一页最多 200 件，再多请翻页
			}
			// 价格口径的唯一真源在服务端：页面只读 price，不自己拿批发价换算（D12/D24）。
			phone := strings.TrimSpace(query.Get("phone"))
			tier, err := tierForPhone(st, phone)
			if err != nil {
				writeErr(w, err)
				return
			}
			list, total, err := st.ListProductsFiltered(store.ProductFilter{
				Keyword:    query.Get("keyword"),
				Category:   query.Get("category"),
				OnSaleOnly: query.Get("onSale") == "1",
				Sort:       sort,
				Tier:       tier,
				Limit:      limit,
				Offset:     offset,
			})
			if err != nil {
				writeErr(w, err)
				return
			}
			// 只有带 phone 的请求才在条目上改写价格/等级：不带 phone 时行内 price 已是零售价
			// （scanProduct 的默认），多写一个 tier 字段会改变老响应的形状。
			if phone != "" {
				applyTier(list, tier)
			}
			hasMore := limit > 0 && offset+len(list) < total
			writeJSON(w, 200, map[string]any{
				"items": list, "total": total, "limit": limit, "offset": offset,
				"hasMore": hasMore, "tier": tier,
			})
		case http.MethodPost:
			// 建档 / 编辑商品档案（任务池①）。
			// 管理端接口（第 27 轮）：ADMIN_PASSWORD 没配时放行，配了就要管理员 Cookie。
			if !adminGate(w, r) {
				return
			}
			// stock 用指针区分「没传」与「传 0」：编辑表单不带库存时不覆盖现有库存
			// （不变量：编辑档案不改库存，库存只走 /api/products/stock）。
			// 上下架同理：本接口不认 onSale，改状态只走 /api/products/onsale（D23）。
			var req struct {
				Code           string   `json:"code"`
				Name           string   `json:"name"`
				Brand          string   `json:"brand"`
				Spec           string   `json:"spec"`
				Category       string   `json:"category"`
				Img            string   `json:"img"`
				CostPrice      float64  `json:"costPrice"`
				SalePrice      float64  `json:"salePrice"`
				WholesalePrice float64  `json:"wholesalePrice"`
				RefPrice       float64  `json:"refPrice"`
				Unit           string   `json:"unit"`
				Stock          *float64 `json:"stock"`
				IsWholesale    bool     `json:"isWholesale"`
			}
			if !decode(w, r, &req) {
				return
			}
			stock := 0.0
			if req.Stock != nil {
				stock = *req.Stock
			} else if cur, err := st.GetProduct(strings.TrimSpace(req.Code)); err == nil {
				stock = cur.Stock
			}
			saved, err := st.UpsertProduct(store.Product{
				Code: req.Code, Name: req.Name, Brand: req.Brand, Spec: req.Spec, Category: req.Category,
				Img: req.Img, CostPrice: req.CostPrice, SalePrice: req.SalePrice,
				WholesalePrice: req.WholesalePrice, RefPrice: req.RefPrice,
				Unit: req.Unit, Stock: stock, IsWholesale: req.IsWholesale,
				SyncStatus: "pending", // 档案变更 → 待与牵牛花核对（D3 月度对账）
			})
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, saved)
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	mux.HandleFunc("/api/products/stock", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Code  string  `json:"code"`
			Stock float64 `json:"stock"`
		}
		if !decode(w, r, &in) {
			return
		}
		p, err := st.SetStock(in.Code, in.Stock)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, p)
	}))

	// 库存变更（任务池⑧，D25）：入库 / 改数 / 盘点都走这一个入口，
	// 服务端在一个事务里改库存 + 写流水。以前在线模式只用 SetStock 盖绝对值，
	// 「为什么改」的审计只落在浏览器里，换台设备就查不到账。
	mux.HandleFunc("/api/stock/change", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Code   string  `json:"code"`
			Kind   string  `json:"kind"`
			Qty    float64 `json:"qty"`
			Reason string  `json:"reason"`
			By     string  `json:"by"`
		}
		if !decode(w, r, &in) {
			return
		}
		entry, err := st.ChangeStock(in.Code, in.Kind, in.Qty, in.Reason, in.By)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "entry": entry, "stock": entry.After})
	}))

	// 库存流水（任务池⑧，D25）：GET /api/stocklog?limit=30，最新在前。
	mux.HandleFunc("/api/stocklog", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
		list, err := st.ListStockLog(limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
	}))

	// 配送员名单（任务池⑧，D25）：GET 列表 / POST 新增或删除（remove=true）。
	mux.HandleFunc("/api/couriers", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			list, err := st.ListCouriers()
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
		case http.MethodPost:
			var in struct {
				Name   string `json:"name"`
				Phone  string `json:"phone"`
				Remove bool   `json:"remove"`
			}
			if !decode(w, r, &in) {
				return
			}
			list, err := st.SaveCourier(in.Name, in.Phone, in.Remove)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true, "items": list, "total": len(list)})
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	}))

	// 门店抬头（任务池⑧，D25）：小票表头，跨设备要一致，所以落库。
	mux.HandleFunc("/api/settings", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			s, err := st.GetSettings()
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, s)
		case http.MethodPost:
			// 管理端接口（第 27 轮）：ADMIN_PASSWORD 没配时放行，配了就要管理员 Cookie。
			if !adminGate(w, r) {
				return
			}
			var in struct {
				Name    string `json:"name"`
				Phone   string `json:"phone"`
				Address string `json:"address"`
				Footer  string `json:"footer"`
				// 规则参数（第 27 轮，单一真源）：低库存阈值与起送价。
				// 用指针区分「这次没传」（保留现值）与「显式传 0」（回落到服务端默认）。
				LowStock *float64 `json:"lowStock"`
				MinOrder *float64 `json:"minOrder"`
			}
			if !decode(w, r, &in) {
				return
			}
			cur, err := st.GetSettings()
			if err != nil {
				writeErr(w, err)
				return
			}
			next := store.Settings{
				Name: in.Name, Phone: in.Phone, Address: in.Address, Footer: in.Footer,
				LowStock: cur.LowStock, MinOrder: cur.MinOrder,
			}
			if in.LowStock != nil {
				next.LowStock = *in.LowStock
			}
			if in.MinOrder != nil {
				next.MinOrder = *in.MinOrder
			}
			saved, err := st.SaveSettings(next)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, saved)
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	// 批量上下架（任务池⑥，D23）：POST /api/products/onsale {codes:[...], onSale:true|false}
	mux.HandleFunc("/api/products/onsale", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Codes  []string `json:"codes"`
			OnSale bool     `json:"onSale"`
		}
		if !decode(w, r, &in) {
			return
		}
		changed, err := st.SetProductsOnSale(in.Codes, in.OnSale)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "onSale": in.OnSale, "changed": changed, "count": len(changed),
		})
	}))

	// 商品档案删除（D16）：DELETE /api/products/{code}
	// 商品分类（顾客端分类页，第 24 轮）：/api/products/categories?onSale=1
	mux.HandleFunc("/api/products/categories", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		items, err := st.ListCategories(r.URL.Query().Get("onSale") == "1")
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": len(items)})
	})

	// 热销榜（第 28 轮 §7.3）：首页「热销」与「无结果推荐」共用，口径与 sort=hot 完全一致。
	// limit 默认 8、最大 20；只回上架商品。
	mux.HandleFunc("/api/products/hot", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		limit, msg := queryCount(r, "limit", 8)
		if msg != "" {
			writeJSON(w, 400, map[string]string{"error": msg})
			return
		}
		if limit > 20 {
			limit = 20
		}
		phone := strings.TrimSpace(r.URL.Query().Get("phone"))
		tier, err := tierForPhone(st, phone)
		if err != nil {
			writeErr(w, err)
			return
		}
		list, total, err := st.ListProductsFiltered(store.ProductFilter{
			OnSaleOnly: true, Sort: store.ProductSortHot, Tier: tier, Limit: limit,
		})
		if err != nil {
			writeErr(w, err)
			return
		}
		if phone != "" {
			applyTier(list, tier)
		}
		writeJSON(w, 200, map[string]any{"items": list, "total": total})
	})

	// 缺货替代推荐（第 28 轮 §7.4）：规则全在 store（同分类优先 + 全店热销补足、不重复）。
	// code 缺失或商品不存在 → 200 空列表（页面要能安静降级，不是 400）。
	mux.HandleFunc("/api/products/alternatives", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		limit, msg := queryCount(r, "limit", 5)
		if msg != "" {
			writeJSON(w, 400, map[string]string{"error": msg})
			return
		}
		items, total, err := st.ListProductAlternatives(r.URL.Query().Get("code"), limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": items, "total": total})
	})

	// 单个商品：只读详情（顾客端商品详情页）+ 删除（管理端）。
	// 约束由 store 层把关：删除必须先盘点为 0、不能有进行中的订单。
	mux.HandleFunc("/api/products/", func(w http.ResponseWriter, r *http.Request) {
		code := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/products/"), "/")
		if code == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少条码"})
			return
		}
		switch r.Method {
		case http.MethodGet:
			p, err := st.GetProduct(code)
			if err != nil {
				writeErr(w, err)
				return
			}
			// 价格口径与列表完全一致：带 phone 按该顾客等级算有效价（D12/D24），页面只读 price。
			phone := strings.TrimSpace(r.URL.Query().Get("phone"))
			tier := pricing.TierRetail
			if phone != "" {
				if tier, err = st.GetCustomerTier(phone); err != nil {
					writeErr(w, err)
					return
				}
			}
			p.Tier = tier
			p.Price = pricing.EffectivePrice(tier, p.SalePrice, p.WholesalePrice)
			writeJSON(w, 200, p)
		case http.MethodDelete:
			// 管理端接口（第 27 轮）：删档案是不可逆操作，必须先过管理员闸门。
			if !adminGate(w, r) {
				return
			}
			if err := st.DeleteProduct(code); err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"ok": true, "code": code})
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	// 订单：列表 / 下单 / 详情 / 状态流转
	// 第 27 轮：订单接口一律先解析身份（管理员 > 员工令牌 > openid→手机号 > phone 参数）。
	// 顾客只能看/改自己的单；员工与管理员看全量——以前谁都能读全站订单（含姓名手机地址）。
	mux.HandleFunc("/api/orders", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			ident, ok := identityOf(w, r, st)
			if !ok {
				return
			}
			if !ident.Admin && ident.Phone == "" {
				writeJSON(w, 400, map[string]string{"error": "缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token"})
				return
			}
			// 第 28 轮（§7.5）新增筛选：q/status/date/from/to/type。
			// 这些参数**只做筛选、绝不参与身份判定**；身份永远走上面那一行的第 27 轮规则。
			// 顾客身份下先归属过滤（f.Phone）再筛选，所以顾客传 q=别人的手机号也拿不到别人的单。
			query := r.URL.Query()
			f := store.OrderFilter{
				Status: strings.TrimSpace(query.Get("status")),
				Q:      strings.TrimSpace(query.Get("q")),
				Date:   strings.TrimSpace(query.Get("date")),
				From:   strings.TrimSpace(query.Get("from")),
				To:     strings.TrimSpace(query.Get("to")),
				Type:   strings.TrimSpace(query.Get("type")),
				Limit:  queryInt(r, "limit", 50),
				Offset: queryInt(r, "offset", 0),
			}
			if msg := badDateMsg(f); msg != "" {
				writeJSON(w, 400, map[string]string{"error": msg})
				return
			}
			if f.Limit > 200 {
				f.Limit = 200 // 上限 200：一页最多 200 单，再多请翻页
			}
			if !ident.Admin {
				f.Phone = ident.Phone // 顾客只看自己的单
			}
			list, total, err := st.ListOrdersFiltered(f)
			if err != nil {
				writeErr(w, err)
				return
			}
			// total 是「符合条件的总数」，不是本页条数（第 27 轮修）。
			writeJSON(w, 200, map[string]any{
				"items": list, "total": total, "limit": f.Limit, "offset": f.Offset,
			})
		case http.MethodPost:
			var in store.NewOrderInput
			if !decode(w, r, &in) {
				return
			}
			o, err := st.CreateOrder(in)
			if err != nil {
				// 幂等命中（第 27 轮）：同一个 clientToken 已经出过单了——把原来那张单按 200
				// 返回，并标记 duplicated，绝不重复扣库存。重复点击/断网重试都走这条路。
				if errors.Is(err, store.ErrDuplicated) {
					prev, gerr := st.GetOrderByClientToken(in.ClientToken)
					if gerr != nil {
						writeErr(w, gerr)
						return
					}
					writeJSON(w, 200, orderResp{Order: prev, Duplicated: true})
					return
				}
				// 库存不足按 400 回（第 27 轮契约）：这是「这一单下不了」的入参结果，
				// 不是资源冲突；文案要说清哪件商品、还剩多少，顾客端直接展示。
				if errors.Is(err, store.ErrStockLess) {
					writeJSON(w, 400, map[string]string{"error": err.Error()})
					return
				}
				writeErr(w, err)
				return
			}
			writeJSON(w, 201, orderResp{Order: o})
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	// 订单导出（第 28 轮 §7.6）：同一套筛选参数 + limit（默认 2000、最大 5000）。
	// 身份走 adminGate（与后台其他接口一致；未配 ADMIN_PASSWORD 时灰度放行——已如实披露）。
	// 注意：这个字面量路由比下面的 /api/orders/ 前缀更具体，Go 1.22+ ServeMux 会优先命中它。
	mux.HandleFunc("/api/orders/export.csv", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		if !adminGate(w, r) {
			return
		}
		query := r.URL.Query()
		limit, msg := queryCount(r, "limit", 2000)
		if msg != "" {
			writeJSON(w, 400, map[string]string{"error": msg})
			return
		}
		if limit > 5000 {
			limit = 5000
		}
		f := store.OrderFilter{
			Status: strings.TrimSpace(query.Get("status")),
			Q:      strings.TrimSpace(query.Get("q")),
			Date:   strings.TrimSpace(query.Get("date")),
			From:   strings.TrimSpace(query.Get("from")),
			To:     strings.TrimSpace(query.Get("to")),
			Type:   strings.TrimSpace(query.Get("type")),
			Limit:  limit,
		}
		if msg := badDateMsg(f); msg != "" {
			writeJSON(w, 400, map[string]string{"error": msg})
			return
		}
		list, _, err := st.ListOrdersFiltered(f)
		if err != nil {
			writeErr(w, err)
			return
		}
		var buf bytes.Buffer
		// 首三字节 BOM：Excel 打开 UTF-8 CSV 靠它才不乱码（§7.6 硬要求）。
		buf.Write([]byte{0xEF, 0xBB, 0xBF})
		// RFC4180 转义交给标准库：字段含 , " 换行时自动用 " 包裹、内部 " 写成 ""。
		cw := csv.NewWriter(&buf)
		cw.UseCRLF = true
		_ = cw.Write(csvHeader)
		for _, o := range list {
			var detail strings.Builder
			qty := 0.0
			for _, it := range o.Items {
				detail.WriteString(it.Name + "×" + numText(it.Qty) + ";")
				qty += it.Qty
			}
			_ = cw.Write([]string{
				o.ID, csvTime(o.CreatedAt), pricing.StatusText(o.Status), o.CustomerName, o.Phone,
				deliveryText(o.DeliveryType), detail.String(), numText(qty),
				fmt.Sprintf("%.2f", o.Subtotal), fmt.Sprintf("%.2f", o.DeliveryFee),
				fmt.Sprintf("%.2f", o.Total), "",
			})
		}
		cw.Flush()
		w.Header().Set("Content-Type", "text/csv; charset=utf-8")
		w.Header().Set("Content-Disposition", `attachment; filename="orders-`+time.Now().Format("20060102-1504")+`.csv"`)
		w.WriteHeader(200)
		_, _ = w.Write(buf.Bytes())
	})

	mux.HandleFunc("/api/orders/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/orders/"), "/")
		action := ""
		id := path
		for _, a := range []string{"advance", "cancel"} {
			if strings.HasSuffix(path, "/"+a) {
				action = a
				id = strings.TrimSuffix(path, "/"+a)
				break
			}
		}
		if id == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少订单号"})
			return
		}
		ident, ok := identityOf(w, r, st)
		if !ok {
			return
		}
		switch action {
		case "cancel":
			if r.Method != http.MethodPost {
				writeJSON(w, 405, map[string]string{"error": "方法不支持"})
				return
			}
			o, err := st.GetOrder(id)
			if err != nil {
				writeErr(w, err)
				return
			}
			// 顾客只能取消自己的单；不是自己的单一律按「不存在」处理，不泄露订单是否存在。
			if !ident.Admin && !orderBelongsTo(o, ident) {
				writeJSON(w, 404, map[string]string{"error": "订单不存在"})
				return
			}
			cancelled, err := st.CancelOrder(id, ident.Operator())
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, cancelled)
			return
		case "advance":
			if r.Method != http.MethodPost {
				writeJSON(w, 405, map[string]string{"error": "方法不支持"})
				return
			}
			var in struct {
				To string `json:"to"`
			}
			if !decode(w, r, &in) {
				return
			}
			o, err := st.GetOrder(id)
			if err != nil {
				writeErr(w, err)
				return
			}
			// 员工/管理员可以推任何状态；顾客只能「确认收货」（done）自己那一单——
			// 备货、发货、取消都是店主的活。
			if !ident.Admin && !(orderBelongsTo(o, ident) && in.To == pricing.StatusDone) {
				writeJSON(w, 403, map[string]string{"error": "只有店主可以推进订单状态"})
				return
			}
			advanced, err := st.AdvanceOrder(id, in.To)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, advanced)
			return
		}
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		o, err := st.GetOrder(id)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !ident.Admin && !orderBelongsTo(o, ident) {
			writeJSON(w, 404, map[string]string{"error": "订单不存在"})
			return
		}
		writeJSON(w, 200, o)
	})

	// 顾客收货地址簿（D18）：按手机号归档，顾客端一键带出。
	// 只服务「少打字」：订单地址仍是下单当时的快照，改地址簿不影响历史订单。
	// 第 27 轮：读/删要凭「地址簿能力令牌」——首次保存地址时服务端发一枚 32 位 hex key，
	// 之后凭 phone+key 才读得到。没 key 一律静默空信封（不告诉调用方这个号有没有地址）。
	mux.HandleFunc("/api/addresses", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			phone := strings.TrimSpace(r.URL.Query().Get("phone"))
			if phone == "" {
				writeJSON(w, 400, map[string]string{"error": "手机号不能为空"})
				return
			}
			ident, ok := identityOf(w, r, st)
			if !ok {
				return
			}
			allowed, err := addressAllowed(r, st, ident, phone)
			if err != nil {
				writeErr(w, err)
				return
			}
			if !allowed {
				writeJSON(w, 200, map[string]any{"items": []store.Address{}, "total": 0})
				return
			}
			list, err := st.ListAddresses(phone)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
		case http.MethodPost:
			var in store.Address
			if !decode(w, r, &in) {
				return
			}
			saved, err := st.SaveAddress(in)
			if err != nil {
				writeErr(w, err)
				return
			}
			// 保存成功才发/复用能力令牌：第一次生成，之后每次都回同一枚。
			key, err := st.EnsureAddressKey(saved.Phone)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, addressResp{Address: saved, OK: true, Key: key})
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	mux.HandleFunc("/api/addresses/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		raw := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/addresses/"), "/")
		if raw == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少地址编号"})
			return
		}
		id, err := strconv.ParseInt(raw, 10, 64)
		if err != nil {
			writeJSON(w, 400, map[string]string{"error": "地址编号不合法"})
			return
		}
		phone := strings.TrimSpace(r.URL.Query().Get("phone"))
		if phone == "" {
			writeJSON(w, 400, map[string]string{"error": "手机号不能为空"})
			return
		}
		ident, ok := identityOf(w, r, st)
		if !ok {
			return
		}
		allowed, err := addressAllowed(r, st, ident, phone)
		if err != nil {
			writeErr(w, err)
			return
		}
		if !allowed {
			// 与读同理：不是自己的号（或没带 key）就按「地址不存在」处理，不泄露存在性。
			writeJSON(w, 404, map[string]string{"error": "地址不存在"})
			return
		}
		if err := st.DeleteAddress(phone, id); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "id": id})
	})

	// 顾客等级（任务池⑦，D24）：GET 列表 / POST 设定。
	// 等级只影响之后下单的有效价，历史订单价格是下单当时的快照。
	mux.HandleFunc("/api/customers", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		list, err := st.ListCustomers()
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
	}))

	mux.HandleFunc("/api/customers/tier", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Phone string `json:"phone"`
			Name  string `json:"name"`
			Tier  string `json:"tier"`
		}
		if !decode(w, r, &in) {
			return
		}
		saved, err := st.SetCustomerTier(in.Phone, in.Name, in.Tier)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, saved)
	}))

	// 顾客备注与标签（任务池⑧，D25）：等级走上面的 /tier，这里只维护 tags/note。
	mux.HandleFunc("/api/customers/note", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Phone string `json:"phone"`
			Name  string `json:"name"`
			Tags  string `json:"tags"`
			Note  string `json:"note"`
		}
		if !decode(w, r, &in) {
			return
		}
		saved, err := st.SetCustomerNote(in.Phone, in.Name, in.Tags, in.Note)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, saved)
	}))

	// 微信登录（第 23 轮 / D28；第 25 轮 D31 起手机号改为可选）：小程序 wx.login 的 code 换 openid。
	// 手机号仍是业务身份（D24）——但它是**下单时**才需要的东西：登录只让服务端记住「这台微信是谁」，
	// 带手机号就顺手绑上（价格身份），不带也照样登录成功；**绝不改顾客等级**
	// （批发/白名单只能由老板在管理端设定）。
	mux.HandleFunc("/api/wx/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			Code     string `json:"code"`
			Phone    string `json:"phone"`
			Nickname string `json:"nickname"`
			Avatar   string `json:"avatar"`
			// 第 26 轮（D32）：登录时选身份——customer（顾客）/ staff（员工），缺省顾客。
			Role string `json:"role"`
		}
		if !decode(w, r, &in) {
			return
		}
		if strings.TrimSpace(in.Code) == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少 code（小程序端要先调 wx.login）"})
			return
		}
		if !wxc.ready() {
			writeJSON(w, 503, map[string]string{"error": "微信登录未配置（服务端缺少 WX_APPID / WX_SECRET）"})
			return
		}
		sess, err := wxc.code2Session(in.Code)
		if err != nil {
			var le *wxLoginError
			if errors.As(err, &le) {
				writeJSON(w, le.status, map[string]string{"error": le.msg})
				return
			}
			writeJSON(w, 502, map[string]string{"error": err.Error()})
			return
		}
		u, err := st.BindWxUser(sess.OpenID, sess.UnionID, in.Phone, in.Nickname, in.Avatar)
		if err != nil {
			writeErr(w, err)
			return
		}
		// 绑过的手机号决定看到的价格；等级一律取顾客档案里的值（老板设的）。
		name := u.Nickname
		tier := pricing.TierRetail
		if u.Phone != "" {
			if _, err := st.EnsureCustomer(u.Phone, u.Nickname); err != nil {
				writeErr(w, err)
				return
			}
			if tier, err = st.GetCustomerTier(u.Phone); err != nil {
				writeErr(w, err)
				return
			}
			if c, err := st.GetCustomer(u.Phone); err == nil && c.Name != "" {
				name = c.Name
			}
		}
		// 第 26 轮（D32）：登录时选身份。选「员工」的前提是老板已在后台把这个微信号的角色
		// 改成 staff——**光在小程序上点一下永远变不出员工权限**（与 D24 登录不提权同一个道理）。
		wantRole := strings.TrimSpace(in.Role)
		if wantRole == "" {
			wantRole = store.RoleCustomer
		}
		if !store.ValidRole(wantRole) {
			writeJSON(w, 400, map[string]string{"error": "身份只能是 customer（顾客）或 staff（员工）"})
			return
		}
		if wantRole == store.RoleStaff && u.Role != store.RoleStaff {
			writeJSON(w, 403, map[string]string{"error": "这个微信号还不是员工，请让老板在管理后台把角色改成员工"})
			return
		}
		resp := map[string]any{
			"ok": true, "openid": u.OpenID, "bound": u.Phone != "",
			"phone": u.Phone, "name": name, "nickname": u.Nickname, "avatar": u.Avatar, "tier": tier,
			"role": u.Role, "wantRole": wantRole,
		}
		// 员工令牌（第 26 轮 / D32）：员工账号每次登录换发一枚新令牌（旧的立刻失效）。
		// 员工就算这次选的是顾客身份也把令牌带回去——这样「我的」页能直接进工作台，
		// 不必退出再登一遍（员工本来就有管理端同权限，多给一个入口不涉及提权）。
		if u.Role == store.RoleStaff {
			token, err := st.RotateStaffToken(u.OpenID)
			if err != nil {
				writeErr(w, err)
				return
			}
			resp["staffToken"] = token
		}
		writeJSON(w, 200, resp)
	})

	// 微信头像昵称（第 25 轮 / D31）：微信从 2022 起不再允许静默获取头像昵称，只能用官方
	// 「头像昵称填写能力」——小程序把用户选好的头像/昵称回传到这里保存，下次进来自动带出来。
	// 空值保留原值；只认 openid，不碰手机号与等级。
	mux.HandleFunc("/api/wx/profile", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			OpenID   string `json:"openid"`
			Nickname string `json:"nickname"`
			Avatar   string `json:"avatar"`
		}
		if !decode(w, r, &in) {
			return
		}
		if strings.TrimSpace(in.OpenID) == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少 openid（先登录再保存头像昵称）"})
			return
		}
		u, err := st.UpdateWxProfile(in.OpenID, in.Nickname, in.Avatar)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "openid": u.OpenID, "nickname": u.Nickname, "avatar": u.Avatar,
		})
	})

	// 微信绑定审阅（只读，D28）：老板要能看见谁把哪台微信绑到了哪个手机号。
	mux.HandleFunc("/api/wx/users", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		limit := 200
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		list, err := st.ListWxUsers(limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
	}))

	// 角色管理（第 26 轮 / D32）：老板在后台把某个微信号改成「顾客 / 员工」。
	// 员工 = 管理端同权限（老板明确要求）；改回顾客时服务端顺手清掉员工令牌，
	// 免得「人已经被撤了，手机上的工作台还能进」。
	mux.HandleFunc("/api/wx/role", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		var in struct {
			OpenID string `json:"openid"`
			Role   string `json:"role"`
		}
		if !decode(w, r, &in) {
			return
		}
		if strings.TrimSpace(in.OpenID) == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少 openid（让对方先用小程序登录一次）"})
			return
		}
		u, err := st.SetWxUserRole(in.OpenID, in.Role)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "openid": u.OpenID, "role": u.Role,
			"nickname": u.Nickname, "phone": u.Phone, "lastLoginAt": u.LastLogin,
		})
	}))

	// ————— 员工界面（第 26 轮 / D32）—————
	// 员工接口都要求 `X-Staff-Token` 头（也接受 `?staff=` 查询参数，便于浏览器/CDP 直查）。
	// 这里只管「是不是员工」；改库存/改价/建档等写操作复用小店现有接口——
	// 老板要的是「员工跟管理后台一样」，而管理端鉴权本身是已推迟的独立事项。
	// 低库存阈值（第 27 轮单一真源）：Go 侧只此一处常量，随 /api/settings 下发，
	// 页面不再各自硬编码 5（以前散在 main.go / web / 小程序共 5 处）。
	// 低库存阈值只有 store.LowStockThreshold 一个真源（第 27 轮），
	// 这里用常量而不是变量，才能继续和 float64 库存直接比较。
	const staffLowStock = store.LowStockThreshold
	round2 := pricing.Round2
	// 员工令牌解析统一走 identity.go 的 staffFromReq（与 identityOf 共用同一套判定）。
	staffFrom := func(w http.ResponseWriter, r *http.Request) (store.WxUser, bool) {
		return staffFromReq(w, st, r)
	}

	// 工作台：今日营业额/单数、待处理单、低库存、最近流水——老板手机上要一眼看完。
	mux.HandleFunc("/api/staff/overview", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		u, ok := staffFrom(w, r)
		if !ok {
			return
		}
		orders, err := st.ListOrders("")
		if err != nil {
			writeErr(w, err)
			return
		}
		products, err := st.ListProducts("", "")
		if err != nil {
			writeErr(w, err)
			return
		}
		logs, err := st.ListStockLog(5)
		if err != nil {
			writeErr(w, err)
			return
		}
		day := time.Now().Format("2006-01-02")
		var revenue float64
		todayOrders, pending, lowCount := 0, 0, 0
		pendingList := []store.Order{}
		for _, o := range orders {
			if ts, err := time.Parse(time.RFC3339, o.CreatedAt); err == nil && ts.Format("2006-01-02") == day {
				revenue += o.Total
				todayOrders++
			}
			if o.Status == "pending" {
				pending++
				if len(pendingList) < 5 {
					pendingList = append(pendingList, o)
				}
			}
		}
		lowItems := []store.Product{}
		for _, p := range products {
			if p.Stock <= staffLowStock {
				lowCount++
				if len(lowItems) < 5 {
					lowItems = append(lowItems, p)
				}
			}
		}
		writeJSON(w, 200, map[string]any{
			"ok": true, "staff": u, "lowStock": staffLowStock,
			"stats": map[string]any{
				"todayRevenue": round2(revenue), "todayOrders": todayOrders,
				"pending": pending, "lowStockCount": lowCount, "products": len(products),
			},
			"pendingOrders": pendingList, "lowStockItems": lowItems, "recent": logs,
		})
	})

	// 扫码台（本轮最重要的一件事）：扫 69 码 → 是不是本店商品 / 库存多少 / 卖多少钱 /
	// 最近怎么动的，一次取回。**扫码本身绝不动库存**（D8）：入库/出库/盘点都要员工再点一下。
	mux.HandleFunc("/api/staff/scan", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		u, ok := staffFrom(w, r)
		if !ok {
			return
		}
		code := strings.TrimSpace(r.URL.Query().Get("code"))
		if code == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少 code（扫到的条码）"})
			return
		}
		out := map[string]any{"ok": true, "code": code, "staff": u.OpenID, "lowStock": staffLowStock}
		prod, err := st.GetProduct(code)
		if err != nil && !errors.Is(err, store.ErrNotFound) {
			writeErr(w, err)
			return
		}
		found := err == nil
		out["found"] = found
		if found {
			out["product"] = prod
		} else {
			// 没建档也把解析链跑一遍：本地字典/云端能给出名字规格，员工照着建档就行。
			parsed, err := res.Resolve(code)
			if err != nil {
				writeErr(w, err)
				return
			}
			out["resolve"] = parsed
		}
		// 这个条码最近的库存流水：员工要能看出「刚才谁动过、动成了多少」。
		logs, err := st.ListStockLog(200)
		if err != nil {
			writeErr(w, err)
			return
		}
		recent := []store.StockLog{}
		for _, e := range logs {
			if e.Code == code {
				recent = append(recent, e)
				if len(recent) >= 5 {
					break
				}
			}
		}
		out["recent"] = recent
		writeJSON(w, 200, out)
	})

	// 条码解析链（本地优先，扫码只读，不改库存）
	mux.HandleFunc("/api/barcode/resolve", func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Query().Get("code")
		out, err := res.Resolve(code)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, out)
	})

	// 条码字典层列表（扫码台「本地条码库」看数据用，只读）
	mux.HandleFunc("/api/barcode/lib", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		limit := 200
		if v := r.URL.Query().Get("limit"); v != "" {
			if n, err := strconv.Atoi(v); err == nil && n > 0 {
				limit = n
			}
		}
		list, err := st.ListLib(limit)
		if err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
	}))

	// 价格防线巡检
	mux.HandleFunc("/api/pricing/check", requireAdmin(func(w http.ResponseWriter, r *http.Request) {
		list, err := st.ListProducts("", "")
		if err != nil {
			writeErr(w, err)
			return
		}
		items := make([]pricing.Item, 0, len(list))
		for _, p := range list {
			items = append(items, pricing.Item{Code: p.Code, Name: p.Name, SalePrice: p.SalePrice,
				RefPrice: p.RefPrice, IsWholesale: p.IsWholesale})
		}
		total, violations := pricing.PricingCheck(items, pricing.DefaultConfig())
		writeJSON(w, 200, map[string]any{"total": total, "violations": violations, "over": len(violations)})
	}))

	// 管理端「干净地址」：/admin 直出 admin.html，地址栏里不出现 .html（D22）
	// 必须没有结尾斜杠——/admin 的相对路径基准是根目录，页面里的 `assets/theme.css`、
	// `mall-admin.js` 才能解析成 /assets/... 与 /mall-admin.js；带斜杠的 /admin/ 会把
	// 基准变成 /admin/ 导致静态资源 404，所以直接 301 到规范地址。
	mux.HandleFunc("/admin", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, filepath.Join(staticDir, "admin.html"))
	})
	mux.HandleFunc("/admin/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/admin", http.StatusMovedPermanently)
	})

	// 前端：本地开发时用 STATIC_DIR 指向仓库根目录，可直接打开 web 等页面
	mux.Handle("/", http.FileServer(http.Dir(staticDir)))
	return mux
}

/* ------------------------------ 云端条码 ------------------------------ */

// aliCloudResponse 阿里云市场「珠海云际 getBarcode」响应字段。
type aliCloudResponse struct {
	Status            string `json:"status"` // "200" 查到 / "400" 查无（同样消耗配额）
	Barcode           string `json:"Barcode"`
	ItemName          string `json:"ItemName"`
	BrandName         string `json:"BrandName"`
	ItemSpecification string `json:"ItemSpecification"`
	ItemClassName     string `json:"ItemClassName"`
	Image             []struct {
		Imageurl string `json:"Imageurl"`
	} `json:"Image"`
}

// aliCloud 返回云端查询函数：网络/HTTP 错误算失败（计入熔断），查无不算失败。
func aliCloud(gateway, appcode string) barcode.CloudFunc {
	client := &http.Client{Timeout: 8 * time.Second}
	return func(code string) (barcode.CloudItem, bool, error) {
		sep := "?"
		if strings.Contains(gateway, "?") {
			sep = "&"
		}
		url := strings.TrimRight(gateway, "/") + sep + "Code=" + code
		req, err := http.NewRequest(http.MethodGet, url, nil)
		if err != nil {
			return barcode.CloudItem{}, false, err
		}
		req.Header.Set("Authorization", "APPCODE "+appcode)
		resp, err := client.Do(req)
		if err != nil {
			return barcode.CloudItem{}, false, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return barcode.CloudItem{}, false,
				fmt.Errorf("云端 HTTP %d（400参数/401鉴权/429限流/5xx故障）", resp.StatusCode)
		}
		var out aliCloudResponse
		if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
			return barcode.CloudItem{}, false, fmt.Errorf("云端响应解析失败: %w", err)
		}
		if out.Status != "200" || out.ItemName == "" {
			return barcode.CloudItem{}, false, nil // 查无此码
		}
		return barcode.CloudItem{Name: out.ItemName, Spec: out.ItemSpecification}, true, nil
	}
}

/* ------------------------------ 微信登录（第 23 轮 / D28） ------------------------------ */

// wxConf 微信登录配置。AppID 可公开（已在 project.config.json），AppSecret 只来自环境变量（D13）。
type wxConf struct {
	appid   string
	secret  string
	apiBase string
	client  *http.Client
}

func (c wxConf) ready() bool { return c.appid != "" && c.secret != "" && c.client != nil }

// wxSession code2session 响应。只关心 openid / unionid，session_key 不回传客户端。
type wxSession struct {
	OpenID  string `json:"openid"`
	UnionID string `json:"unionid"`
	ErrCode int    `json:"errcode"`
	ErrMsg  string `json:"errmsg"`
}

// wxLoginError 带 HTTP 状态码的登录失败：4xx 是客户端可纠正的，502 是微信侧故障。
type wxLoginError struct {
	status int
	msg    string
}

func (e *wxLoginError) Error() string { return e.msg }

// code2Session 用 wx.login 的 code 换 openid。**绝不记录 code 与 secret**（D13）。
func (c wxConf) code2Session(code string) (wxSession, error) {
	u := c.apiBase + "/sns/jscode2session?appid=" + url.QueryEscape(c.appid) +
		"&secret=" + url.QueryEscape(c.secret) +
		"&js_code=" + url.QueryEscape(code) +
		"&grant_type=authorization_code"
	resp, err := c.client.Get(u)
	if err != nil {
		return wxSession{}, fmt.Errorf("无法连接微信服务器：%v", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<16))
	if err != nil {
		return wxSession{}, fmt.Errorf("读取微信响应失败：%v", err)
	}
	if resp.StatusCode != http.StatusOK {
		return wxSession{}, fmt.Errorf("微信服务器返回 HTTP %d", resp.StatusCode)
	}
	var s wxSession
	if err := json.Unmarshal(body, &s); err != nil {
		return wxSession{}, fmt.Errorf("微信响应解析失败：%v", err)
	}
	if s.ErrCode != 0 || s.OpenID == "" {
		return wxSession{}, wxErrFor(s.ErrCode, s.ErrMsg)
	}
	return s, nil
}

// wxErrFor 把微信错误码翻译成老板/顾客看得懂的话（以后台与微信文档为准，这里只覆盖常见码）。
func wxErrFor(code int, msg string) *wxLoginError {
	switch code {
	case 40029, 40163:
		return &wxLoginError{400, "微信登录码无效或已过期，请退出小程序重进再试"}
	case 45011:
		return &wxLoginError{429, "登录请求太频繁，请稍后再试"}
	case 40226:
		return &wxLoginError{403, "该微信账号被微信标记为高风险，登录被拦截"}
	case -1:
		return &wxLoginError{502, "微信服务繁忙，请稍后再试"}
	}
	return &wxLoginError{502, fmt.Sprintf("微信登录失败（errcode=%d %s）", code, msg)}
}

/* ------------------------------ 中间件与工具 ------------------------------ */

// withCORS 允许同机不同端口的 demo 页面直接调用本地后端（生产由 Nginx 同源反代）。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		// X-Staff-Token / X-Openid / X-Wx-Openid / X-Phone 都要放行：第 27 轮起身份既走查询参数也走请求头，
		// 少了这几个头，跨源页面（本机不同端口的 demo）根本发不出带身份的请求。
		// X-Admin 是管理后台的显式声明（identity.go adminMarked）：管理端 Cookie 与顾客页
		// 在同一个浏览器里共用，靠这个头把两者分开。
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type,X-Staff-Token,X-Openid,X-Wx-Openid,X-Phone,X-Admin")
		w.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		if strings.HasPrefix(r.URL.Path, "/api/") {
			log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start).Round(time.Millisecond))
		}
	})
}

// csvHeader 导出列的固定顺序（§7.6，共 12 列）。
var csvHeader = []string{"订单号", "下单时间", "状态", "顾客", "手机号", "配送方式",
	"商品明细", "件数", "商品金额", "配送费", "合计", "备注"}

// badDateMsg 校验订单筛选里的日期，返回空串表示合法。
// date 与 from/to 同时给时 date 优先（§7.5），所以 date 非空就只看 date。
func badDateMsg(f store.OrderFilter) string {
	dates := []string{f.Date}
	if strings.TrimSpace(f.Date) == "" {
		dates = []string{f.From, f.To}
	}
	for _, d := range dates {
		if strings.TrimSpace(d) != "" && !store.ValidDate(d) {
			return "日期格式应为 YYYY-MM-DD"
		}
	}
	return ""
}

// queryCount 解析计数类查询参数：空 = 默认值；非整数/负数 → 返回错误文案（调用方回 400）。
// 与 queryInt 的区别：queryInt 对非法值静默回退默认（第 27 轮行为，订单分页还在用），
// 而 §7.2 明确要求负数 limit/offset 回 400，所以新参数一律用这个严格版。
func queryCount(r *http.Request, name string, def int) (int, string) {
	raw := strings.TrimSpace(r.URL.Query().Get(name))
	if raw == "" {
		return def, ""
	}
	n, err := strconv.Atoi(raw)
	if err != nil {
		return 0, name + " 必须是整数"
	}
	if n < 0 {
		return 0, name + " 不能为负数"
	}
	return n, ""
}

// tierForPhone 取顾客等级；phone 为空一律零售价（不带 phone 的请求走同一口径）。
func tierForPhone(st *store.Store, phone string) (string, error) {
	if strings.TrimSpace(phone) == "" {
		return pricing.TierRetail, nil
	}
	return st.GetCustomerTier(phone)
}

// applyTier 按顾客等级改写条目上的等级与有效价（价格口径的唯一真源，D12/D24）。
func applyTier(list []store.Product, tier string) {
	for i := range list {
		list[i].Tier = tier
		list[i].Price = pricing.EffectivePrice(tier, list[i].SalePrice, list[i].WholesalePrice)
	}
}

// numText 数量转文本：10 → "10"、2.5 → "2.5"（去掉浮点尾巴，CSV 里好读）。
func numText(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// csvTime 把库里的时间统一成 YYYY-MM-DD HH:MM:SS：
// 新单是 RFC3339（2026-10-01T08:00:00+08:00），老单是空格格式（2026-10-01 08:00:00）。
func csvTime(s string) string {
	s = strings.TrimSpace(s)
	if t, err := time.Parse(time.RFC3339, s); err == nil {
		return t.Format("2006-01-02 15:04:05")
	}
	if len(s) >= 19 && s[10] == 'T' {
		return strings.Replace(s[:19], "T", " ", 1)
	}
	if len(s) >= 19 {
		return s[:19]
	}
	return s
}

// deliveryText 配送方式中文（与后台管理页文案一致）。
func deliveryText(t string) string {
	switch t {
	case "pickup":
		return "到店自提"
	case "delivery":
		return "配送到家"
	}
	return t
}

func decode(w http.ResponseWriter, r *http.Request, v any) bool {
	defer r.Body.Close()
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1<<20)).Decode(v); err != nil {
		writeJSON(w, 400, map[string]string{"error": "请求体解析失败: " + err.Error()})
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

// writeErr 把领域错误映射为 HTTP 状态码。
func writeErr(w http.ResponseWriter, err error) {
	code := 500
	switch {
	case errors.Is(err, store.ErrBadInput):
		code = 400
	case errors.Is(err, store.ErrNotFound):
		code = 404
	case errors.Is(err, store.ErrStockLess):
		code = 409
	case errors.Is(err, store.ErrConflict):
		code = 409
	}
	writeJSON(w, code, map[string]string{"error": err.Error()})
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// seedIfEmpty 首次启动写入示例商品（与 web/ 保持一致，便于联调）。
// 第 27 轮（审计 E-P0-1）：**默认不灌**。生产库一旦被演示商品污染，老板要先删一遍才能建真档案，
// 而且这些商品的库存/价格会跟着顾客端一起出现。只有显式 SEED_DEMO=1 时才灌（本机联调、演示环境）。
func seedIfEmpty(st *store.Store) error {
	if v := strings.ToLower(strings.TrimSpace(os.Getenv("SEED_DEMO"))); v != "1" && v != "true" {
		log.Printf("未设置 SEED_DEMO，跳过内置示例商品")
		return nil
	}
	list, err := st.ListProducts("", "")
	if err != nil {
		return err
	}
	if len(list) > 0 {
		return nil
	}
	seeds := []store.Product{
		{Code: "6901234567892", Name: "可口可乐", Spec: "330ml 罐装", Category: "饮料", Unit: "罐", CostPrice: 2.2, SalePrice: 2.5, Stock: 120, SyncStatus: "synced", IsDemo: true},
		{Code: "6902083881234", Name: "农夫山泉", Spec: "550ml", Category: "饮料", Unit: "瓶", CostPrice: 1.5, SalePrice: 1.8, Stock: 200, SyncStatus: "synced", IsDemo: true},
		{Code: "6921168509256", Name: "心相印抽纸", Spec: "3层100抽", Category: "日用品", Unit: "包", CostPrice: 3.9, SalePrice: 4.5, Stock: 60, SyncStatus: "pending", IsDemo: true},
		{Code: "6925303725941", Name: "旺旺雪饼", Spec: "84g", Category: "零食", Unit: "袋", CostPrice: 3.8, SalePrice: 4.5, Stock: 40, SyncStatus: "pending", IsDemo: true},
		{Code: "6901001100113", Name: "青岛啤酒", Spec: "330ml 罐装", Category: "酒水", Unit: "罐", CostPrice: 5.0, SalePrice: 6.0, Stock: 90, SyncStatus: "pending", IsDemo: true},
		{Code: "6907992751797", Name: "伊利纯牛奶", Spec: "250ml 盒装", Category: "乳品", Unit: "盒", CostPrice: 3.0, SalePrice: 3.5, Stock: 80, SyncStatus: "pending", IsDemo: true},
	}
	for _, p := range seeds {
		if _, err := st.UpsertProduct(p); err != nil {
			return err
		}
	}
	log.Printf("已写入 %d 个示例商品（isDemo=true）", len(seeds))
	return nil
}

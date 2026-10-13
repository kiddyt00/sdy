// Command server 独立小程序商城后端（M4）。
//
// 只用标准库：net/http + database/sql(modernc.org/sqlite)。
// 启动：ADDR=127.0.0.1:8093 DB_PATH=./data/sdy.db ./server
// 云端条码：BARCODE_APPCODE=xxx（不配置则纯本地模式，离线可用）。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
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
		Handler:           withCORS(withLogging(routes(st, resolver, staticDir, appcode != ""))),
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

func routes(st *store.Store, res *barcode.Resolver, staticDir string, cloudEnabled bool) http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]any{
			"ok": true, "time": time.Now().Format(time.RFC3339),
			"circuitOpen": res.CircuitOpen(), "cloudFails": res.Fails(),
			"cloudConfigured": cloudEnabled,
		})
	})

	// 商品：列表 / 建档 / 手动改库存（D8）
	mux.HandleFunc("/api/products", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			// onSale=1 只回上架商品（顾客端商城用，D23）；不带参数回全量（管理端用）。
			// phone 带上时按该顾客等级给有效价 price（D24）；不带 phone 一律零售价。
			var (
				list []store.Product
				err  error
			)
			if r.URL.Query().Get("onSale") == "1" {
				list, err = st.ListOnSaleProducts(r.URL.Query().Get("keyword"), r.URL.Query().Get("category"))
			} else {
				list, err = st.ListProducts(r.URL.Query().Get("keyword"), r.URL.Query().Get("category"))
			}
			if err != nil {
				writeErr(w, err)
				return
			}
			// 价格口径的唯一真源在服务端：页面只读 price，不自己拿批发价换算（D12/D24）。
			phone := strings.TrimSpace(r.URL.Query().Get("phone"))
			tier := pricing.TierRetail
			if phone != "" {
				if tier, err = st.GetCustomerTier(phone); err != nil {
					writeErr(w, err)
					return
				}
				for i := range list {
					list[i].Tier = tier
					list[i].Price = pricing.EffectivePrice(tier, list[i].SalePrice, list[i].WholesalePrice)
				}
			}
			writeJSON(w, 200, map[string]any{"items": list, "total": len(list), "tier": tier})
		case http.MethodPost:
			// 建档 / 编辑商品档案（任务池①）。
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

	mux.HandleFunc("/api/products/stock", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 库存变更（任务池⑧，D25）：入库 / 改数 / 盘点都走这一个入口，
	// 服务端在一个事务里改库存 + 写流水。以前在线模式只用 SetStock 盖绝对值，
	// 「为什么改」的审计只落在浏览器里，换台设备就查不到账。
	mux.HandleFunc("/api/stock/change", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 库存流水（任务池⑧，D25）：GET /api/stocklog?limit=30，最新在前。
	mux.HandleFunc("/api/stocklog", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 配送员名单（任务池⑧，D25）：GET 列表 / POST 新增或删除（remove=true）。
	mux.HandleFunc("/api/couriers", func(w http.ResponseWriter, r *http.Request) {
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
	})

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
			var in struct {
				Name    string `json:"name"`
				Phone   string `json:"phone"`
				Address string `json:"address"`
				Footer  string `json:"footer"`
			}
			if !decode(w, r, &in) {
				return
			}
			saved, err := st.SaveSettings(store.Settings{
				Name: in.Name, Phone: in.Phone, Address: in.Address, Footer: in.Footer,
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

	// 批量上下架（任务池⑥，D23）：POST /api/products/onsale {codes:[...], onSale:true|false}
	mux.HandleFunc("/api/products/onsale", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 商品档案删除（D16）：DELETE /api/products/{code}
	// 约束由 store 层把关：库存必须先盘点为 0、不能有进行中的订单。
	mux.HandleFunc("/api/products/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodDelete {
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
			return
		}
		code := strings.Trim(strings.TrimPrefix(r.URL.Path, "/api/products/"), "/")
		if code == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少条码"})
			return
		}
		if err := st.DeleteProduct(code); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "code": code})
	})

	// 订单：列表 / 下单 / 详情 / 状态流转
	mux.HandleFunc("/api/orders", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			list, err := st.ListOrders(r.URL.Query().Get("status"))
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, map[string]any{"items": list, "total": len(list)})
		case http.MethodPost:
			var in store.NewOrderInput
			if !decode(w, r, &in) {
				return
			}
			o, err := st.CreateOrder(in)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 201, o)
		default:
			writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		}
	})

	mux.HandleFunc("/api/orders/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/api/orders/")
		id := strings.TrimSuffix(path, "/advance")
		if id == "" {
			writeJSON(w, 400, map[string]string{"error": "缺少订单号"})
			return
		}
		if strings.HasSuffix(path, "/advance") {
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
			o, err := st.AdvanceOrder(id, in.To)
			if err != nil {
				writeErr(w, err)
				return
			}
			writeJSON(w, 200, o)
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
		writeJSON(w, 200, o)
	})

	// 顾客收货地址簿（D18）：按手机号归档，顾客端一键带出。
	// 只服务「少打字」：订单地址仍是下单当时的快照，改地址簿不影响历史订单。
	mux.HandleFunc("/api/addresses", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			list, err := st.ListAddresses(r.URL.Query().Get("phone"))
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
			writeJSON(w, 200, saved)
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
		if err := st.DeleteAddress(r.URL.Query().Get("phone"), id); err != nil {
			writeErr(w, err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "id": id})
	})

	// 顾客等级（任务池⑦，D24）：GET 列表 / POST 设定。
	// 等级只影响之后下单的有效价，历史订单价格是下单当时的快照。
	mux.HandleFunc("/api/customers", func(w http.ResponseWriter, r *http.Request) {
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
	})

	mux.HandleFunc("/api/customers/tier", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 顾客备注与标签（任务池⑧，D25）：等级走上面的 /tier，这里只维护 tags/note。
	mux.HandleFunc("/api/customers/note", func(w http.ResponseWriter, r *http.Request) {
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
	mux.HandleFunc("/api/barcode/lib", func(w http.ResponseWriter, r *http.Request) {
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
	})

	// 价格防线巡检
	mux.HandleFunc("/api/pricing/check", func(w http.ResponseWriter, r *http.Request) {
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
	})

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

/* ------------------------------ 中间件与工具 ------------------------------ */

// withCORS 允许同机不同端口的 demo 页面直接调用本地后端（生产由 Nginx 同源反代）。
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
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
func seedIfEmpty(st *store.Store) error {
	list, err := st.ListProducts("", "")
	if err != nil {
		return err
	}
	if len(list) > 0 {
		return nil
	}
	seeds := []store.Product{
		{Code: "6901234567892", Name: "可口可乐", Spec: "330ml 罐装", Category: "饮料", Unit: "罐", CostPrice: 2.2, SalePrice: 2.5, Stock: 120, SyncStatus: "synced"},
		{Code: "6902083881234", Name: "农夫山泉", Spec: "550ml", Category: "饮料", Unit: "瓶", CostPrice: 1.5, SalePrice: 1.8, Stock: 200, SyncStatus: "synced"},
		{Code: "6921168509256", Name: "心相印抽纸", Spec: "3层100抽", Category: "日用品", Unit: "包", CostPrice: 3.9, SalePrice: 4.5, Stock: 60, SyncStatus: "pending"},
		{Code: "6925303725941", Name: "旺旺雪饼", Spec: "84g", Category: "零食", Unit: "袋", CostPrice: 3.8, SalePrice: 4.5, Stock: 40, SyncStatus: "pending"},
		{Code: "6901001100113", Name: "青岛啤酒", Spec: "330ml 罐装", Category: "酒水", Unit: "罐", CostPrice: 5.0, SalePrice: 6.0, Stock: 90, SyncStatus: "pending"},
		{Code: "6907992751797", Name: "伊利纯牛奶", Spec: "250ml 盒装", Category: "乳品", Unit: "盒", CostPrice: 3.0, SalePrice: 3.5, Stock: 80, SyncStatus: "pending"},
	}
	for _, p := range seeds {
		if _, err := st.UpsertProduct(p); err != nil {
			return err
		}
	}
	log.Printf("已写入 %d 个示例商品", len(seeds))
	return nil
}

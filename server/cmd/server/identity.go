package main

// 统一身份解析（第 27 轮）。
//
// 以前「你是不是员工」只有 /api/staff/* 两处管，订单与地址簿接口完全裸奔：
// 小程序顾客端调 GET /api/orders 会把全站订单（含姓名/手机号/地址）渲染成「我的订单」。
// 本文件把身份收敛成一处，所有订单/地址接口都走 identityOf。

import (
	"net/http"
	"strconv"
	"strings"

	"github.com/kiddyt00/sdy/server/internal/store"
)

// identity 一次请求解析出的身份。
//
// Admin=true 表示「按全量放行」：
//   - 管理员：ADMIN_PASSWORD 未设置（通道关闭）或带有效管理 Cookie（adminOK）；
//   - 员工：带有效 X-Staff-Token（第 26 轮 D32 起员工 = 管理端同权限）。
//
// Phone 非空表示顾客身份：openid 经 wx_user.phone 解析出来，或直接来自 phone 参数。
type identity struct {
	Admin  bool
	Staff  store.WxUser // 员工令牌对应的微信用户（管理员 Cookie 放行时为零值）
	Phone  string
	OpenID string
}

// Operator 审计用的操作人：员工优先用姓名，其次「员工」，管理员记「管理员」，其余「顾客」。
// 库存流水（stock_log.operator）靠它回答「谁动的」。
func (id identity) Operator() string {
	if id.Staff.OpenID != "" {
		if name := strings.TrimSpace(id.Staff.Nickname); name != "" {
			return name
		}
		return "员工"
	}
	if id.Admin {
		return "管理员"
	}
	return "顾客"
}

// staffTokenOf 取请求携带的员工令牌：X-Staff-Token 头优先，?staff= 查询参数兜底
// （便于浏览器/CDP 直查，第 26 轮沿用）。
func staffTokenOf(r *http.Request) string {
	if t := strings.TrimSpace(r.Header.Get("X-Staff-Token")); t != "" {
		return t
	}
	return strings.TrimSpace(r.URL.Query().Get("staff"))
}

// staffFromReq 用令牌换员工身份；令牌缺失/失效一律 401（与第 26 轮行为一致）。
func staffFromReq(w http.ResponseWriter, st *store.Store, r *http.Request) (store.WxUser, bool) {
	u, ok, err := st.GetStaffByToken(staffTokenOf(r))
	if err != nil {
		writeErr(w, err)
		return store.WxUser{}, false
	}
	if !ok {
		writeJSON(w, 401, map[string]string{"error": "员工身份已失效，请用员工身份重新登录"})
		return store.WxUser{}, false
	}
	return u, true
}

// identityOf 统一身份解析。优先级：
//
//	有效员工令牌 > 管理端（带 X-Admin: 1 且管理员 Cookie 有效）> openid（查 wx_user.phone）
//	> phone 查询参数 > 通道关闭时的管理端放行 > 无身份
//
// 「通道关闭时的管理端放行」必须排在顾客身份**之后**：第 27 轮验收实测，
// 灰度默认（没设 ADMIN_PASSWORD）时若把它放最前，任何请求都算管理员，
// 于是 ?phone=B 也能读到 A 的订单、地址簿的 key 形同虚设、无令牌也能推进订单。
//
// 管理端身份要**显式声明**（X-Admin: 1 头）：管理员 Cookie 是同一个域名下的，
// 老板自己也会用同一浏览器逛顾客页；只要带了 Cookie 就当管理员，顾客页（不带头）
// 一没绑手机号就会看到全店订单。带头 = 管理后台的请求，无头 = 顾客身份说了算。
//
// 返回 ok=false 表示已经写好响应（令牌失效 401 / 数据库错误），调用方直接 return。
// 「无身份」不在这里报错：GET /api/orders 要回特定的 400 文案，/{id} 要按 404 处理。
func identityOf(w http.ResponseWriter, r *http.Request, st *store.Store) (identity, bool) {
	if tok := staffTokenOf(r); tok != "" {
		u, ok, err := st.GetStaffByToken(tok)
		if err != nil {
			writeErr(w, err)
			return identity{}, false
		}
		if !ok {
			writeJSON(w, 401, map[string]string{"error": "员工身份已失效，请用员工身份重新登录"})
			return identity{}, false
		}
		// 员工与管理员同权（D32）：看全量订单、可推进/取消任意单。
		return identity{Admin: true, Staff: u, OpenID: u.OpenID, Phone: strings.TrimSpace(u.Phone)}, true
	}
	// 管理端（显式声明 X-Admin + 校验通过）：必须排在 openid/phone 之前。
	// 同一个浏览器里管理后台与顾客页共用域名，而 sdy-api.reqHeaders 会在管理端请求上
	// 顺手带上老板本地记住的手机号——若先按顾客身份解析，灰度档（未设 ADMIN_PASSWORD、
	// adminOK 恒真）里老板派单就会被当成「顾客推进订单」而 403。
	// 注意这里不再要求 adminEnabled()：灰度档也要走这支，strict 档 adminOK 自己会查 Cookie。
	if adminMarked(r) && adminOK(r) {
		return identity{Admin: true}, true
	}
	if openid := queryOrHeader(r, "openid"); openid != "" {
		u, ok, err := st.GetWxUser(openid)
		if err != nil {
			writeErr(w, err)
			return identity{}, false
		}
		// openid 未知、或这台微信还没绑手机号 = 算不上顾客身份（任务书：未知视为无身份），
		// 但继续往下看 phone 参数——网页端没有 openid，只有 phone。
		if ok && strings.TrimSpace(u.Phone) != "" {
			return identity{OpenID: u.OpenID, Phone: strings.TrimSpace(u.Phone)}, true
		}
	}
	if phone := queryOrHeader(r, "phone"); phone != "" {
		return identity{Phone: phone}, true
	}
	// 完全没有身份：只有「管理端通道关闭」这一种情况放行（灰度默认，老板的后台照旧能用）。
	// 通道开着时必须 400/404，否则顾客页、公网爬虫都能顺手读到全店订单。
	if !adminEnabled() && adminOK(r) {
		return identity{Admin: true}, true
	}
	return identity{}, true
}

// adminMarked 请求是否声明自己是管理后台（X-Admin: 1）。
// 这不是安全边界（谁都能加这个头），安全边界始终是管理端 Cookie；它只用来把
// 「同一个浏览器里的管理后台」和「顾客页」区分开。
func adminMarked(r *http.Request) bool {
	return strings.TrimSpace(r.Header.Get("X-Admin")) == "1"
}

// orderBelongsTo 顾客身份是否属于这一单。手机号是业务身份（D24），
// openid 已经由 wx_user.phone 折进 Phone；两个都没有就永远不算自己的单。
func orderBelongsTo(o store.Order, id identity) bool {
	if id.Phone == "" {
		return false
	}
	return strings.TrimSpace(o.Phone) == id.Phone
}

// queryOrHeader 查询参数优先，同名 X- 头兜底（小程序与网页各自顺手用哪个都行）。
func queryOrHeader(r *http.Request, name string) string {
	if v := strings.TrimSpace(r.URL.Query().Get(name)); v != "" {
		return v
	}
	switch name {
	case "openid":
		// 小程序发的是 X-Wx-Openid（utils/api.js identityParams），网页与脚本用 X-Openid。
		if v := strings.TrimSpace(r.Header.Get("X-Wx-Openid")); v != "" {
			return v
		}
		return strings.TrimSpace(r.Header.Get("X-Openid"))
	case "phone":
		return strings.TrimSpace(r.Header.Get("X-Phone"))
	}
	return ""
}

// addressAllowed 能不能读/删这个手机号的收货地址簿（第 27 轮地址簿能力令牌）。
//
// 手机号是明文可猜的（11 位、1 开头），只凭 phone 就能读地址等于把顾客住址挂在公网；
// 所以第一次保存地址时服务端发一枚随机 key，客户端存本地，之后凭 phone+key 才读得到。
// 员工与管理员照旧放行（管理端要能代客查址）。
func addressAllowed(r *http.Request, st *store.Store, ident identity, phone string) (bool, error) {
	if ident.Admin {
		return true, nil
	}
	key := strings.TrimSpace(r.URL.Query().Get("key"))
	if key == "" {
		return false, nil
	}
	return st.CheckAddressKey(phone, key)
}

// queryInt 读整数查询参数：没传、不是数字、是负数一律回退默认值。
func queryInt(r *http.Request, name string, def int) int {
	v := strings.TrimSpace(r.URL.Query().Get(name))
	if v == "" {
		return def
	}
	n, err := strconv.Atoi(v)
	if err != nil || n < 0 {
		return def
	}
	return n
}

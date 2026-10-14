package main

// 管理端鉴权通道（第 27 轮）。
//
// 设计要点（**默认关，可灰度**）：
//   - ADMIN_PASSWORD 未设置 → 通道关闭：管理端接口一律放行，只打一次 WARN。
//     这是本轮上线后的默认状态，34 个端点行为与第 26 轮完全一致（老板不会被锁在门外）。
//   - ADMIN_PASSWORD 已设置 → 管理端接口必须带有效管理员 Cookie，否则 401
//     {"error":"请先登录管理后台"}。
//   - 公开端点（不受本文件影响）：/healthz、/api/admin/login、/api/admin/logout、
//     /api/wx/*、/api/staff/*。
//   - 口令只从环境变量读，绝不落库、绝不进日志（D13）。
//   - Cookie 值 = "<过期Unix秒>.<hex(HMAC-SHA256(口令, "sdy-admin:"+过期Unix秒))>"；
//     校验时先看有没有过期，再用 hmac.Equal 常量时间比较签名。
//
// adminOK 是「谁是管理员」的**唯一真源**：requireAdmin 与订单/地址身份解析都调它，
// 绝不许各写一份（否则口径会漂）。

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	adminCookieName = "sdy_admin"        // 管理员会话 Cookie 名
	adminCookieTTL  = 7 * 24 * time.Hour // 有效期 7 天
	adminSignPrefix = "sdy-admin:"       // 签名域分隔，避免签名被挪作他用
)

// adminWarnOnce 保证「鉴权通道关闭」的 WARN 只打一次，不刷屏。
var adminWarnOnce sync.Once

// adminPassword 当前管理员口令（空 = 通道关闭）。
func adminPassword() string { return strings.TrimSpace(os.Getenv("ADMIN_PASSWORD")) }

// adminEnabled 管理端鉴权是否真的开着（口令配了才算开）。
func adminEnabled() bool { return adminPassword() != "" }

// adminOK 管理员校验的唯一真源。口令没配 → 灰度关闭，一律放行 + WARN 一次；
// 口令配了 → 必须带有效（未过期 + 签名对）的管理员 Cookie。
func adminOK(r *http.Request) bool {
	pw := adminPassword()
	if pw == "" {
		adminWarnOnce.Do(func() {
			log.Printf("[WARN] 未设置 ADMIN_PASSWORD：管理端鉴权处于关闭状态（管理接口一律放行）。上线管理端前请配置该环境变量")
		})
		return true
	}
	c, err := r.Cookie(adminCookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return verifyAdminCookie(c.Value, pw)
}

// signAdminCookie 生成管理员 Cookie 值：过期时间戳 + 对「前缀+时间戳」的 HMAC 签名。
func signAdminCookie(pw string, expire time.Time) string {
	ts := strconv.FormatInt(expire.Unix(), 10)
	mac := hmac.New(sha256.New, []byte(pw))
	mac.Write([]byte(adminSignPrefix + ts))
	return ts + "." + hex.EncodeToString(mac.Sum(nil))
}

// verifyAdminCookie 校验管理员 Cookie：过期直接否；签名用常量时间比较。
func verifyAdminCookie(v, pw string) bool {
	ts, sig, ok := strings.Cut(v, ".")
	if !ok || ts == "" || sig == "" {
		return false
	}
	exp, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return false
	}
	if time.Now().Unix() > exp {
		return false
	}
	mac := hmac.New(sha256.New, []byte(pw))
	mac.Write([]byte(adminSignPrefix + ts))
	return hmac.Equal([]byte(sig), []byte(hex.EncodeToString(mac.Sum(nil))))
}

// requireAdmin 把管理端接口包起来（逐个路由包装，不做全局白名单）。
// 口令没配 → 直接放行；配了 → 没有效 Cookie 就 401。
func requireAdmin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !adminOK(r) {
			writeJSON(w, 401, map[string]string{"error": "请先登录管理后台"})
			return
		}
		next(w, r)
	}
}

// adminGate 给「一个路由里只有部分方法属于管理端」用的内联闸门（如 POST /api/products）。
// 返回 false 表示已经回过 401，调用方直接 return。
func adminGate(w http.ResponseWriter, r *http.Request) bool {
	if adminOK(r) {
		return true
	}
	writeJSON(w, 401, map[string]string{"error": "请先登录管理后台"})
	return false
}

// adminLogin 管理端登录：口令对了发一枚签名 Cookie。
// 口令没配时通道是关的，如实返回 enabled=false（前端据此不显示登录框），不算错误。
func adminLogin(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	var in struct {
		Password string `json:"password"`
	}
	if !decode(w, r, &in) {
		return
	}
	pw := adminPassword()
	if pw == "" {
		writeJSON(w, 200, map[string]any{"ok": true, "enabled": false})
		return
	}
	// 口令比较也用常量时间，别用 == 给暴力破解留时间侧信道。
	if !hmac.Equal([]byte(strings.TrimSpace(in.Password)), []byte(pw)) {
		writeJSON(w, 401, map[string]string{"error": "管理口令不对"})
		return
	}
	exp := time.Now().Add(adminCookieTTL)
	http.SetCookie(w, &http.Cookie{
		Name:     adminCookieName,
		Value:    signAdminCookie(pw, exp),
		Path:     "/",
		HttpOnly: true,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   int(adminCookieTTL.Seconds()),
	})
	writeJSON(w, 200, map[string]any{
		"ok": true, "enabled": true, "expiresAt": exp.Format(time.RFC3339),
	})
}

// adminLogout 管理端退出：把 Cookie 置空并立刻过期。
func adminLogout(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, 405, map[string]string{"error": "方法不支持"})
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: adminCookieName, Value: "", Path: "/",
		HttpOnly: true, SameSite: http.SameSiteStrictMode, MaxAge: -1,
	})
	writeJSON(w, 200, map[string]any{"ok": true})
}

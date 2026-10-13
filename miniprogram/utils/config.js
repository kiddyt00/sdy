// 啥都有快送 · 小程序运行配置（上线前只需要改这一个文件）
//
// 小程序和 Web 端最大的不同：`wx.request` 只能请求「小程序后台 → 开发管理 → 服务器域名」
// 里配置过的 **HTTPS** 域名（不能是 IP、不能带端口）。所以：
//   · 开发期：用 DEV_BASE_URL（本机 Go 后端 127.0.0.1:8093），并在开发者工具
//     「详情 → 本地设置」里勾选「不校验合法域名」；
//   · 上线前：把 PROD_BASE_URL 改成已备案的 HTTPS 域名，并在小程序后台把同一个域名
//     加进「服务器域名 → request 合法域名」（微信支付还要加进「业务域名」等）。
//
// 后端地址优先级（见 utils/api.js）：setBase(显式) > 小程序本地缓存 > DEFAULT_BASE_URL

const DEV_BASE_URL = 'http://127.0.0.1:8093'

// 生产域名（2026-10-13 第 22 轮上线，acme.sh/ZeroSSL ECC 证书，HTTP 自动 301 到 HTTPS）
// 已备案：沿用 shadouyou.cloud 的备案，子域名即可；微信侧要求 HTTPS + 不得带端口。
// 开发者工具里想临时连本机后端，控制台执行 api.setBase('http://127.0.0.1:8093') 即可。
// 留空时自动退回 DEV_BASE_URL，保证开发者工具开箱能跑。
const PROD_BASE_URL = 'https://mall.shadouyou.cloud'

module.exports = {
  DEV_BASE_URL: DEV_BASE_URL,
  PROD_BASE_URL: PROD_BASE_URL,
  DEFAULT_BASE_URL: PROD_BASE_URL || DEV_BASE_URL,
  // 门店名（页面 fallback 用；真源仍是后端 /api/settings）
  STORE_NAME: '啥都有快送'
}

// 顾客页共用的小工具（第 27 轮 P0-2「错误态」/ P0-8「身份前置」的唯一真源）
// 为什么单开一份：5 个顾客页都要把「请求失败」和「本来就没数据」分开，
// 错误的翻译口径必须一致——各页抄一份，早晚有页面漏掉 request:fail 把它露给顾客看。
const api = require('../../utils/api.js')

// 顾客看得懂的一句话。api 的原始报文里会夹着 base 地址、request:fail、timeout 这些技术字眼，
// 界面上一个都不许出现（第 27 轮硬约束），所以在这里统一翻译掉。
const NET_HINT = '店里系统没连上，请稍后重试'
const BUSY_HINT = '店里系统有点忙，请稍后重试'
const TECH = /request:fail|timeout|Failed to fetch|NetworkError|net::|ERR_[A-Z]|无法连接后端|没有 wx\.request|wx\.login 失败/i

function errText(e) {
  const raw = String((e && (e.message || e.errMsg)) || '').trim()
  if (!raw) return NET_HINT
  if (TECH.test(raw)) return NET_HINT
  if (/^HTTP\s*\d{3}$/i.test(raw)) return BUSY_HINT // 后端在，是这一个接口出错
  if (/^无此路由/.test(raw)) return BUSY_HINT // 老后端还没有这个接口
  if (raw.length > 40) return raw.slice(0, 40) + '…'
  return raw // 服务端给的业务文案（比如「库存不足」）原样透传
}

// 是否已有请求身份：登录（openid）或下单时填过的手机号，有其一就能打订单 / 地址接口。
// 页面先在本地拦一道，别让它打到后端再报「缺少身份」（第 27 轮 P0-8）。
function hasIdentity() {
  try {
    const p = api.identityParams()
    return !!(p && p.qs)
  } catch (e) {
    return false
  }
}

module.exports = {
  NET_HINT: NET_HINT,
  BUSY_HINT: BUSY_HINT,
  errText: errText,
  hasIdentity: hasIdentity
}

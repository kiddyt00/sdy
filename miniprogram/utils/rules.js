// 配送费规则（小程序端展示用；下单时以服务端计算结果为准）
// 与 server/internal/pricing 保持一致：自提 0 元；配送满 30 元免配送费，否则 3 元。
const MIN_FREE = 30
const DELIVERY_FEE = 3

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// kind: 'pickup' | 'delivery' | 未知 —— 第 27 轮口径：只有 pickup 算自提，其余一律按 delivery
// cfg 可选 {minFree, deliveryFee, pickupFee}（由 GET /api/settings 下发；缺省用门店默认值）
// goods 先 round2 再比门槛；minFree <= 0 表示这家店不免运费（不是「随便买都免」）
function deliveryFee(kind, subtotal, cfg) {
  const c = Object.assign({ minFree: MIN_FREE, deliveryFee: DELIVERY_FEE, pickupFee: 0 }, cfg || {})
  if (kind === 'pickup') return c.pickupFee
  const goods = round2(subtotal)
  return (c.minFree > 0 && goods >= c.minFree) ? 0 : c.deliveryFee
}

// 给用户看的一句话说明
function feeHint(kind, subtotal, cfg) {
  const c = Object.assign({ minFree: MIN_FREE, deliveryFee: DELIVERY_FEE, pickupFee: 0 }, cfg || {})
  if (kind === 'pickup') return c.pickupFee > 0 ? '自提配送费 ' + round2(c.pickupFee) + ' 元' : '自提免配送费'
  if (!(c.minFree > 0)) return '本店未开启满额免配送（配送费 ' + round2(c.deliveryFee) + ' 元）'
  const s = round2(subtotal)
  if (s >= c.minFree) return '已满 ' + c.minFree + ' 元，免配送费'
  return '还差 ' + round2(c.minFree - s) + ' 元免配送费（否则 ' + round2(c.deliveryFee) + ' 元）'
}

/* ---------------- 顾客等级与有效价（D24，口径与 server/internal/pricing、web/pricing.js 一致） ---------------- */
// **价格真源在服务端**：这里只用于页面展示与断网时的兜底换算，
// 下单金额一律以服务端返回为准（D12/D26）。等级只能由老板在管理端设定，登录绑手机号不提权。
const TIER_RETAIL = 'retail'
const TIER_WHOLESALE = 'wholesale'
const TIER_VIP = 'vip'
const TIER_LABELS = { retail: '零售', wholesale: '批发', vip: '白名单' }

function normalizeTier(tier) {
  return tier === TIER_WHOLESALE || tier === TIER_VIP ? tier : TIER_RETAIL
}
function validTier(tier) {
  if (tier == null || tier === '') return true
  return tier === TIER_RETAIL || tier === TIER_WHOLESALE || tier === TIER_VIP
}
function isWholesaleTier(tier) {
  return tier === TIER_WHOLESALE || tier === TIER_VIP
}
function tierLabel(tier) {
  return TIER_LABELS[normalizeTier(tier)] || '零售'
}
// 有效价：批发/白名单等级且设过批发价 → 批发价，否则零售价
function effectivePrice(tier, salePrice, wholesalePrice) {
  if (isWholesaleTier(tier) && +(wholesalePrice || 0) > 0) return round2(wholesalePrice)
  return round2(salePrice)
}

/* ---------------- 订单状态与动作（与 server 的 stateFlow 一致，第 24 轮） ---------------- */
// 状态机：pending → delivering / ready → done；pending → cancelled。
// 页面不再在 wxml 里写 status==='pending' 这种散落判断，一律走 orderActions()。
// 第 27 轮：文案与 server/internal/pricing/pricing.go、Web 端逐字一致（三端同文案，测试锁定）。
const STATUS_LABELS = {
  pending: '待备货',
  delivering: '配送中',
  ready: '待取货',
  done: '已完成',
  cancelled: '已取消'
}
const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待备货' },
  { key: 'delivering', label: '配送中' },
  { key: 'ready', label: '待取货' },
  { key: 'done', label: '已完成' },
  { key: 'cancelled', label: '已取消' }
]
// 第 29 轮（0.9.0）：多了「去支付」——付款前 pending 单要给顾客一个付钱入口。
// 注意这里**不新增 status 值**：付没付款是 status 之外的第二个维度（paid）。
const ACTION_LABELS = { pay: '去支付', cancel: '取消订单', advance: '确认收货', reorder: '再来一单' }

function statusLabel(s) {
  return STATUS_LABELS[s] || '未知状态'
}
// 这个状态能做什么（数组，模板按 key 判断是否渲染按钮）
// 参数可以是 status 字符串（第 27 轮的老调用），也可以直接是订单对象（要判断付没付款）
function orderActions(s) {
  const o = (s && typeof s === 'object') ? s : { status: s }
  const st = o.status || (typeof s === 'string' ? s : '')
  if (st === 'pending') {
    // 超时未付 = 服务端马上会把它取消，只留「再来一单」
    if (payExpired(o)) return ['reorder']
    // 未付款：**开通了在线支付**才给「去支付」（第 31 轮 payEnabled，见下）
    if (!paidFlag(o)) return payEnabledFlag(o) ? ['pay', 'cancel'] : ['cancel']
    return ['cancel']
  }
  if (st === 'delivering' || st === 'ready') return ['advance']
  if (st === 'done' || st === 'cancelled') return ['reorder']
  return []
}
function actionLabel(k) {
  return ACTION_LABELS[k] || ''
}
// 动作对应的服务端状态目标（reorder 没有目标，只是把商品重新加购）
function actionTarget(k) {
  if (k === 'cancel') return 'cancelled'
  if (k === 'advance') return 'done'
  return ''
}
// 顾客端一句话进度说明
function statusHint(o) {
  if (!o) return ''
  if (o.status === 'pending') return o.deliveryType === 'delivery' ? '老板正在备货，稍后安排配送' : '老板正在备货，到店报手机号自提'
  if (o.status === 'delivering') return '正在配送途中，请留意电话'
  if (o.status === 'ready') return '已备好，到店报手机号即可取货'
  if (o.status === 'done') return '这笔已完成，谢谢惠顾'
  if (o.status === 'cancelled') return '这笔已取消，库存已回补'
  return ''
}

/* ---------------- 微信支付（第 29 轮 / 0.9.0，顾客侧收银台） ---------------- */
// 硬口径（见 docs/支付与配送-方案与验收.md §1.8）：不新增 status 值，
// 付没付款是 status 之外的第二个维度；三端文案只能长在这条延长线上：
//   pending + 未付款 → 待付款      pending + 已付款 → 待备货
//   超时未付 → 已取消（超时未付）  其余沿用第 27 轮 STATUS_LABELS
// paid 的真源在服务端。老数据 / 离线本地单根本没有 paid 字段 —— 一律按第 27 轮口径
// 当「已付款」，否则历史订单会集体被误判成「待付款」。
function paidFlag(o) {
  if (!o || typeof o !== 'object') return true
  // _mapOrder 会把「服务端根本没下发 paid」记成 paidKnown:false（历史订单 / 离线本地单）
  if (o.paidKnown === false) return true
  if (o.paid === undefined || o.paid === null || o.paid === '') return true
  return o.paid === true || o.paid === 1 || o.paid === '1' || o.paid === 'true'
}
function payExpireAt(o) {
  const obj = (o && typeof o === 'object') ? o : {}
  return Number(obj.payExpireAt || 0) || 0
}
// 第 31 轮（payEnabled）：微信支付是否开通。来自服务端 GET /api/settings 的派生字段
// （`payEnabled`，源于 pay.ready()）。**只有显式 true 才算开通**：字段缺失 / 请求失败 /
// 'true' / 1 一律按未开通 —— 与 Web web/mall.js 的 payOn（`x.payEnabled === true`）同一口径。
// 未开通时 pending 退回第 28 轮语义「待备货」：没有任何付款动作可做，把顾客叫去付一笔
// 付不出来的款只会让老板的备货队列恒空。
function payEnabledFlag(o) {
  return !!(o && typeof o === 'object' && o.payEnabled === true)
}
function nowSec() {
  return Math.floor(Date.now() / 1000)
}
// 支付超时：没付款 + 下过到期时间 + 已经到点。服务端每 60 秒扫一次把超时单取消，
// 所以顾客可能看到「还是 pending 但已经过期」这一小段窗口 —— 页面照样要说清是超时未付。
function payExpired(o, now) {
  const obj = (o && typeof o === 'object') ? o : {}
  if (paidFlag(obj)) return false
  const exp = payExpireAt(obj)
  if (!exp) return false
  return exp <= (Number(now) || nowSec())
}
function payLeftSeconds(o, now) {
  const exp = payExpireAt(o)
  if (!exp) return 0
  return Math.max(0, exp - (Number(now) || nowSec()))
}
function pad2(n) { return (n < 10 ? '0' : '') + n }
// 待付款倒计时文案：mm:ss，超过一小时给 h:mm:ss；付过款 / 没有到期时间返回空串
function payLeftText(o, now) {
  const obj = (o && typeof o === 'object') ? o : {}
  if (paidFlag(obj)) return ''
  if (!payExpireAt(obj)) return ''
  const left = payLeftSeconds(obj, now)
  if (left <= 0) return '已超时'
  const h = Math.floor(left / 3600)
  const m = Math.floor((left % 3600) / 60)
  const s = left % 60
  return (h > 0 ? h + ':' : '') + pad2(m) + ':' + pad2(s)
}
// 订单要显示的那句话（唯一真源，页面/WXML 不许自己拼 status + paid）
// 第 31 轮（payEnabled）：pending 内部再分一层 —— 开通了在线支付才可能「待付款」。
function orderLabel(o) {
  const obj = (o && typeof o === 'object') ? o : { status: o }
  const st = obj.status || 'pending'
  if (payExpired(obj)) return '已取消（超时未付）'
  if (st === 'pending') return (!paidFlag(obj) && payEnabledFlag(obj)) ? '待付款' : '待备货'
  return statusLabel(st)
}
// 待付款/超时那一句话。刻意与 statusHint 分开：statusHint 是三端共用口径（第 27 轮），
// 这里只是收银台给顾客的补充说明，改它不会动到 web 端那句话。
// 未开通在线支付时没有「还没付款」这回事（没人付得了），返回空串让页面别渲染。
function payHint(o) {
  const obj = (o && typeof o === 'object') ? o : {}
  if (payExpired(obj)) return '这笔订单超过支付时间，已经自动取消了'
  if (!paidFlag(obj) && !payEnabledFlag(obj)) return ''
  return '还没付款，付了款老板马上备货'
}
// 金额（整数分 → ¥6.00）。金额真源是服务端下发的整数分，前端只做展示换算（第 27 轮起金额整数分）。
function fenText(fen) {
  const n = Math.round(Number(fen) || 0)
  return '¥' + (n / 100).toFixed(2)
}

// ---- 退款态（第 29 轮追加）：顾客付了款、老板取消并退款，必须让顾客看见钱去哪了 ----
// 形状照 web/mall.js:396 payBadgeHTML（退款态优先于 paid 显示，退款中的单 paid 仍为 true），
// 文案与 web/admin.html:595 REFUND_LABELS 同源。**改这里必须同步改 Web，别只改一端。**
const REFUND_LABELS = {
  processing: '退款处理中',
  success: '已退款',
  fail: '退款失败，请联系店家'
}
// 提示色：processing 蓝 / success 灰（钱回来了，不用再扎眼）/ fail 红（必须一眼看见，不许静默）
const REFUND_TONES = { processing: 'info', success: 'done', fail: 'warn' }
// refundState 取值宽松处理：未知/空/后端没这个字段 → 当作「没有退款这回事」，绝不抛错
function refundState(o) {
  const obj = (o && typeof o === 'object') ? o : {}
  return String(obj.refundState || '')
}
function refundLabel(o) {
  return REFUND_LABELS[refundState(o)] || ''
}
function refundTone(o) {
  return REFUND_TONES[refundState(o)] || ''
}
// 订单上要显示的退款提示：只在「已取消」的单上提示（其它状态即便带 refundState 也先不显示），
// 认不出来的 refundState 一律返回空串，页面据此不渲染那一行。
function refundText(o) {
  const obj = (o && typeof o === 'object') ? o : {}
  if (String(obj.status || '') !== 'cancelled') return ''
  return REFUND_LABELS[refundState(obj)] || ''
}
// 只有退款成功才谈得上退款单号（详情页折叠显示，列表页不显示）
function refundNo(o) {
  const obj = (o && typeof o === 'object') ? o : {}
  if (refundState(obj) !== 'success') return ''
  return String(obj.refundId || '')
}

module.exports = {
  MIN_FREE, DELIVERY_FEE, round2, deliveryFee, feeHint,
  TIER_RETAIL, TIER_WHOLESALE, TIER_VIP,
  normalizeTier, validTier, isWholesaleTier, tierLabel, effectivePrice,
  STATUS_LABELS, STATUS_TABS, ACTION_LABELS,
  statusLabel, orderActions, actionLabel, actionTarget, statusHint,
  paidFlag, payExpireAt, payEnabledFlag, payExpired, payLeftSeconds, payLeftText,
  orderLabel, payHint, fenText, nowSec,
  REFUND_LABELS, REFUND_TONES, refundState, refundLabel, refundTone, refundText, refundNo
}

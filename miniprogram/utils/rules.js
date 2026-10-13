// 配送费规则（小程序端展示用；下单时以服务端计算结果为准）
// 与 server/internal/pricing 保持一致：自提 0 元；配送满 30 元免配送费，否则 3 元。
const MIN_FREE = 30
const DELIVERY_FEE = 3

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100
}

// kind: 'pickup' | 'delivery'
function deliveryFee(kind, subtotal) {
  if (kind !== 'delivery') return 0
  return round2(subtotal) >= MIN_FREE ? 0 : DELIVERY_FEE
}

// 给用户看的一句话说明
function feeHint(kind, subtotal) {
  if (kind !== 'delivery') return '自提免配送费'
  const s = round2(subtotal)
  if (s >= MIN_FREE) return '已满 ' + MIN_FREE + ' 元，免配送费'
  return '还差 ' + round2(MIN_FREE - s) + ' 元免配送费（否则 ' + DELIVERY_FEE + ' 元）'
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
const STATUS_LABELS = {
  pending: '待处理',
  delivering: '配送中',
  ready: '待自提',
  done: '已完成',
  cancelled: '已取消'
}
const STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'delivering', label: '配送中' },
  { key: 'ready', label: '待自提' },
  { key: 'done', label: '已完成' },
  { key: 'cancelled', label: '已取消' }
]
const ACTION_LABELS = { cancel: '取消订单', advance: '确认收货', reorder: '再来一单' }

function statusLabel(s) {
  return STATUS_LABELS[s] || '未知状态'
}
// 这个状态能做什么（数组，模板按 key 判断是否渲染按钮）
function orderActions(s) {
  if (s === 'pending') return ['cancel']
  if (s === 'delivering' || s === 'ready') return ['advance']
  if (s === 'done' || s === 'cancelled') return ['reorder']
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

module.exports = {
  MIN_FREE, DELIVERY_FEE, round2, deliveryFee, feeHint,
  TIER_RETAIL, TIER_WHOLESALE, TIER_VIP,
  normalizeTier, validTier, isWholesaleTier, tierLabel, effectivePrice,
  STATUS_LABELS, STATUS_TABS, ACTION_LABELS,
  statusLabel, orderActions, actionLabel, actionTarget, statusHint
}

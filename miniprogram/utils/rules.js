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

module.exports = { MIN_FREE, DELIVERY_FEE, round2, deliveryFee, feeHint }

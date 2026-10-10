// 购物车 + 收货信息（存本地 storage；下单时以服务端结果为准）
const rules = require('./rules.js')

const CART_KEY = 'sdy_mp_cart'
const CUST_KEY = 'sdy_mp_customer'

function hasWx() {
  return typeof wx !== 'undefined' && wx && typeof wx.getStorageSync === 'function'
}
function sget(k, d) {
  if (!hasWx()) return d
  try {
    const v = wx.getStorageSync(k)
    return v === '' || v === undefined || v === null ? d : v
  } catch (e) {
    return d
  }
}
function sset(k, v) {
  if (!hasWx()) return
  try { wx.setStorageSync(k, v) } catch (e) { /* 忽略 */ }
}

function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}

function getCart() {
  const list = sget(CART_KEY, [])
  return Array.isArray(list) ? list : []
}
function saveCart(list) {
  sset(CART_KEY, list)
  return list
}

function addToCart(p, qty) {
  const n = num(qty) || 1
  const list = getCart()
  const hit = list.filter((it) => it.code === p.code)[0]
  if (hit) {
    hit.qty = num(hit.qty) + n
  } else {
    list.push({
      code: String(p.code || ''),
      name: p.name || '',
      spec: p.spec || '',
      unit: p.unit || '件',
      emoji: p.emoji || '🛒',
      price: num(p.salePrice !== undefined ? p.salePrice : p.price),
      qty: n
    })
  }
  return saveCart(list)
}

function setQty(code, qty) {
  const list = getCart()
  const hit = list.filter((it) => it.code === code)[0]
  if (!hit) return list
  hit.qty = num(qty)
  const kept = list.filter((it) => num(it.qty) > 0)
  return saveCart(kept)
}

function removeFromCart(code) {
  return saveCart(getCart().filter((it) => it.code !== code))
}
function clearCart() {
  return saveCart([])
}
function cartCount() {
  return getCart().reduce((s, it) => s + num(it.qty), 0)
}
function cartAmount() {
  return rules.round2(getCart().reduce((s, it) => s + num(it.price) * num(it.qty), 0))
}

// 下单用的精简明细
function orderItems() {
  return getCart().map((it) => ({
    code: it.code, name: it.name, price: num(it.price), qty: num(it.qty)
  }))
}

function getCustomer() {
  const c = sget(CUST_KEY, null)
  return c && typeof c === 'object' ? c : { name: '', phone: '', address: '' }
}
function saveCustomer(c) {
  sset(CUST_KEY, c || {})
  return c
}

module.exports = {
  CART_KEY: CART_KEY,
  CUST_KEY: CUST_KEY,
  getCart: getCart,
  addToCart: addToCart,
  setQty: setQty,
  removeFromCart: removeFromCart,
  clearCart: clearCart,
  cartCount: cartCount,
  cartAmount: cartAmount,
  orderItems: orderItems,
  getCustomer: getCustomer,
  saveCustomer: saveCustomer,
  deliveryFee: rules.deliveryFee,
  feeHint: rules.feeHint
}

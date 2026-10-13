// 购物车 + 收货信息（存本地 storage；下单时以服务端结果为准）
// 第 24 轮：加勾选态（全选/单选）、立即购买直通、tabBar 角标。
const rules = require('./rules.js')

const CART_KEY = 'sdy_mp_cart'
const CUST_KEY = 'sdy_mp_customer'
const BUYNOW_KEY = 'sdy_mp_buynow'
const CART_TAB_INDEX = 2 // tabBar：首页 0 / 分类 1 / 购物车 2 / 订单 3 / 我的 4

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
function sdel(k) {
  if (!hasWx()) return
  try { wx.removeStorageSync(k) } catch (e) { /* 忽略 */ }
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
  syncTabBadge()
  return list
}

// tabBar 购物车角标（0 件就摘掉角标）
function syncTabBadge() {
  if (typeof wx === 'undefined' || !wx || typeof wx.setTabBarBadge !== 'function') return
  const n = cartCount()
  try {
    if (n > 0) wx.setTabBarBadge({ index: CART_TAB_INDEX, text: n > 99 ? '99+' : String(n) })
    else wx.removeTabBarBadge({ index: CART_TAB_INDEX })
  } catch (e) { /* 不在 tabBar 页面时可能失败，忽略 */ }
}

function addToCart(p, qty) {
  const n = num(qty) || 1
  const list = getCart()
  const hit = list.filter((it) => it.code === p.code)[0]
  if (hit) {
    hit.qty = num(hit.qty) + n
    if (hit.checked === undefined) hit.checked = true
  } else {
    list.push({
      code: String(p.code || ''),
      name: p.name || '',
      spec: p.spec || '',
      unit: p.unit || '件',
      emoji: p.emoji || '🛒',
      img: p.img || '',
      price: num(p.salePrice !== undefined ? p.salePrice : p.price),
      qty: n,
      checked: true
    })
  }
  saveCart(list)
  return list
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
// 改购物车里的单价：登录 / 换等级后按服务端有效价刷新（价格真源在服务端，D24）
function setPrice(code, price) {
  const list = getCart()
  const hit = list.filter((it) => it.code === code)[0]
  if (!hit) return list
  hit.price = num(price)
  return saveCart(list)
}
function clearCart() {
  return saveCart([])
}
function cartCount() {
  return getCart().reduce((s, it) => s + num(it.qty), 0)
}

/* ---------------- 勾选态（第 24 轮） ---------------- */
// 老数据没有 checked 字段：一律当勾选（否则升级后用户发现合计变 0，会以为坏了）
function isChecked(it) {
  return it.checked === undefined ? true : !!it.checked
}
function checkedItems() {
  return getCart().filter(isChecked)
}
function setChecked(code, v) {
  const list = getCart()
  const hit = list.filter((it) => it.code === code)[0]
  if (!hit) return list
  hit.checked = !!v
  return saveCart(list)
}
function setAllChecked(v) {
  const list = getCart().map((it) => {
    it.checked = !!v
    return it
  })
  return saveCart(list)
}
function allChecked() {
  const list = getCart()
  return list.length > 0 && list.every(isChecked)
}
// 合计只算勾选项（下单也只提交勾选项）
function cartAmount() {
  return rules.round2(checkedItems().reduce((s, it) => s + num(it.price) * num(it.qty), 0))
}
function cartCheckedCount() {
  return checkedItems().reduce((s, it) => s + num(it.qty), 0)
}

// 下单用的精简明细（只带勾选的）
function orderItems() {
  return checkedItems().map((it) => ({
    code: it.code, name: it.name, price: num(it.price), qty: num(it.qty)
  }))
}
function checkedLines() {
  return checkedItems().map((it) => ({
    code: it.code, name: it.name, price: num(it.price), qty: num(it.qty),
    unit: it.unit, emoji: it.emoji, img: it.img
  }))
}

/* ---------------- 立即购买直通（第 24 轮） ---------------- */
// 详情页「立即购买」把这一件放进 storage，购物车页读到就用它渲染，
// 消费后立刻删掉，避免下次进购物车又把上次的「立即购买」翻出来。
function setBuyNow(lines) {
  sset(BUYNOW_KEY, lines || [])
  return lines || []
}
function takeBuyNow() {
  const v = sget(BUYNOW_KEY, null)
  sdel(BUYNOW_KEY)
  return Array.isArray(v) && v.length ? v : null
}

// 地址簿选择回传：地址列表页写、购物车页读并立刻删除（消费即清）
const PICK_KEY = 'sdy_mp_pick_address'
function setPickedAddress(a) {
  sset(PICK_KEY, a || null)
  return a
}
function takePickedAddress() {
  const v = sget(PICK_KEY, null)
  sdel(PICK_KEY)
  return v && typeof v === 'object' ? v : null
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
  BUYNOW_KEY: BUYNOW_KEY,
  PICK_KEY: PICK_KEY,
  getCart: getCart,
  addToCart: addToCart,
  setQty: setQty,
  setPrice: setPrice,
  removeFromCart: removeFromCart,
  clearCart: clearCart,
  cartCount: cartCount,
  cartAmount: cartAmount,
  cartCheckedCount: cartCheckedCount,
  isChecked: isChecked,
  setChecked: setChecked,
  setAllChecked: setAllChecked,
  allChecked: allChecked,
  checkedLines: checkedLines,
  orderItems: orderItems,
  syncTabBadge: syncTabBadge,
  setBuyNow: setBuyNow,
  takeBuyNow: takeBuyNow,
  setPickedAddress: setPickedAddress,
  takePickedAddress: takePickedAddress,
  getCustomer: getCustomer,
  saveCustomer: saveCustomer,
  deliveryFee: rules.deliveryFee,
  feeHint: rules.feeHint
}

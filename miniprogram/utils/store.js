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
// 购物车落盘 + 角标同步 + 通知订阅页面（第 27 轮 P0-1：唯一真源）
function saveCart(list) {
  sset(CART_KEY, list)
  syncTabBadge()
  emit()
  return list
}

// tabBar 购物车角标（0 件就摘掉角标）
// 第 27 轮（P0-1）：角标是购物车的**唯一真源**，所有页面都通过 store 触发同步，
// 不再各页各写一份。首帧可能早于 tabBar 就绪，失败重试两次再放弃。
function syncTabBadge() {
  if (typeof wx === 'undefined' || !wx || typeof wx.setTabBarBadge !== 'function') return
  const n = cartCount()
  const text = n > 0 ? (n > 99 ? '99+' : String(n)) : ''
  let left = 3
  const push = () => {
    try {
      if (text) wx.setTabBarBadge({ index: CART_TAB_INDEX, text: text })
      else wx.removeTabBarBadge({ index: CART_TAB_INDEX })
      return true
    } catch (e) {
      return false
    }
  }
  const tick = () => {
    if (push()) return
    left -= 1
    if (left > 0 && typeof setTimeout === 'function') setTimeout(tick, 60)
  }
  tick()
}

// 购物车变更订阅：页面只订阅「购物车变了」这件事，不再手写 syncCart 副本（第 27 轮 P0-1）
const subscribers = []
function subscribe(fn) {
  if (typeof fn !== 'function') return function () {}
  subscribers.push(fn)
  return function () {
    const i = subscribers.indexOf(fn)
    if (i >= 0) subscribers.splice(i, 1)
  }
}
function emit() {
  subscribers.slice().forEach((fn) => {
    try { fn() } catch (e) { /* 单个页面出错不影响其它页面 */ }
  })
}

function addToCart(p, qty) {
  const n = num(qty) || 1
  const list = getCart()
  const stock = num(p.stock)
  const hit = list.filter((it) => it.code === p.code)[0]
  if (hit) {
    hit.qty = num(hit.qty) + n
    // 库存以最新一次加购拿到的为准（第 27 轮：购物车数量上限 = 该商品库存）
    hit.stock = stock
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
      stock: stock,
      checked: true
    })
  }
  saveCart(list)
  return list
}

// 该商品在购物车里的库存上限（缺失时返回 0 = 未知，页面据此不限制）
function cartStock(code) {
  const hit = getCart().filter((it) => it.code === code)[0]
  return hit ? num(hit.stock) : 0
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

// 刷新一条购物车明细的服务端状态（第 27 轮：失效商品分组用）
// stock = 服务端库存；valid=false 表示已下架/已删除/库存为 0，结算时必须排除
function setLineMeta(code, meta) {
  const list = getCart()
  const hit = list.filter((it) => it.code === code)[0]
  if (!hit) return list
  const m = meta || {}
  if (m.stock !== undefined) hit.stock = num(m.stock)
  if (m.valid !== undefined) hit.valid = !!m.valid
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
// 第 27 轮：已下架 / 已删除 / 库存为 0 的行不参与结算与合计（页面单独分组展示）
function isValid(it) {
  return it.valid !== false
}
function checkedItems() {
  return getCart().filter((it) => isValid(it) && isChecked(it))
}
function setChecked(code, v) {
  const list = getCart()
  const hit = list.filter((it) => it.code === code)[0]
  if (!hit) return list
  hit.checked = !!v
  return saveCart(list)
}
function setCheckedCodes(codes, v) {
  const set = {}
  ;(codes || []).forEach((c) => { set[c] = 1 })
  const list = getCart().map((it) => {
    if (set[it.code]) it.checked = !!v
    return it
  })
  return saveCart(list)
}
function setAllChecked(v) {
  const list = getCart().map((it) => {
    if (isValid(it)) it.checked = !!v
    return it
  })
  return saveCart(list)
}
function allChecked() {
  const list = getCart().filter(isValid)
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
  setLineMeta: setLineMeta,
  removeFromCart: removeFromCart,
  clearCart: clearCart,
  cartCount: cartCount,
  cartStock: cartStock,
  cartAmount: cartAmount,
  cartCheckedCount: cartCheckedCount,
  isChecked: isChecked,
  isValid: isValid,
  setChecked: setChecked,
  setCheckedCodes: setCheckedCodes,
  setAllChecked: setAllChecked,
  allChecked: allChecked,
  checkedLines: checkedLines,
  orderItems: orderItems,
  syncTabBadge: syncTabBadge,
  subscribe: subscribe,
  setBuyNow: setBuyNow,
  takeBuyNow: takeBuyNow,
  setPickedAddress: setPickedAddress,
  takePickedAddress: takePickedAddress,
  getCustomer: getCustomer,
  saveCustomer: saveCustomer,
  deliveryFee: rules.deliveryFee,
  feeHint: rules.feeHint
}

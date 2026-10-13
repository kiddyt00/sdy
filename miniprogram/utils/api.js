// 小邻里超市 · 小程序端后端通道（M5）
// 与 web/sdy-api.js、barcode-demo/bd-api.js 同构：后端是唯一真源，
// 探测不到后端就自动降级为「本地演示」，页面照常可点（只是数据不落库）。
//
// 后端地址优先级：setBase(显式) > wx.storage[sdy_api_base] > DEFAULT_BASE
// 开发：微信开发者工具「详情 → 本地设置」勾选「不校验合法域名」，直连本机 Go 后端 127.0.0.1:8093
// 上线：**只改 utils/config.js 的 PROD_BASE_URL**（小程序服务器域名必须 HTTPS + 已备案）

const store = require('./store.js')
const rules = require('./rules.js')
const config = require('./config.js')

const LS_BASE_KEY = 'sdy_api_base'
const LS_PRODUCTS_KEY = 'sdy_mp_products'
const LS_ORDERS_KEY = 'sdy_mp_orders'
const LS_SESSION_KEY = 'sdy_mp_session'
const DEFAULT_BASE = config.DEFAULT_BASE_URL
const TIMEOUT_MS = 8000

const state = {
  online: false,
  base: DEFAULT_BASE,
  lastError: '',
  cloudConfigured: false,
  circuitOpen: false,
  cloudFails: 0
}

// ---------- 本地存储（wx 可能不存在：便于 Node 单测） ----------
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
  try { wx.setStorageSync(k, v) } catch (e) { /* 忽略：存储满/被清理 */ }
}
function sdel(k) {
  if (!hasWx()) return
  try { wx.removeStorageSync(k) } catch (e) { /* 忽略 */ }
}

function trimBase(u) {
  return String(u || '').trim().replace(/\/+$/, '')
}
function base() {
  return trimBase(state.base)
}
function setBase(url) {
  state.base = trimBase(url) || DEFAULT_BASE
  sset(LS_BASE_KEY, state.base)
  return state.base
}

// ---------- 请求 ----------
function request(method, path, data) {
  return new Promise((resolve, reject) => {
    const b = base()
    if (typeof wx === 'undefined' || !wx || typeof wx.request !== 'function') {
      reject(new Error('当前环境没有 wx.request'))
      return
    }
    wx.request({
      url: b + path,
      method: method,
      data: data || undefined,
      timeout: TIMEOUT_MS,
      header: { 'content-type': 'application/json' },
      success(res) {
        const d = res && res.data !== undefined ? res.data : {}
        if (res && res.statusCode >= 200 && res.statusCode < 300) {
          resolve(d)
          return
        }
        const msg = (d && (d.error || d.msg)) || ('HTTP ' + (res && res.statusCode))
        reject(new Error(msg))
      },
      fail(err) {
        const m = (err && (err.errMsg || err.msg)) || '请求失败'
        reject(new Error('无法连接后端（' + b + '）：' + m))
      }
    })
  })
}

// 探测一次后端（不轮询）；失败也 resolve，便于页面降级渲染
function probe() {
  return request('GET', '/healthz').then(
    (h) => {
      state.online = true
      state.lastError = ''
      state.cloudConfigured = !!h.cloudConfigured
      state.circuitOpen = !!h.circuitOpen
      state.cloudFails = h.cloudFails || 0
      return status()
    },
    (e) => {
      state.online = false
      state.lastError = e.message
      return status()
    }
  )
}

function status() {
  const online = state.online
  let detail
  if (online) {
    detail = '后端已连接，下单与库存以服务端为准'
    if (state.circuitOpen) detail += '；云端条码查询今日熔断，店里扫码建档会先走本地'
  } else {
    detail = '后端未连接：本地演示模式（下单不会入库）' + (state.lastError ? '；' + state.lastError : '')
  }
  return {
    online: online,
    mode: online ? 'server' : 'local',
    base: base(),
    error: state.lastError,
    cloudConfigured: state.cloudConfigured,
    circuitOpen: state.circuitOpen,
    cloudFails: state.cloudFails,
    label: online ? '🟢 后端已连接' : '🟡 本地演示',
    detail: detail
  }
}

// ---------- 商品 ----------
const EMOJI = [
  [/可乐|雪碧|汽水|芬达/, '🥤'],
  [/水|矿泉水|农夫山泉|饮料/, '💧'],
  [/纸|抽纸|卷纸|纸巾/, '🧻'],
  [/饼|薯片|零食|糖|果冻/, '🍪'],
  [/啤酒|酒/, '🍺'],
  [/奶|牛奶|酸奶/, '🥛'],
  [/米|面|油/, '🍚']
]
function emojiFor(name) {
  const n = String(name || '')
  for (let i = 0; i < EMOJI.length; i++) if (EMOJI[i][0].test(n)) return EMOJI[i][1]
  return '🛒'
}
function num(v) {
  const n = Number(v)
  return isFinite(n) ? n : 0
}
function mapProduct(p) {
  // 价格真源在服务端（D12/D24）：带 phone 请求时，服务端按顾客等级算好 price，
  // 小程序只读不换算；没带 phone（未登录）时一律零售价。
  const retail = num(p.salePrice)
  const eff = num(p.price) > 0 ? num(p.price) : retail
  return {
    code: String(p.code || ''),
    name: p.name || '',
    brand: p.brand || '',
    spec: p.spec || '',
    category: p.category || '其他',
    unit: p.unit || '件',
    emoji: emojiFor(p.name),
    salePrice: eff,
    retailPrice: retail,
    priceText: eff.toFixed(2),
    isWholesale: !!p.isWholesale,
    wholesalePrice: num(p.wholesalePrice),
    tier: p.tier || '',
    stock: num(p.stock),
    syncStatus: p.syncStatus || '',
    server: true
  }
}

// 演示用商品（后端连不上时也能把页面点完；server:false 提醒「这不是真数据」）
const LOCAL_PRODUCTS = [
  { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐', category: '饮料', unit: '罐', salePrice: 2.5, stock: 120 },
  { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml 瓶', category: '饮料', unit: '瓶', salePrice: 1.8, stock: 200 },
  { code: '6921168509256', name: '心相印抽纸', brand: '心相印', spec: '3 层 130 抽', category: '日用', unit: '包', salePrice: 4.5, stock: 60 },
  { code: '6925303725941', name: '旺旺雪饼', brand: '旺旺', spec: '84g', category: '零食', unit: '袋', salePrice: 4.5, stock: 40 },
  { code: '6901001100113', name: '青岛啤酒', brand: '青岛', spec: '500ml 罐', category: '酒水', unit: '罐', salePrice: 6.0, stock: 90 },
  { code: '6907992751797', name: '伊利纯牛奶', brand: '伊利', spec: '250ml 盒', category: '乳品', unit: '盒', salePrice: 3.5, stock: 80 }
].map((p) => {
  const m = mapProduct(p)
  m.server = false
  return m
})

function localProducts(keyword) {
  const cached = sget(LS_PRODUCTS_KEY, null)
  const list = cached && cached.length ? cached : LOCAL_PRODUCTS
  const kw = String(keyword || '').trim()
  if (!kw) return list
  return list.filter((p) => (p.name + p.brand + p.spec + p.code).indexOf(kw) >= 0)
}

// 商品列表；在线时顺便把服务端商品缓存到本地（断网也能看）
// 顾客端只看上架商品（onSale=1，D23）；已登录就带 phone，让服务端按等级给价（D24）。
function listProducts(keyword) {
  if (!state.online) return Promise.resolve(localProducts(keyword))
  const qs = ['onSale=1']
  if (keyword) qs.push('keyword=' + encodeURIComponent(keyword))
  const ph = boundPhone()
  if (ph) qs.push('phone=' + encodeURIComponent(ph))
  return request('GET', '/api/products?' + qs.join('&')).then((d) => {
    const items = (d.items || []).map(mapProduct)
    if (!keyword) sset(LS_PRODUCTS_KEY, items)
    return items
  })
}

// ---------- 微信登录（第 23 轮 / D28） ----------
// 手机号仍是业务身份（D24）：openid 只记住「这台微信是谁」，免去每次重输手机号；
// 价格与等级一律由服务端按顾客档案下发，小程序不自己算、也存不下任何密钥（D13/D26）。

function session() {
  const s = sget(LS_SESSION_KEY, null)
  return s && typeof s === 'object' ? s : null
}
function saveSession(s) {
  sset(LS_SESSION_KEY, s)
  return s
}
function clearSession() {
  sdel(LS_SESSION_KEY)
  sdel(LS_PRODUCTS_KEY) // 价格跟着等级走，退出登录别留旧价
  return null
}
// 已绑定的手机号（没登录 / 只登录没绑号就是空串）
function boundPhone() {
  const s = session()
  return s && s.phone ? String(s.phone) : ''
}
function isLoggedIn() {
  const s = session()
  return !!(s && s.openid)
}
// 给页面用的一句话状态
function sessionLabel() {
  const s = session()
  if (!s || !s.openid) return '未登录（登录后免输手机号）'
  if (!s.phone) return '已登录 · 还没绑手机号'
  return '已登录 · ' + (s.name || '微信顾客') + ' · ' + rules.tierLabel(s.tier)
}

// 登录：wx.login 的 code 换 openid；带 phone 就顺手绑上。
// 绑定**不提权**——批发/白名单只能由老板在管理端设定（D24）。
function wxLogin(opts) {
  const o = opts || {}
  if (typeof wx === 'undefined' || !wx || typeof wx.login !== 'function') {
    return Promise.reject(new Error('当前环境没有 wx.login（请在小程序里使用）'))
  }
  if (!state.online) {
    return Promise.reject(new Error('后端未连接：登录要连上服务端才能用（本地演示模式不联网）'))
  }
  return new Promise((resolve, reject) => {
    wx.login({
      success(res) {
        const code = res && res.code
        if (!code) {
          reject(new Error('微信没有返回 code，请重试'))
          return
        }
        const body = { code: String(code) }
        if (o.phone) body.phone = String(o.phone).trim()
        if (o.nickname) body.nickname = String(o.nickname).trim()
        request('POST', '/api/wx/login', body).then((d) => {
          const s = saveSession({
            openid: d.openid || '',
            bound: !!d.bound,
            phone: d.phone || '',
            name: d.name || '',
            tier: d.tier || rules.TIER_RETAIL,
            at: Date.now()
          })
          sdel(LS_PRODUCTS_KEY) // 等级可能变了，价格缓存作废
          resolve(s)
        }, reject)
      },
      fail(err) {
        reject(new Error((err && err.errMsg) || 'wx.login 失败'))
      }
    })
  })
}

// ---------- 订单 ----------
function localOrders() {
  return sget(LS_ORDERS_KEY, [])
}
function saveLocalOrders(list) {
  sset(LS_ORDERS_KEY, list)
}

function mapOrder(o) {
  const items = (o.items || []).map((it) => ({
    code: String(it.code || ''),
    name: it.name || '',
    price: num(it.price),
    qty: num(it.qty),
    amount: Math.round(num(it.price) * num(it.qty) * 100) / 100,
    amountText: (num(it.price) * num(it.qty)).toFixed(2)
  }))
  const statusMap = {
    pending: '待处理', delivering: '配送中', ready: '待自提', done: '已完成', cancelled: '已取消'
  }
  return {
    id: String(o.id || ''),
    customerName: o.customerName || '',
    phone: o.phone || '',
    address: o.address || '',
    deliveryType: o.deliveryType === 'delivery' ? 'delivery' : 'pickup',
    deliveryText: o.deliveryType === 'delivery' ? '送货上门' : '到店自提',
    subtotal: num(o.subtotal),
    subtotalText: num(o.subtotal).toFixed(2),
    deliveryFee: num(o.deliveryFee),
    total: num(o.total),
    totalText: num(o.total).toFixed(2),
    feeText: num(o.deliveryFee).toFixed(2),
    status: o.status || 'pending',
    statusText: statusMap[o.status] || o.status || '待处理',
    items: items,
    count: items.reduce((s, it) => s + it.qty, 0),
    summary: items.map((it) => it.name + '×' + it.qty).join('、'),
    createdAt: o.createdAt || '',
    createdText: fmtTime(o.createdAt)
  }
}
function fmtTime(v) {
  if (!v) return ''
  const t = Date.parse(v)
  if (isNaN(t)) return String(v)
  const d = new Date(t)
  const p = (n) => (n < 10 ? '0' + n : '' + n)
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
}

// 下单：在线走后端（服务端算钱、扣库存）；离线只在本地记一笔，不冒充成功
function createOrder(input) {
  const body = {
    customerName: input.customerName,
    phone: input.phone,
    address: input.address || '',
    deliveryType: input.deliveryType,
    items: (input.items || []).map((it) => ({ code: it.code, qty: it.qty }))
  }
  if (!state.online) {
    const subtotal = (input.items || []).reduce((s, it) => s + num(it.price) * num(it.qty), 0)
    const fee = store.deliveryFee(body.deliveryType, subtotal)
    const o = mapOrder({
      id: 'L' + Date.now(),
      customerName: body.customerName,
      phone: body.phone,
      address: body.address,
      deliveryType: body.deliveryType,
      subtotal: subtotal,
      deliveryFee: fee,
      total: subtotal + fee,
      status: 'pending',
      items: (input.items || []).map((it) => ({ code: it.code, name: it.name, price: it.price, qty: it.qty })),
      createdAt: new Date().toISOString()
    })
    const list = localOrders()
    list.unshift(o)
    saveLocalOrders(list)
    return Promise.resolve({ order: o, local: true })
  }
  return request('POST', '/api/orders', body).then((d) => ({ order: mapOrder(d), local: false }))
}

function listOrders() {
  if (!state.online) return Promise.resolve(localOrders().map(mapOrder))
  return request('GET', '/api/orders').then((d) => (d.items || []).map(mapOrder))
}

function getOrder(id) {
  if (!state.online) {
    const hit = localOrders().filter((o) => o.id === id)[0]
    return hit ? Promise.resolve(mapOrder(hit)) : Promise.reject(new Error('订单不存在'))
  }
  return request('GET', '/api/orders/' + encodeURIComponent(id)).then(mapOrder)
}

// 顾客端只能取消自己的待处理订单（其余状态由店里在管理端推进）
function cancelOrder(id) {
  if (!state.online) {
    const list = localOrders()
    const hit = list.filter((o) => o.id === id)[0]
    if (!hit) return Promise.reject(new Error('订单不存在'))
    hit.status = 'cancelled'
    saveLocalOrders(list)
    return Promise.resolve(mapOrder(hit))
  }
  return request('POST', '/api/orders/' + encodeURIComponent(id) + '/advance', { to: 'cancelled' }).then(mapOrder)
}

// 扫码找货（**只读**，D8）：只回答「这个条码是哪个商品」，绝不改库存、绝不自动加购。
// 在线走后端条码解析链（商品表 → 本地条码库 → 云端识别）；离线只在本地演示商品里比对。
function resolveBarcode(code) {
  const c = String(code == null ? '' : code).trim()
  if (!c) return Promise.reject(new Error('条码为空'))
  if (!state.online) {
    const hit = LOCAL_PRODUCTS.filter((p) => String(p.code) === c)[0]
    if (hit) return Promise.resolve({ code: c, found: true, name: hit.name, spec: hit.spec, source: 'product' })
    return Promise.resolve({ code: c, found: false, source: 'not_found' })
  }
  return request('GET', '/api/barcode/resolve?code=' + encodeURIComponent(c))
}

function clearCache() {
  sdel(LS_PRODUCTS_KEY)
  sdel(LS_ORDERS_KEY)
}

// 启动时读取上次保存的后端地址（设置页可改）
state.base = trimBase(sget(LS_BASE_KEY, '')) || DEFAULT_BASE

module.exports = {
  DEFAULT_BASE,
  base: base,
  setBase: setBase,
  probe: probe,
  status: status,
  listProducts: listProducts,
  resolveBarcode: resolveBarcode,
  wxLogin: wxLogin,
  session: session,
  clearSession: clearSession,
  isLoggedIn: isLoggedIn,
  boundPhone: boundPhone,
  sessionLabel: sessionLabel,
  createOrder: createOrder,
  listOrders: listOrders,
  getOrder: getOrder,
  cancelOrder: cancelOrder,
  clearCache: clearCache,
  emojiFor: emojiFor,
  _state: state,
  _mapProduct: mapProduct,
  _mapOrder: mapOrder,
  _local: { products: LOCAL_PRODUCTS }
}

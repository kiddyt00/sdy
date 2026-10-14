// 啥都有快送 · 小程序端后端通道（M5）
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
function request(method, path, data, header) {
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
      header: Object.assign({ 'content-type': 'application/json' }, header || {}),
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

// 商品图：后端存的是相对路径（assets/demo/kele.svg）或完整 URL，这里统一补成绝对地址。
// 注意：小程序 `<image>` 加载网络图，需要在「downloadFile 合法域名」里配置同一个域名。
function imgUrl(raw) {
  const s = String(raw || '').trim()
  if (!s) return ''
  if (/^https?:\/\//i.test(s)) return s
  return base() + '/' + s.replace(/^\/+/, '')
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
    category: p.category || '未分类',
    unit: p.unit || '件',
    emoji: emojiFor(p.name),
    img: imgUrl(p.img),
    // salePrice 沿用老字段名存「有效价」；price 与服务端线格式同名，页面两个都能读
    price: eff,
    salePrice: eff,
    retailPrice: retail,
    priceText: eff.toFixed(2),
    isWholesale: !!p.isWholesale,
    wholesalePrice: num(p.wholesalePrice),
    tier: p.tier || '',
    stock: num(p.stock),
    onSale: p.onSale !== false,
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
// category 传空 / '全部' 就是不筛分类（第 24 轮分类页用）。
function listProducts(keyword, category) {
  const cat = String(category || '').trim()
  const useCat = cat && cat !== '全部'
  if (!state.online) {
    let list = localProducts(keyword)
    if (useCat) list = list.filter((p) => (p.category || '未分类') === cat)
    return Promise.resolve(list)
  }
  const qs = ['onSale=1']
  if (keyword) qs.push('keyword=' + encodeURIComponent(keyword))
  if (useCat) qs.push('category=' + encodeURIComponent(cat))
  const ph = boundPhone()
  if (ph) qs.push('phone=' + encodeURIComponent(ph))
  return request('GET', '/api/products?' + qs.join('&')).then((d) => {
    const items = (d.items || []).map(mapProduct)
    if (!keyword && !useCat) sset(LS_PRODUCTS_KEY, items)
    return items
  })
}

// 单个商品详情（第 24 轮）。带 phone 时服务端按等级算有效价，口径与列表完全一致。
function getProduct(code) {
  const c = String(code == null ? '' : code).trim()
  if (!c) return Promise.reject(new Error('商品条码为空'))
  if (!state.online) {
    const hit = localProducts('').filter((p) => p.code === c)[0]
    return hit ? Promise.resolve(hit) : Promise.reject(new Error('商品不存在或已下架'))
  }
  const ph = boundPhone()
  const qs = ph ? '?phone=' + encodeURIComponent(ph) : ''
  return request('GET', '/api/products/' + encodeURIComponent(c) + qs).then(mapProduct)
}

// 全部商品（含已下架）——员工端库存页用：顾客端只看上架，员工要能看见下架的货（D23）。
function listAllProducts(keyword) {
  const kw = String(keyword || '').trim()
  if (!state.online) return Promise.resolve(localProducts(kw))
  const qs = kw ? '?keyword=' + encodeURIComponent(kw) : ''
  return request('GET', '/api/products' + qs).then((d) => (d.items || []).map(mapProduct))
}

// 分类与件数（顾客端只看上架商品）
function listCategories() {
  if (!state.online) {
    const m = {}
    localProducts('').forEach((p) => {
      const k = p.category || '未分类'
      m[k] = (m[k] || 0) + 1
    })
    return Promise.resolve(Object.keys(m).map((k) => ({ name: k, count: m[k] })))
  }
  return request('GET', '/api/products/categories?onSale=1').then((d) => d.items || [])
}

// ---------- 微信登录（第 23 轮 / D28；第 25 轮 / D31 起不绑手机号） ----------
// 登录只记住「这台微信是谁」（openid + 微信头像昵称）；**手机号不属于登录**，
// 它只是下单时填的收货信息（价格身份由它承载，D24）。
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
// 已绑定的手机号（没登录 / 登录了还没在下单时填过就是空串）
function boundPhone() {
  const s = session()
  return s && s.phone ? String(s.phone) : ''
}
function isLoggedIn() {
  const s = session()
  return !!(s && s.openid)
}
// 「我的」页显示用的名字：老板维护的姓名 > 微信昵称 > 兜底
function displayName() {
  const s = session()
  if (!s) return ''
  if (s.name) return String(s.name)
  if (s.nickname) return String(s.nickname)
  return s.openid ? '微信顾客' : ''
}
// 给页面用的一句话状态
function sessionLabel() {
  const s = session()
  if (!s || !s.openid) return '未登录（登录后免输手机号）'
  if (!s.phone) return '微信已登录 · 手机号下单时再填'
  return '已登录 · ' + displayName() + ' · ' + rules.tierLabel(s.tier)
}

// 记住下单时填的手机号（第 25 轮 / D31）：登录不再问手机号，但手机号仍是
// 「价格身份 + 地址簿钥匙」（D24），所以下单时填过的号要留在本地会话里，
// 之后的价格查询、地址簿、再来一单才能用上；**等级一律由服务端按档案下发，本地不推断**。
function rememberPhone(phone) {
  const p = String(phone == null ? '' : phone).trim()
  if (!p) return session()
  const cur = session() || {}
  const next = saveSession(Object.assign({}, cur, { phone: p, bound: true, at: Date.now() }))
  sdel(LS_PRODUCTS_KEY) // 带上手机号后价格可能按等级变，缓存作废
  return next
}

// 登录：wx.login 的 code 换 openid；头像昵称可选（微信只能用官方「头像昵称填写能力」
// 让用户自己选，所以是登录前后由页面收集好传进来，不传也能登录成功）。
// 绑定手机号**不提权**——批发/白名单只能由老板在管理端设定（D24）。
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
        if (o.avatar) body.avatar = String(o.avatar).trim()
        // 登录时可选身份（第 26 轮 / D32）：顾客 / 员工。选员工要服务端认（后台把角色改成 staff
        // 才行），不是客户端说了算；没被标成员工的微信号选员工会被 403 挡回来。
        if (o.role) body.role = String(o.role).trim()
        request('POST', '/api/wx/login', body).then((d) => {
          const role = d.role === 'staff' ? 'staff' : 'customer'
          const s = saveSession({
            openid: d.openid || '',
            bound: !!d.bound,
            phone: d.phone || '',
            name: d.name || '',
            nickname: d.nickname || o.nickname || '',
            avatar: d.avatar || o.avatar || '',
            tier: d.tier || rules.TIER_RETAIL,
            // 角色由服务端下发；员工令牌只在员工账号登录时才有（每次登录轮换）
            role: role,
            staffToken: d.staffToken || '',
            // 这次要看的界面：选了员工且服务端认，就直接进工作台
            view: role === 'staff' && o.role === 'staff' ? 'staff' : 'customer',
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

// 保存微信头像昵称（第 25 轮 / D31）：微信 2022 年起不再允许静默拿头像昵称，
// 只能用官方「头像昵称填写能力」让用户自己选，选完回传服务端存起来，
// 下次在任何设备登录都能带出来。空值＝保留服务端原值。
function saveProfile(opts) {
  const o = opts || {}
  const s = session()
  if (!s || !s.openid) {
    return Promise.reject(new Error('还没登录，先登录再保存头像昵称'))
  }
  const body = { openid: s.openid }
  if (o.nickname) body.nickname = String(o.nickname).trim()
  if (o.avatar) body.avatar = String(o.avatar).trim()
  return request('POST', '/api/wx/profile', body).then((d) => {
    const next = saveSession(Object.assign({}, s, {
      nickname: d.nickname || s.nickname || '',
      avatar: d.avatar || s.avatar || ''
    }))
    return next
  })
}

// ---------- 员工身份与员工界面（第 26 轮 / D32） ----------
// 老板在管理后台给微信号定角色：顾客（customer）或员工（staff）。员工 = 管理后台同权限。
// 「角色」是服务端下发的身份，「界面」（view）只是这台手机上的一个开关：同一个人
// 可以随时切回顾客版买东西，切回来不用重新登录。
function sessionRole() {
  const s = session()
  return s && s.role === 'staff' ? 'staff' : 'customer'
}
function isStaff() {
  return sessionRole() === 'staff'
}
function staffToken() {
  const s = session()
  return s && s.staffToken ? String(s.staffToken) : ''
}
function view() {
  const s = session()
  return s && s.view === 'staff' ? 'staff' : 'customer'
}
function setView(v) {
  const s = session()
  if (!s) return null
  return saveSession(Object.assign({}, s, { view: v === 'staff' ? 'staff' : 'customer' }))
}
function staffHeaders() {
  const t = staffToken()
  return t ? { 'X-Staff-Token': t } : {}
}
// 员工工作台：今日营业额/单数、待处理单、低库存、最近流水（一次取回）
function staffOverview() {
  if (!isStaff()) return Promise.reject(new Error('这个微信号还不是员工'))
  if (!state.online) return Promise.reject(new Error('后端未连接：员工工作台要连上服务端才能用'))
  return request('GET', '/api/staff/overview', undefined, staffHeaders())
}
// 扫码台（**只读**，D8）：扫 69 码 → 是不是本店商品 / 库存多少 / 卖多少钱 / 最近怎么动的。
// 扫码本身绝不动库存，入库出库盘点都要员工再点一下（changeStock）。
function staffScan(code) {
  const c = String(code == null ? '' : code).trim()
  if (!c) return Promise.reject(new Error('条码为空'))
  if (!isStaff()) return Promise.reject(new Error('这个微信号还不是员工'))
  if (!state.online) return Promise.reject(new Error('后端未连接：扫码台要连上服务端才能用'))
  return request('GET', '/api/staff/scan?code=' + encodeURIComponent(c), undefined, staffHeaders())
}
// 员工改库存：入库 stock_in（qty>0）/ 出库 adjust（qty 是增量，为负）/ 盘点 stock_take（qty=实盘数）。
// 服务端在一个事务里改库存 + 写流水，by 记在流水上（D25）。
function changeStock(code, kind, qty, reason, by) {
  const c = String(code == null ? '' : code).trim()
  if (!c) return Promise.reject(new Error('商品条码为空'))
  if (!isStaff()) return Promise.reject(new Error('这个微信号还不是员工'))
  if (!state.online) return Promise.reject(new Error('后端未连接：改库存要连上服务端才能用'))
  return request('POST', '/api/stock/change', {
    code: c,
    kind: String(kind || 'stock_in'),
    qty: num(qty),
    reason: String(reason || '员工小程序操作'),
    by: String(by || displayName() || '员工')
  })
}
// 建档 / 改档案（员工用）。不带 stock 就完全不碰库存（D16），上下架另走 setOnSale（D23）。
function saveProduct(p) {
  const o = p || {}
  const code = String(o.code == null ? '' : o.code).trim()
  if (!code) return Promise.reject(new Error('商品条码不能为空'))
  if (!String(o.name || '').trim()) return Promise.reject(new Error('商品名称不能为空'))
  if (!isStaff()) return Promise.reject(new Error('这个微信号还不是员工'))
  if (!state.online) return Promise.reject(new Error('后端未连接：建档要连上服务端才能用'))
  const body = {
    code: code,
    name: String(o.name).trim(),
    brand: String(o.brand || '').trim(),
    spec: String(o.spec || '').trim(),
    category: String(o.category || '未分类').trim() || '未分类',
    img: String(o.img || ''),
    costPrice: num(o.costPrice),
    salePrice: num(o.salePrice),
    wholesalePrice: num(o.wholesalePrice),
    refPrice: num(o.refPrice),
    unit: String(o.unit || '件').trim() || '件',
    isWholesale: !!o.isWholesale
  }
  // 只有明确传了 stock 才覆盖库存：编辑档案默认不动库存（D16）
  if (o.stock !== undefined && o.stock !== null && o.stock !== '') body.stock = num(o.stock)
  return request('POST', '/api/products', body)
}
// 上下架（D23）：只改状态，绝不改库存
function setOnSale(codes, on) {
  const list = (codes || []).map((c) => String(c).trim()).filter(Boolean)
  if (!list.length) return Promise.reject(new Error('先选商品'))
  if (!isStaff()) return Promise.reject(new Error('这个微信号还不是员工'))
  if (!state.online) return Promise.reject(new Error('后端未连接：上下架要连上服务端才能用'))
  return request('POST', '/api/products/onsale', { codes: list, onSale: !!on })
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
    // 订单行在服务端只存 code/name/price/qty，规格图这些只能按名字回推
    spec: it.spec || '',
    unit: it.unit || '件',
    img: imgUrl(it.img),
    emoji: emojiFor(it.name),
    price: num(it.price),
    qty: num(it.qty),
    amount: Math.round(num(it.price) * num(it.qty) * 100) / 100,
    amountText: (num(it.price) * num(it.qty)).toFixed(2)
  }))
  const status = o.status || 'pending'
  const dt = o.deliveryType === 'delivery' ? 'delivery' : 'pickup'
  const acts = rules.orderActions(status)
  return {
    id: String(o.id || ''),
    customerName: o.customerName || '',
    contact: o.customerName || '',
    phone: o.phone || '',
    address: o.address || '',
    deliveryType: dt,
    deliveryText: dt === 'delivery' ? '送货上门' : '到店自提',
    subtotal: num(o.subtotal),
    subtotalText: num(o.subtotal).toFixed(2),
    deliveryFee: num(o.deliveryFee),
    total: num(o.total),
    totalText: num(o.total).toFixed(2),
    feeText: num(o.deliveryFee).toFixed(2),
    status: status,
    statusText: rules.statusLabel(status),
    actions: acts,
    canCancel: acts.indexOf('cancel') >= 0,
    canAdvance: acts.indexOf('advance') >= 0,
    canReorder: acts.indexOf('reorder') >= 0,
    hint: rules.statusHint({ status: status, deliveryType: dt }),
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

// 订单列表；status 传空 = 全部（第 24 轮订单页状态 tab）
function listOrders(status) {
  const st = String(status || '').trim()
  if (!state.online) {
    const list = localOrders().map(mapOrder)
    return Promise.resolve(st ? list.filter((o) => o.status === st) : list)
  }
  const qs = st ? '?status=' + encodeURIComponent(st) : ''
  return request('GET', '/api/orders' + qs).then((d) => (d.items || []).map(mapOrder))
}

// 推进订单状态（顾客端只用「确认收货」→ done；取消请用 cancelOrder）
function advanceOrder(id, to) {
  if (!state.online) {
    const list = localOrders()
    const hit = list.filter((o) => o.id === id)[0]
    if (!hit) return Promise.reject(new Error('订单不存在'))
    hit.status = to
    saveLocalOrders(list)
    return Promise.resolve(mapOrder(hit))
  }
  return request('POST', '/api/orders/' + encodeURIComponent(id) + '/advance', { to: to }).then(mapOrder)
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
  return advanceOrder(id, 'cancelled')
}

// ---------- 店铺信息（我的页 / 公告）：与 Web 端同一份 /api/settings ----------
const LS_SETTINGS_KEY = 'sdy_mp_settings'
function cachedSettings() {
  const s = sget(LS_SETTINGS_KEY, null)
  return s && typeof s === 'object' ? s : null
}
function getSettings() {
  if (!state.online) {
    return Promise.resolve(cachedSettings() || { name: config.STORE_NAME, phone: '', address: '', footer: '' })
  }
  return request('GET', '/api/settings').then((s) => {
    const v = s && typeof s === 'object' ? s : {}
    sset(LS_SETTINGS_KEY, v)
    return v
  })
}

// ---------- 地址簿（D18；后端早已就绪，小程序第 24 轮才接入） ----------
// 地址按手机号归档，订单里的地址仍是下单当时的快照。
function mapAddress(a) {
  return {
    id: String(a.id || ''),
    contact: a.contact || '',
    address: a.address || '',
    isDefault: !!a.isDefault
  }
}
// 地址簿按手机号存（D18）：phone 参数优先用调用方给的（下单页刚填的那个），
// 没给就用会话里记住的——登录本身不带手机号（D31），所以这两个来源都要认。
function addrPhone(phone) {
  return String(phone == null ? '' : phone).trim() || boundPhone()
}
function listAddresses(phone) {
  const ph = addrPhone(phone)
  if (!ph) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.resolve([])
  return request('GET', '/api/addresses?phone=' + encodeURIComponent(ph)).then((d) => (d.items || []).map(mapAddress))
}
function saveAddress(a, phone) {
  const ph = addrPhone(phone)
  if (!ph) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.reject(new Error('后端未连接：地址簿要连上服务端才能保存'))
  const body = { phone: ph, contact: a.contact, address: a.address, isDefault: !!a.isDefault }
  if (a.id) body.id = Number(a.id)
  return request('POST', '/api/addresses', body).then(mapAddress)
}
function deleteAddress(id, phone) {
  const ph = addrPhone(phone)
  if (!ph) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.reject(new Error('后端未连接：地址簿要连上服务端才能改'))
  return request('DELETE', '/api/addresses/' + encodeURIComponent(id) + '?phone=' + encodeURIComponent(ph))
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
  listAllProducts: listAllProducts,
  getProduct: getProduct,
  listCategories: listCategories,
  resolveBarcode: resolveBarcode,
  wxLogin: wxLogin,
  saveProfile: saveProfile,
  rememberPhone: rememberPhone,
  session: session,
  saveSession: saveSession,
  clearSession: clearSession,
  isLoggedIn: isLoggedIn,
  // 员工身份（第 26 轮 / D32）
  sessionRole: sessionRole,
  isStaff: isStaff,
  staffToken: staffToken,
  staffHeaders: staffHeaders,
  view: view,
  setView: setView,
  staffOverview: staffOverview,
  staffScan: staffScan,
  changeStock: changeStock,
  saveProduct: saveProduct,
  setOnSale: setOnSale,
  boundPhone: boundPhone,
  displayName: displayName,
  sessionLabel: sessionLabel,
  createOrder: createOrder,
  listOrders: listOrders,
  getOrder: getOrder,
  cancelOrder: cancelOrder,
  advanceOrder: advanceOrder,
  getSettings: getSettings,
  cachedSettings: cachedSettings,
  listAddresses: listAddresses,
  saveAddress: saveAddress,
  deleteAddress: deleteAddress,
  clearCache: clearCache,
  emojiFor: emojiFor,
  imgUrl: imgUrl,
  _state: state,
  _mapProduct: mapProduct,
  _mapOrder: mapOrder,
  _mapAddress: mapAddress,
  _local: { products: LOCAL_PRODUCTS }
}

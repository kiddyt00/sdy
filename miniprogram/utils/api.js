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
  cloudFails: 0,
  // 第 31 轮（payEnabled）：微信支付是否开通，来自 GET /api/settings 的派生字段。
  // 默认 false = 未开通：拿不到配置（请求失败 / 字段缺失 / 不是布尔）一律按未开通算 ——
  // 与 Web mall.js 的 payOn 同一口径：宁可少催一次款，也不能把付不了款的单挂成「待付款」。
  payEnabled: false
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
        // 第 29 轮：页面要按 HTTP 码分岔（支付未配置是 503），错误对象上必须带得住状态码，
        // 只靠 message 文本去猜太脆。
        const err = new Error(msg)
        err.statusCode = (res && res.statusCode) || 0
        err.body = d
        reject(err)
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
      // 连不上后端 = 拿不到 payEnabled：按未开通算（契约：取不到配置一律按未开通）。
      // 未开通时 pending 退回第 28 轮「待备货」，不会凭空冒出一个没人能付的「待付款」。
      state.payEnabled = false
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

/* ---------- 第 28 轮：商品排序 / 分页（契约 7.2） ---------- */
// 排序取值与 Web / 后台逐字相同；未知值交给服务端 400，客户端不自己发明值。
const SORTS = ['default', 'hot', 'price_asc', 'price_desc', 'stock_desc']
const PAGE_LIMIT_MAX = 200

// 离线演示也照契约排一遍：价格/库存用本地有效价，销量本地没有就保持原顺序。
function sortLocal(list, sort) {
  const arr = (list || []).slice()
  const byName = (a, b) => String(a.name || '').localeCompare(String(b.name || ''))
  if (sort === 'price_asc') arr.sort((a, b) => (num(a.price) - num(b.price)) || byName(a, b))
  else if (sort === 'price_desc') arr.sort((a, b) => (num(b.price) - num(a.price)) || byName(a, b))
  else if (sort === 'stock_desc') arr.sort((a, b) => (num(b.stock) - num(a.stock)) || byName(a, b))
  else if (sort === 'hot') arr.sort((a, b) => (num(b.sold) - num(a.sold)) || byName(a, b))
  return arr
}
function slicePage(list, limit, offset) {
  const lim = num(limit) > 0 ? Math.min(num(limit), PAGE_LIMIT_MAX) : 0 // 0 = 不限，与服务端默认一致
  const off = num(offset) > 0 ? num(offset) : 0
  const items = lim > 0 ? list.slice(off, off + lim) : list.slice(off)
  return { items: items, limit: lim, offset: off }
}

// 商品列表；在线时顺便把服务端商品缓存到本地（断网也能看）
// 顾客端只看上架商品（onSale=1，D23）；已登录就带 phone，让服务端按等级给价（D24）。
// category 传空 / '全部' 就是不筛分类（第 24 轮分类页用）。
//
// 第 28 轮扩参：listProducts(keyword, category, opts)，opts = {sort, limit, offset, onSale}。
// **向后兼容**：只传 2 个参数（不传 opts）时行为与返回值与第 27 轮完全一致（返回商品数组）；
// 传了 opts 才走分页契约，返回 {items,total,limit,offset,hasMore,tier}。
function listProducts(keyword, category, opts) {
  const o = opts || null
  const paged = !!o
  const cat = String(category || '').trim()
  const useCat = cat && cat !== '全部'
  const sort = o && o.sort ? String(o.sort) : 'default'
  // onSale 缺省仍是 1（老行为）；只有显式传 0/false/'0' 才放开设限
  const onSale = o && (o.onSale === 0 || o.onSale === false || o.onSale === '0') ? '0' : '1'
  if (!state.online) {
    let list = localProducts(keyword)
    if (useCat) list = list.filter((p) => (p.category || '未分类') === cat)
    list = sortLocal(list, sort)
    if (!paged) return Promise.resolve(list)
    const pg = slicePage(list, o.limit, o.offset)
    return Promise.resolve({
      items: pg.items,
      total: list.length,
      limit: pg.limit,
      offset: pg.offset,
      hasMore: pg.offset + pg.items.length < list.length,
      tier: ''
    })
  }
  const qs = ['onSale=' + onSale]
  if (keyword) qs.push('keyword=' + encodeURIComponent(keyword))
  if (useCat) qs.push('category=' + encodeURIComponent(cat))
  if (paged) {
    // sort/limit/offset 原样透传（服务端不认识的值会 400，客户端不替它兜底）
    if (o.sort !== undefined && o.sort !== null && o.sort !== '') qs.push('sort=' + String(o.sort))
    if (o.limit !== undefined && o.limit !== null && o.limit !== '') qs.push('limit=' + String(o.limit))
    if (o.offset !== undefined && o.offset !== null && o.offset !== '') qs.push('offset=' + String(o.offset))
  }
  const ph = boundPhone()
  if (ph) qs.push('phone=' + encodeURIComponent(ph))
  return request('GET', '/api/products?' + qs.join('&')).then((d) => {
    const items = (d.items || []).map(mapProduct)
    if (!keyword && !useCat) sset(LS_PRODUCTS_KEY, items)
    if (!paged) return items
    const lim = d.limit !== undefined ? num(d.limit) : num(o.limit)
    const off = d.offset !== undefined ? num(d.offset) : num(o.offset)
    const total = d.total !== undefined ? num(d.total) : items.length
    return {
      items: items,
      total: total,
      limit: lim,
      offset: off,
      // 服务端给了就用服务端的；老后端没这字段时按本页条数推断，至少不会无限翻
      hasMore: d.hasMore !== undefined ? !!d.hasMore : (off + items.length < total),
      tier: d.tier || ''
    }
  })
}

// 热销（契约 7.3）：口径同 sort=hot，只回上架；limit 默认 8、最大 20。
// 离线演示照旧降级到本地商品；在线时请求失败按第 27 轮口径 reject（绝不吞成空数组）。
function hotProducts(limit) {
  const lim = num(limit) > 0 ? Math.min(num(limit), 20) : 8
  if (!state.online) {
    const all = localProducts('')
    const items = all.slice(0, lim)
    return Promise.resolve({ items: items, total: items.length })
  }
  const qs = ['limit=' + lim]
  const ph = boundPhone()
  if (ph) qs.push('phone=' + encodeURIComponent(ph))
  return request('GET', '/api/products/hot?' + qs.join('&')).then((d) => ({
    items: (d.items || []).map(mapProduct),
    total: d.total !== undefined ? num(d.total) : (d.items || []).length
  }))
}

// 同类推荐（契约 7.4）：缺货商品的替代品，on_sale=1 / stock>0 / 排除自身；
// 服务端优先同分类再全店补足。code 缺失或商品不存在时服务端回空列表（不 400），页面安静降级。
function alternatives(code, limit) {
  const c = String(code == null ? '' : code).trim()
  const lim = num(limit) > 0 ? Math.min(num(limit), 20) : 5
  if (!state.online) {
    const all = localProducts('')
    const self = all.filter((p) => p.code === c)[0]
    const pool = all.filter((p) => p.code !== c && p.stock > 0)
    const same = self ? pool.filter((p) => (p.category || '未分类') === (self.category || '未分类')) : []
    const rest = pool.filter((p) => same.indexOf(p) < 0)
    const items = same.concat(rest).slice(0, lim)
    return Promise.resolve({ items: items, total: items.length })
  }
  const qs = ['code=' + encodeURIComponent(c), 'limit=' + lim]
  const ph = boundPhone()
  if (ph) qs.push('phone=' + encodeURIComponent(ph))
  return request('GET', '/api/products/alternatives?' + qs.join('&')).then((d) => ({
    items: (d.items || []).map(mapProduct),
    total: d.total !== undefined ? num(d.total) : (d.items || []).length
  }))
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

/* ---------- 请求身份（第 27 轮契约：员工令牌 > openid > phone > 无身份 400） ---------- */
// 小程序有 openid 就优先带 openid（服务端按档案认人，甩不掉换号）；否则退回下单时填的手机号。
// 员工令牌由 staffHeaders() 单独带，优先级最高。
const NO_IDENTITY = '缺少身份：顾客请先登录或填收货手机号'
function identityParams() {
  const s = session() || {}
  let qs = ''
  const header = {}
  if (s.openid) {
    qs = 'openid=' + encodeURIComponent(s.openid)
    header['X-Wx-Openid'] = String(s.openid)
  } else if (s.phone) {
    qs = 'phone=' + encodeURIComponent(s.phone)
  }
  return { qs: qs, header: header }
}
// 合并身份头 + 员工令牌（顾客身份与员工令牌可以同时存在）
function authHeader() {
  const id = identityParams()
  const h = staffHeaders()
  const out = {}
  Object.keys(id.header).forEach((k) => { out[k] = id.header[k] })
  Object.keys(h).forEach((k) => { out[k] = h[k] })
  return out
}

// 地址簿能力钥匙（第 27 轮契约）：首次保存地址时服务端下发 32 位 key，
// 之后读写都要带上；本地还没拿到 key 时，空列表是「还没存过地址」而不是错误。
const LS_ADDR_KEY = 'sdy_mp_addr_key'
function addrKey() {
  const k = sget(LS_ADDR_KEY, '')
  return k ? String(k) : ''
}
function saveAddrKey(k) {
  if (k) sset(LS_ADDR_KEY, String(k))
  return addrKey()
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
  // 第 29 轮：paid 是 status 之外的第二个维度（不新增 status 值）。
  // 老后端 / 离线本地单压根没有 paid 字段 —— 记成 paidKnown:false，交给 rules 按
  // 第 27 轮口径当「已付款」，否则历史订单会被集体误判成「待付款」。
  // 注意：本地订单是「映射后的对象」存盘、读出来还会再映射一次，所以输入里已经带了
  // paidKnown 就认它，不能把「没下发过」二次解读成「明确未付款」。
  const paidKnown = o.paidKnown !== undefined ? !!o.paidKnown : (o.paid !== undefined && o.paid !== null && o.paid !== '')
  const paid = paidKnown && (o.paid === true || o.paid === 1 || o.paid === '1' || o.paid === 'true')
  const payExpireAt = num(o.payExpireAt)
  const payView = {
    status: status,
    deliveryType: dt,
    paid: paidKnown ? paid : undefined,
    paidKnown: paidKnown,
    payExpireAt: payExpireAt,
    // 第 31 轮（payEnabled）：订单对象里带上「支付开没开通」，rules.orderLabel/orderActions
    // 据此决定 pending 是「待付款」还是「待备货」。本地单存的是映射后对象，已经带了就认它
    // （和 paidKnown 同一个幂等套路），否则取内存缓存里的（取不到 = 未开通）。
    payEnabled: (o.payEnabled !== undefined ? o.payEnabled === true : payEnabled())
  }
  const acts = rules.orderActions(payView)
  // 退款提示：只认「已取消 + refundState」，认不出来的状态一律空串（页面对空串不渲染）
  const refundView = { status: status, refundState: o.refundState, refundId: o.refundId }
  const refundText = rules.refundText(refundView)
  const refundTone = refundText ? rules.refundTone(refundView) : ''
  const refundNo = refundText ? rules.refundNo(refundView) : ''
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
    statusText: rules.orderLabel(payView),
    actions: acts,
    canCancel: acts.indexOf('cancel') >= 0,
    canAdvance: acts.indexOf('advance') >= 0,
    canReorder: acts.indexOf('reorder') >= 0,
    canPay: acts.indexOf('pay') >= 0,
    // ---- 第 29 轮支付态（paid 统一成布尔；没下发过就 false 但 paidKnown:false 兜着）----
    paid: paid,
    paidKnown: paidKnown,
    // 第 31 轮：这一单所在店铺的在线支付开没开通（页面据此决定显不显示收银台入口）
    payEnabled: payView.payEnabled,
    paidAt: o.paidAt || '',
    paidText: paid ? '已微信支付' : '',
    transactionId: o.transactionId || '',
    payExpireAt: payExpireAt,
    payExpired: rules.payExpired(payView),
    payLeftText: rules.payLeftText(payView),
    payHint: rules.payHint(payView),
    // ---- 第 29 轮退款态：形状与文案都取自 rules（唯一真源），页面不许自己判 refundState ----
    refundId: o.refundId || '',
    refundState: o.refundState || '',
    refundText: refundText,
    refundTone: refundTone,
    refundNo: refundNo,
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
  // 第 27 轮契约：带上身份（openid/phone）与 clientToken，弱网重试不会重复下单、不会重复扣库存
  const id = identityParams()
  if (!id.qs) return Promise.reject(new Error(NO_IDENTITY))
  body.clientToken = 'C' + Date.now() + Math.floor(Math.random() * 1000)
  return request('POST', '/api/orders' + (id.qs ? '?' + id.qs : ''), body, authHeader()).then((d) => ({ order: mapOrder(d), local: false, duplicated: !!(d && d.duplicated) }))
}

// 订单列表；status 传空 = 全部（第 24 轮订单页状态 tab）
// 第 27 轮契约：服务端按身份过滤（员工令牌 > openid > phone > 无身份 400），
// 所以顾客侧每次都要把身份带上，否则要么 400、要么看不见自己的单。
function listOrders(status) {
  const st = String(status || '').trim()
  if (!state.online) {
    const list = localOrders().map(mapOrder)
    return Promise.resolve(st ? list.filter((o) => o.status === st) : list)
  }
  const id = identityParams()
  if (!id.qs) return Promise.reject(new Error(NO_IDENTITY))
  const qs = '?' + id.qs + (st ? '&status=' + encodeURIComponent(st) : '')
  return request('GET', '/api/orders' + qs, null, authHeader()).then((d) => (d.items || []).map(mapOrder))
}

// 推进订单状态：员工可以推任何目标值；顾客只能把自己的单推进到 done（「确认收货」）
// 第 27 轮契约：advance 对非员工收紧；但顾客收货不能因此消失（服务端放行「归属人 + done」）
function advanceOrder(id, to) {
  if (!state.online) {
    const list = localOrders()
    const hit = list.filter((o) => o.id === id)[0]
    if (!hit) return Promise.reject(new Error('订单不存在'))
    hit.status = to
    saveLocalOrders(list)
    return Promise.resolve(mapOrder(hit))
  }
  if (staffToken()) {
    return request('POST', '/api/orders/' + encodeURIComponent(id) + '/advance', { to: to }, staffHeaders()).then(mapOrder)
  }
  if (to !== 'done') return Promise.reject(new Error('只有店主可以推进订单状态'))
  const ident = identityParams()
  if (!ident.qs) return Promise.reject(new Error(NO_IDENTITY))
  return request('POST', '/api/orders/' + encodeURIComponent(id) + '/advance?' + ident.qs, { to: to }, authHeader()).then(mapOrder)
}

function getOrder(id) {
  if (!state.online) {
    const hit = localOrders().filter((o) => o.id === id)[0]
    return hit ? Promise.resolve(mapOrder(hit)) : Promise.reject(new Error('订单不存在'))
  }
  const ident = identityParams()
  if (!ident.qs) return Promise.reject(new Error(NO_IDENTITY))
  return request('GET', '/api/orders/' + encodeURIComponent(id) + '?' + ident.qs, null, authHeader()).then(mapOrder)
}

// 顾客端只能取消自己的待处理订单（其余状态由店里在管理端推进）
// 第 27 轮契约：取消是顾客自己的动作，走 POST /api/orders/{id}/cancel（advance 已收紧为员工专属）
function cancelOrder(id) {
  if (!state.online) {
    const list = localOrders()
    const hit = list.filter((o) => o.id === id)[0]
    if (!hit) return Promise.reject(new Error('订单不存在'))
    hit.status = 'cancelled'
    saveLocalOrders(list)
    return Promise.resolve(mapOrder(hit))
  }
  const ident = identityParams()
  if (!ident.qs) return Promise.reject(new Error(NO_IDENTITY))
  return request('POST', '/api/orders/' + encodeURIComponent(id) + '/cancel?' + ident.qs, { to: 'cancelled' }, authHeader())
    .then((d) => (d && d.id ? mapOrder(d) : mapOrder(Object.assign({}, d, { status: 'cancelled' }))))
}

// ---------- 微信支付（第 29 轮 / 0.9.0，顾客侧收银台） ----------
// 契约（docs/支付与配送-方案与验收.md §1.5，服务端口径已冻结）：
//   POST /api/pay/prepay  {orderId} → {outTradeNo, amountFen, payParams{...}, expireAt}
//                         未配置支付 → 503 {error:'微信支付未配置…'}
//   GET  /api/pay/status?orderId=M… → {paid, status, transactionId, refundState, expireAt}
// 两个接口都带顾客身份（第 27 轮口径：openid 优先，否则手机号）；归属校验在服务端（403/404）。
// 金额一律是服务端下发的**整数分**，前端只做展示换算，绝不自己算钱。
const NO_PAY_CONFIG = '店里还没开通在线支付，请联系店家'

// 未配置支付：给错误对象打上可识别标记，页面据此显示人话而不是「HTTP 503」
function noPayConfigError(e) {
  const err = new Error((e && e.message) || NO_PAY_CONFIG)
  err.noPayConfig = true
  err.statusCode = 503
  return err
}

// 下单成功后去收银台：拿 wx.requestPayment 需要的那一包参数
function prepay(orderId) {
  const id = String(orderId || '').trim()
  if (!id) return Promise.reject(new Error('缺少订单号'))
  const ident = identityParams()
  if (!ident.qs) return Promise.reject(new Error(NO_IDENTITY))
  return request('POST', '/api/pay/prepay?' + ident.qs, { orderId: id }, authHeader()).then((d) => {
    const fen = num(d && d.amountFen)
    return {
      outTradeNo: String((d && d.outTradeNo) || id),
      amountFen: fen,
      amountText: rules.fenText(fen),
      payParams: (d && d.payParams) || {},
      expireAt: num(d && d.expireAt)
    }
  }, (e) => {
    if (e && e.statusCode === 503) throw noPayConfigError(e)
    throw e
  })
}

// 查支付态：收银台每次进入先问一次，已经付过就不再拉起收银台
function payStatus(orderId) {
  const id = String(orderId || '').trim()
  if (!id) return Promise.reject(new Error('缺少订单号'))
  const ident = identityParams()
  if (!ident.qs) return Promise.reject(new Error(NO_IDENTITY))
  return request('GET', '/api/pay/status?orderId=' + encodeURIComponent(id) + '&' + ident.qs, null, authHeader()).then((d) => {
    const v = d || {}
    return {
      paid: v.paid === true || v.paid === 1 || v.paid === '1' || v.paid === 'true',
      status: String(v.status || ''),
      transactionId: String(v.transactionId || ''),
      refundState: String(v.refundState || ''),
      expireAt: num(v.expireAt)
    }
  })
}

// 拉起微信收银台。fail 的 errMsg 必须翻译成人话：
// 「requestPayment:fail cancel」→「你取消了支付」，其它原文透出（便于对账时看到真实原因）。
function requestPayment(payParams) {
  return new Promise((resolve, reject) => {
    if (typeof wx === 'undefined' || !wx || typeof wx.requestPayment !== 'function') {
      reject(new Error('当前环境不支持微信支付'))
      return
    }
    const p = payParams || {}
    wx.requestPayment({
      timeStamp: String(p.timeStamp || ''),
      nonceStr: String(p.nonceStr || ''),
      package: String(p.package || ''),
      signType: p.signType || 'RSA',
      paySign: String(p.paySign || ''),
      success: () => resolve({ ok: true }),
      fail: (err) => {
        const raw = String((err && (err.errMsg || err.msg)) || '').trim()
        const cancelled = /cancel/i.test(raw)
        const e = new Error(cancelled ? '你取消了支付' : (raw || '支付失败'))
        e.cancelled = cancelled
        e.errMsg = raw
        reject(e)
      }
    })
  })
}

// ---------- 店铺信息（我的页 / 公告）：与 Web 端同一份 /api/settings ----------
const LS_SETTINGS_KEY = 'sdy_mp_settings'
const LOW_STOCK_FALLBACK = 5 // 接口没给时的兜底；页面不再各写一份硬编码 5
function cachedSettings() {
  const s = sget(LS_SETTINGS_KEY, null)
  return s && typeof s === 'object' ? s : null
}
// 低库存阈值（第 27 轮契约：来自 GET /api/settings 的 lowStock，缺省 5）
function lowStock() {
  const s = cachedSettings() || {}
  const n = Number(s.lowStock)
  return isFinite(n) && n > 0 ? n : LOW_STOCK_FALLBACK
}
// 第 31 轮（payEnabled）：把 /api/settings 的派生字段收进内存缓存（订单映射要用它）。
// **只有显式 true 才算开通**（服务端下发的是 JSON bool，别做 'true'/1 那种自作聪明的兼容）；
// 字段缺失 / 不是布尔 → 未开通。
function applySettings(s) {
  const v = (s && typeof s === 'object') ? s : null
  if (v) sset(LS_SETTINGS_KEY, v)
  state.payEnabled = !!(v && v.payEnabled === true)
  return state.payEnabled
}
// 在线支付是否已开通（页面/WXML 都读这一个入口；rules 侧读订单对象上的 payEnabled）
function payEnabled() {
  return state.payEnabled === true
}
function getSettings() {
  if (!state.online) {
    // 离线演示：连不上后端就付不了款 —— payEnabled 不从这里复活（probe 失败时已归零），
    // 其余配置照旧用缓存，DEMO 行为与第 28 轮一致。
    return Promise.resolve(cachedSettings() || { name: config.STORE_NAME, phone: '', address: '', footer: '' })
  }
  // 每次问配置都先退回「未开通」，只有服务端这次明确说 true 才算开通 ——
  // 「取不到配置一律按未开通」这条口径就落在这一行上。
  state.payEnabled = false
  return request('GET', '/api/settings').then((s) => {
    const v = s && typeof s === 'object' ? s : {}
    applySettings(v)
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
// 拿地址簿身份：手机号 + 能力钥匙（key）。登录过就用 openid 打头，服务端按档案认人。
function addrAuth(phone) {
  const ph = addrPhone(phone)
  if (!ph) return null
  const out = ['phone=' + encodeURIComponent(ph)]
  const k = addrKey()
  if (k) out.push('key=' + encodeURIComponent(k))
  const header = authHeader()
  return { ph: ph, qs: out.join('&'), header: header }
}
function listAddresses(phone) {
  const a = addrAuth(phone)
  if (!a) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.resolve([])
  // 契约：本地还没拿到 key、或者 key 对不上时，服务端返回空列表（不是错误）。
  // 页面据此显示「还没有存过地址」，不要把空列表当加载失败。
  return request('GET', '/api/addresses?' + a.qs, null, a.header).then((d) => (d.items || []).map(mapAddress))
}
function saveAddress(a, phone) {
  const auth = addrAuth(phone)
  if (!auth) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.reject(new Error('后端未连接：地址簿要连上服务端才能保存'))
  const body = { phone: auth.ph, contact: a.contact, address: a.address, isDefault: !!a.isDefault }
  if (a.id) body.id = Number(a.id)
  const k = addrKey()
  if (k) body.key = k
  return request('POST', '/api/addresses', body, auth.header).then((d) => {
    // 首次保存时服务端下发 key，必须落本地并在此后的读写里带上
    if (d && d.key) saveAddrKey(d.key)
    return mapAddress(d)
  })
}
function deleteAddress(id, phone) {
  const a = addrAuth(phone)
  if (!a) return Promise.reject(new Error('先填收货手机号，才能用地址簿'))
  if (!state.online) return Promise.reject(new Error('后端未连接：地址簿要连上服务端才能改'))
  return request('DELETE', '/api/addresses/' + encodeURIComponent(id) + '?' + a.qs, null, a.header)
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
  // 第 28 轮新增：**必须导出**（R27 踩过「定义了没导出」的坑）
  hotProducts: hotProducts,
  alternatives: alternatives,
  SORTS: SORTS,
  PAGE_LIMIT_MAX: PAGE_LIMIT_MAX,
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
  // 请求身份 + 地址簿钥匙（第 27 轮契约）
  identityParams: identityParams,
  authHeader: authHeader,
  addrKey: addrKey,
  saveAddrKey: saveAddrKey,
  NO_IDENTITY: NO_IDENTITY,
  createOrder: createOrder,
  listOrders: listOrders,
  getOrder: getOrder,
  cancelOrder: cancelOrder,
  advanceOrder: advanceOrder,
  // 微信支付收银台（第 29 轮 / 0.9.0）
  prepay: prepay,
  payStatus: payStatus,
  requestPayment: requestPayment,
  NO_PAY_CONFIG: NO_PAY_CONFIG,
  getSettings: getSettings,
  cachedSettings: cachedSettings,
  payEnabled: payEnabled,
  applySettings: applySettings,
  lowStock: lowStock,
  LOW_STOCK_FALLBACK: LOW_STOCK_FALLBACK,
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

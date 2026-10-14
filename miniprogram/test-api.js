/* =====================================================================
 * 小程序后端通道（utils/api.js + utils/store.js + utils/rules.js）测试
 *   假 wx（storage + request），覆盖：离线降级 / 在线读写 / 下单 body /
 *   订单映射 / 配送费规则 / 购物车合并 / 后端地址优先级 / 运行配置 / 扫码找货
 * 运行：node miniprogram/test-api.js
 * ===================================================================== */
'use strict'

let passed = 0, failed = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg) }
  else { failed++; console.log('  ✘ ' + msg) }
}
function section(t) { console.log('\n■ ' + t) }

/* ---------------- 假 wx ---------------- */
function mkWx(routes) {
  const kv = {}
  const calls = []
  const wx = {
    _kv: kv,
    _calls: calls,
    _loginCode: 'CODE_MOCK',
    _loginFail: '',
    getStorageSync: (k) => (k in kv ? kv[k] : ''),
    setStorageSync: (k, v) => { kv[k] = v },
    removeStorageSync: (k) => { delete kv[k] },
    showToast: () => {},
    switchTab: () => {},
    // 假 wx.login：默认给一个 code，可用 _loginCode / _loginFail 改行为
    login(opts) {
      const o = opts || {}
      calls.push({ method: 'LOGIN', path: 'wx.login', data: null })
      if (wx._loginFail) { if (o.fail) o.fail({ errMsg: wx._loginFail }); return }
      if (o.success) o.success({ code: wx._loginCode })
    },
    request(opts) {
      const method = (opts.method || 'GET').toUpperCase()
      const full = String(opts.url).replace(/^https?:\/\/[^/]+/, '')
      const path = full.split('?')[0]
      calls.push({ method: method, path: full, url: opts.url, data: opts.data, header: opts.header })
      for (const r of routes) {
        if (r.method === method && (r.path === path || r.path === full || (r.re && r.re.test(path)))) {
          if (r.fail) { opts.fail({ errMsg: r.fail }); return }
          const status = r.status || 200
          const payload = typeof r.body === 'function' ? r.body({ method: method, path: path, data: opts.data }) : r.body
          opts.success({ statusCode: status, data: payload === undefined ? {} : payload })
          return
        }
      }
      opts.success({ statusCode: 404, data: { error: '无此路由: ' + path } })
    }
  }
  return wx
}

const SERVER_PRODUCTS = [
  { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', unit: '罐', salePrice: 2.5, stock: 120, syncStatus: 'synced' },
  { code: '6907992751797', name: '伊利纯牛奶', brand: '伊利', spec: '250ml 盒', category: '乳品', unit: '盒', salePrice: 3.5, stock: 80, syncStatus: 'pending' }
]
const SERVER_ORDER = {
  id: 'M1770000000000000001', customerName: '张三', phone: '13800138000', address: '',
  deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending',
  items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }],
  createdAt: '2026-10-11T02:30:00Z'
}
const ROUTES = [
  { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: false, circuitOpen: false, cloudFails: 0 } },
  { method: 'GET', path: '/api/products', body: { items: SERVER_PRODUCTS, total: 2 } },
  { method: 'POST', path: '/api/orders', status: 201, body: SERVER_ORDER },
  { method: 'GET', path: '/api/orders', body: { items: [SERVER_ORDER], total: 1 } },
  { method: 'GET', re: /^\/api\/orders\/[^/]+$/, body: SERVER_ORDER },
  { method: 'POST', re: /^\/api\/orders\/[^/]+\/advance$/, body: Object.assign({}, SERVER_ORDER, { status: 'done' }) },
  { method: 'POST', re: /^\/api\/orders\/[^/]+\/cancel$/, body: Object.assign({}, SERVER_ORDER, { status: 'cancelled' }) }
]

/* ---------------- 启动：先装 wx 再 require ---------------- */
const wxOffline = mkWx([{ method: 'GET', path: '/healthz', fail: 'request:fail timeout' }])
global.wx = wxOffline
const api = require('./utils/api.js')
const store = require('./utils/store.js')
const rules = require('./utils/rules.js')

async function main() {
  /* ---------- ① 离线降级 ---------- */
  section('① 后端连不上 → 本地演示（页面照样可点）')
  let st = await api.probe()
  ok(st.online === false, 'probe 失败后 online=false')
  ok(st.mode === 'local', 'mode=local')
  ok(st.label.indexOf('本地演示') >= 0, 'label=' + st.label)
  ok(st.error.indexOf('无法连接后端') >= 0, '错误文案含「无法连接后端」：' + st.error)
  let list = await api.listProducts()
  ok(list.length === 6, '降级后返回演示商品 6 条')
  ok(list[0].server !== true, '降级商品不带 server 标记')
  ok(api.emojiFor('可口可乐') === '🥤' && api.emojiFor('青岛啤酒') === '🍺', 'emoji 按名称猜：可乐 🥤 / 啤酒 🍺')
  ok(list[1].priceText === '1.80', '价格格式化成两位小数：' + list[1].priceText)

  /* ---------- ② 在线：探测 + 商品映射 ---------- */
  section('② 后端已连接 → 读写都走后端')
  global.wx = mkWx(ROUTES)
  st = await api.probe()
  ok(st.online === true, 'probe 成功后 online=true')
  ok(st.label === '🟢 后端已连接', 'label=' + st.label)
  ok(st.detail.indexOf('以服务端为准') >= 0, '在线 detail 说明以服务端为准：' + st.detail)
  ok(st.cloudConfigured === false, '透出 cloudConfigured=false')

  list = await api.listProducts()
  ok(list.length === 2, '在线商品 2 条（来自后端）')
  ok(list[0].server === true, '映射后带 server:true')
  ok(list[0].stock === 120 && list[0].salePrice === 2.5, '价格/库存取服务端值')
  ok(list[0].emoji === '🥤', '映射补 emoji')
  ok(global.wx._kv['sdy_mp_products'] && global.wx._kv['sdy_mp_products'].length === 2, '在线商品已缓存到本地（断网可看）')

  list = await api.listProducts('牛奶')
  ok(list.length === 2, '带关键词时仍返回后端结果（关键词由后端过滤）')
  const lastCall = global.wx._calls[global.wx._calls.length - 1]
  ok(lastCall.path.indexOf('keyword=') > 0, '关键词透传给后端：' + lastCall.path)

  /* ---------- ③ 下单：在线 / 离线 ---------- */
  section('③ 下单')
  // 第 27 轮：订单读写都要带身份（员工令牌 > openid > phone），这里模拟「下单时填过手机号」
  api.rememberPhone('13800138000')
  store.addToCart({ code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', unit: '罐', emoji: '🥤', salePrice: 2.5 }, 2)
  ok(store.cartCount() === 2 && store.cartAmount() === 5, '购物车 2 件 / 合计 5 元')
  store.addToCart({ code: '6901234567892', salePrice: 2.5, name: '可口可乐' }, 1)
  ok(store.cartCount() === 3 && store.getCart().length === 1, '同条码合并而不是新增一行')

  let r = await api.createOrder({
    customerName: '张三', phone: '13800138000', address: '',
    deliveryType: 'pickup', items: store.orderItems()
  })
  ok(r.local === false, '在线下单 local=false')
  ok(r.order.statusText === '待备货', '状态文案：待备货（第 27 轮与 Web 归一）')
  ok(r.order.deliveryText === '到店自提', '配送方式文案：到店自提')
  ok(r.order.totalText === '5.00' && r.order.feeText === '0.00', '总额/配送费格式化为两位小数')
  ok(r.order.summary === '可口可乐×2', '订单摘要按服务端回单生成：' + r.order.summary)
  ok(r.order.createdText.indexOf('2026-10-11') === 0, '创建时间本地化：' + r.order.createdText)
  const post = global.wx._calls.filter((c) => c.method === 'POST' && c.path.split('?')[0] === '/api/orders')[0]
  ok(!!post, '确实发出 POST /api/orders')
  ok(post.path.indexOf('phone=13800138000') > 0, '第 27 轮：下单请求带身份（phone）：' + post.path)
  ok(post.data.deliveryType === 'pickup' && post.data.address === '', 'body：自提不带地址')
  ok(post.data.items.length === 1 && post.data.items[0].code === '6901234567892' && post.data.items[0].qty === 3, 'body：只传 code+qty（价格由服务端算）')
  ok(post.data.customerName === '张三' && post.data.phone === '13800138000', 'body：收货人信息')
  ok(typeof post.data.clientToken === 'string' && post.data.clientToken.length > 1, 'body：带 clientToken（弱网重试不重复下单）：' + post.data.clientToken)

  const olist = await api.listOrders()
  ok(olist.length === 1 && olist[0].id === SERVER_ORDER.id, '订单列表来自后端')
  const listCall = global.wx._calls.filter((c) => c.method === 'GET' && c.path.split('?')[0] === '/api/orders')[0]
  ok(!!listCall && listCall.path.indexOf('phone=13800138000') > 0, '订单列表也带身份（服务端据此过滤）：' + (listCall && listCall.path))
  let got = await api.getOrder(SERVER_ORDER.id)
  ok(got.total === 5, '订单详情按 id 查询')
  let cancelled = await api.cancelOrder(SERVER_ORDER.id)
  ok(cancelled.statusText === '已取消', '取消后状态文案：已取消')
  const cancelCall = global.wx._calls.filter((c) => c.method === 'POST' && c.path.split('?')[0] === '/api/orders/' + SERVER_ORDER.id + '/cancel')[0]
  ok(!!cancelCall && cancelCall.path.indexOf('phone=') > 0, '顾客取消走 /cancel 且带身份：' + (cancelCall && cancelCall.path))
  // 顾客「确认收货」只能推进到 done；派单/备货的目标值本地就拦住（第 27 轮 advance 收紧）
  const adv = await api.advanceOrder(SERVER_ORDER.id, 'done')
  ok(adv.status === 'done', '归属人可确认收货（advance → done）')
  let advErr = ''
  try { await api.advanceOrder(SERVER_ORDER.id, 'delivering') } catch (e) { advErr = e.message }
  ok(advErr.indexOf('只有店主') >= 0, '非员工不能推进到 delivering：' + advErr)
  // 无身份时不下单、不发请求
  const savedSession = api.session()
  api.clearSession()
  let noIdErr = ''
  try {
    await api.createOrder({ customerName: '王五', phone: '13700137000', address: '', deliveryType: 'pickup', items: store.orderItems() })
  } catch (e) { noIdErr = e.message }
  ok(noIdErr.indexOf('缺少身份') >= 0, '无身份下单本地就拦住（不发请求）：' + noIdErr)
  api.saveSession(savedSession)

  // 离线下单：只落本地，不冒充成功
  global.wx = mkWx([{ method: 'GET', path: '/healthz', fail: 'request:fail' }])
  await api.probe()
  r = await api.createOrder({
    customerName: '李四', phone: '13900139000', address: '3 栋 502',
    deliveryType: 'delivery', items: store.orderItems()
  })
  ok(r.local === true, '离线下单 local=true（提醒顾客未入库）')
  ok(r.order.id.charAt(0) === 'L', '离线订单号以 L 开头：' + r.order.id)
  ok(r.order.deliveryFee === 3 && r.order.total === rules.round2(r.order.subtotal + 3),
    '离线也按规则算配送费：小计 ' + r.order.subtotal + ' + 配送 3 = ' + r.order.total)
  const localList = await api.listOrders()
  ok(localList.length === 1 && localList[0].customerName === '李四', '离线订单存在本地，重启仍在')
  const off2 = await api.cancelOrder(r.order.id)
  ok(off2.status === 'cancelled', '离线可取消自己的单')

  /* ---------- ④ 配送费 / 文案 ---------- */
  section('④ 配送费规则（与 server/internal/pricing 一致）')
  ok(rules.deliveryFee('pickup', 0) === 0, '自提 0 元')
  ok(rules.deliveryFee('pickup', 5) === 0, '自提任意金额 0 元')
  ok(rules.deliveryFee('delivery', 29.99) === 3, '配送未满 30 → 3 元')
  ok(rules.deliveryFee('delivery', 30) === 0, '配送刚好 30 → 免')
  ok(rules.deliveryFee('delivery', 45.5) === 0, '配送超 30 → 免')
  ok(rules.feeHint('delivery', 20).indexOf('还差 10 元') >= 0, '提示还差多少：' + rules.feeHint('delivery', 20))
  ok(rules.feeHint('delivery', 30) === '已满 30 元，免配送费', '满额提示')
  ok(rules.feeHint('pickup', 10) === '自提免配送费', '自提提示')
  ok(rules.round2(0.1 + 0.2) === 0.3, 'round2 消掉浮点长尾：0.1+0.2 → ' + rules.round2(0.1 + 0.2))
  ok(rules.round2(3 * 1.11) === 3.33, 'round2 用于金额聚合：3×1.11 → ' + rules.round2(3 * 1.11))

  /* ---------- ④b 第 27 轮边界：未知配送方式 / minFree<=0 / 三端逐字一致 ---------- */
  section('④b 配送费边界（第 27 轮契约：未知按 delivery、minFree<=0 不免运费）')
  ok(rules.deliveryFee('xxx', 10) === 3, '未知配送方式按 delivery 收费：3 元')
  ok(rules.deliveryFee(undefined, 10) === 3 && rules.deliveryFee('', 10) === 3, '未填/空配送方式也按 delivery')
  ok(rules.deliveryFee('delivery', 29.995) === 0, '先 round2 再比门槛：29.995 → 30.00 → 免')
  ok(rules.deliveryFee('delivery', 29.994) === 3, '29.994 未到门槛 → 3 元')
  ok(rules.deliveryFee('delivery', 100, { minFree: 0 }) === 3, 'minFree<=0 = 不免运费（照收 3 元）')
  ok(rules.deliveryFee('delivery', 100, { minFree: 0, deliveryFee: 5 }) === 5, 'minFree<=0 且配送费 5 → 收 5 元')
  ok(rules.deliveryFee('pickup', 100, { pickupFee: 2 }) === 2, '自提费可配：2 元')
  ok(rules.deliveryFee('delivery', 60, { minFree: 50 }) === 0, '门槛可配：满 50 免')
  ok(rules.feeHint('delivery', 10, { minFree: 0 }).indexOf('还差') < 0, 'minFree<=0 时不说「还差 N 元免配送费」：' + rules.feeHint('delivery', 10, { minFree: 0 }))
  // 第 27 轮真源收敛：同一批用例，小程序规则与 web/pricing.js 必须逐字相同
  let WebPricing = null
  try { WebPricing = require('../web/pricing.js') } catch (e) { WebPricing = null }
  if (WebPricing) {
    const cases = [['pickup', 0], ['pickup', 99.99], ['delivery', 29.99], ['delivery', 29.994], ['delivery', 29.995], ['delivery', 30], ['delivery', 45.5], ['xxx', 10], [undefined, 10], ['', 10]]
    const diff = cases.filter((c) => WebPricing.deliveryFee(c[0], c[1]) !== rules.deliveryFee(c[0], c[1]))
    ok(diff.length === 0, '三端同判：10 组配送费用例 web/pricing.js 与小程序逐字相同' + (diff.length ? '，不一致：' + JSON.stringify(diff) : ''))
    const tierCases = [['retail', 10, 8], ['wholesale', 10, 8], ['wholesale', 10, 0], ['vip', 10, 8], ['unknown', 10, 8]]
    const tierDiff = tierCases.filter((c) => WebPricing.effectivePrice(c[0], c[1], c[2]) !== rules.effectivePrice(c[0], c[1], c[2]))
    ok(tierDiff.length === 0, '三端同判：有效价 5 组用例逐字相同' + (tierDiff.length ? '，不一致：' + JSON.stringify(tierDiff) : ''))
    const labels = ['pending', 'delivering', 'ready', 'done', 'cancelled']
    const CANON = { pending: '待备货', delivering: '配送中', ready: '待取货', done: '已完成', cancelled: '已取消' }
    const mpLabels = labels.map((s) => rules.statusLabel(s))
    ok(JSON.stringify(labels.map((s) => CANON[s])) === JSON.stringify(mpLabels), '状态文案五档与真源相同：' + mpLabels.join(' / '))
    let WebMall = null
    try { WebMall = require('../web/mall.js') } catch (e) { WebMall = null }
    if (WebMall && WebMall.STATUS_META) {
      const webLabels = labels.map((s) => (WebMall.STATUS_META[s] || {}).label || '')
      ok(JSON.stringify(webLabels) === JSON.stringify(mpLabels), '状态文案与 web/mall.js STATUS_META 逐字相同：' + webLabels.join(' / '))
    }
  } else {
    ok(true, '（跳过跨端比对：web/pricing.js 不在当前目录树）')
  }

  /* ---------- ⑤ 购物车边界 ---------- */
  section('⑤ 购物车边界')
  store.clearCart()
  ok(store.cartCount() === 0 && store.cartAmount() === 0, '清空后为 0')
  store.addToCart({ code: 'A', name: '甲', salePrice: 10 }, 1)
  store.addToCart({ code: 'B', name: '乙', salePrice: 2.5 }, 4)
  ok(store.cartAmount() === 20, '合计 10 + 10 = 20')
  store.setQty('A', 0)
  ok(store.getCart().length === 1 && store.getCart()[0].code === 'B', '数量改成 0 自动移除该行')
  store.setQty('B', 2)
  ok(store.cartCount() === 2, '改数量生效')
  store.removeFromCart('B')
  ok(store.getCart().length === 0, '删除行生效')
  store.addToCart({ code: 'C', name: '丙', salePrice: 1.11 }, 3)
  ok(store.cartAmount() === 3.33, '金额按两位小数聚合：' + store.cartAmount())
  ok(store.orderItems()[0].qty === 3 && store.orderItems()[0].price === 1.11, 'orderItems 只带 code/name/price/qty')
  store.setPrice('C', 2)
  ok(store.cartAmount() === 6, 'setPrice 改单价生效（登录/换等级后按服务端有效价刷新）')
  ok(store.setPrice('NOPE', 1).length === store.getCart().length, 'setPrice 对不存在的条码无副作用')
  store.addToCart({ code: 'C', name: '丙', salePrice: 1.11 }, 1)

  /* ---------- ⑥ 收货信息 + 后端地址 ---------- */
  section('⑥ 收货信息与后端地址')
  store.saveCustomer({ name: '王五', phone: '13700137000', address: '1 栋 101' })
  const c = store.getCustomer()
  ok(c.name === '王五' && c.address === '1 栋 101', '常用收货信息落地')
  ok(store.getCustomer().phone === '13700137000', '手机号保存')
  api.setBase('http://192.168.1.9:8093/')
  ok(api.base() === 'http://192.168.1.9:8093', 'setBase 去掉结尾斜杠')
  ok(global.wx._kv['sdy_api_base'] === 'http://192.168.1.9:8093', '地址写入本地存储（下次启动生效）')
  api.setBase('')
  ok(api.base() === api.DEFAULT_BASE, '清空后回到默认地址：' + api.DEFAULT_BASE)
  // 生产域名一旦填上（第 22 轮 mall.shadouyou.cloud），默认地址就是 HTTPS 域名而不是本机 8093
  ok(api.DEFAULT_BASE.indexOf('8093') > 0 || /^https:\/\//.test(api.DEFAULT_BASE),
    '默认地址要么是本机 8093，要么是 HTTPS 生产域名：' + api.DEFAULT_BASE)

  /* ---------- ⑦ 运行配置 + 扫码找货（只读，D8） ---------- */
  section('⑦ 运行配置与扫码找货（只读）')
  const config = require('./utils/config.js')
  ok(api.DEFAULT_BASE === config.DEFAULT_BASE_URL, '后端默认地址只有一个真源：utils/config.js')
  ok(config.DEFAULT_BASE_URL === (config.PROD_BASE_URL || config.DEV_BASE_URL), '默认地址 = 生产域名 || 开发地址')
  ok(config.PROD_BASE_URL === '' || config.PROD_BASE_URL.indexOf('https://') === 0, '生产域名要么留空、要么是 HTTPS（小程序硬要求）')
  ok(config.DEV_BASE_URL.indexOf('8093') > 0, '开发地址指向本机 Go 后端 8093')

  global.wx = wxOffline
  await api.probe()
  const cartBefore = store.cartCount()
  let hit = await api.resolveBarcode('6901234567892')
  ok(hit.found === true && hit.name === '可口可乐', '离线扫码命中本地演示商品：' + hit.name)
  ok(hit.source === 'product', '离线命中来源 source=product')
  const miss = await api.resolveBarcode('9999999999999')
  ok(miss.found === false && miss.source === 'not_found', '离线未建档条码如实返回 not_found')
  let bad = ''
  await api.resolveBarcode('   ').catch((e) => { bad = e.message })
  ok(bad === '条码为空', '空条码直接报错：' + bad)
  ok(store.cartCount() === cartBefore, '扫码只读：购物车件数不变（D8）')

  global.wx = mkWx(
    ROUTES.concat([
      { method: 'GET', re: /^\/api\/barcode\/resolve$/, body: { code: '6902083881234', found: true, name: '农夫山泉', spec: '550ml 瓶', source: 'lib' } }
    ])
  )
  await api.probe()
  hit = await api.resolveBarcode('6902083881234')
  ok(hit.found === true && hit.name === '农夫山泉' && hit.source === 'lib', '在线扫码走后端解析链并透传 source=lib')
  const resolveCall = global.wx._calls[global.wx._calls.length - 1]
  ok(resolveCall.method === 'GET' && resolveCall.path.indexOf('/api/barcode/resolve?code=6902083881234') === 0, '请求形如 GET /api/barcode/resolve?code=…')

  /* ---------- ⑧ 等级与有效价（D24，与 web/pricing.js 同口径） ---------- */
  section('⑧ 等级与有效价（D24）')
  ok(rules.tierLabel('wholesale') === '批发' && rules.tierLabel('vip') === '白名单' && rules.tierLabel('retail') === '零售',
    '等级文案：零售 / 批发 / 白名单')
  ok(rules.tierLabel('') === '零售' && rules.tierLabel(null) === '零售', '空等级按零售')
  ok(rules.normalizeTier('VIP') === 'retail', '未知大小写等级归一为零售（只认小写枚举）')
  ok(rules.validTier('wholesale') === true && rules.validTier('gold') === false && rules.validTier('') === true, 'validTier 认三个枚举')
  ok(rules.isWholesaleTier('vip') === true && rules.isWholesaleTier('retail') === false, '批发/白名单算批发档')
  ok(rules.effectivePrice('retail', 2.5, 2.2) === 2.5, '零售等级用零售价')
  ok(rules.effectivePrice('wholesale', 2.5, 2.2) === 2.2, '批发等级用批发价')
  ok(rules.effectivePrice('wholesale', 2.5, 0) === 2.5, '没设批发价 → 回落零售价')

  /* ---------- ⑨ 微信登录（第 23 轮 / D28；第 25 轮 D31 不绑手机号） ---------- */
  section('⑨ 微信登录与顾客身份')
  const LOGIN_OK = { method: 'POST', path: '/api/wx/login', body: { ok: true, openid: 'o_test_1', bound: false, phone: '', name: '', nickname: '阿明', avatar: '', tier: 'retail' } }
  const PROFILE_OK = { method: 'POST', path: '/api/wx/profile', body: { ok: true, openid: 'o_test_1', nickname: '阿明', avatar: 'https://x/a.png' } }
  const ADDR_OK = { method: 'GET', path: '/api/addresses', body: { items: [{ id: 7, phone: '13800001111', contact: '王阿姨', address: '幸福小区 3 栋 201', isDefault: true }], total: 1 } }
  global.wx = mkWx(ROUTES.concat([LOGIN_OK, PROFILE_OK, ADDR_OK]))
  api.clearSession()
  await api.probe()
  ok(api.isLoggedIn() === false && api.boundPhone() === '' && api.session() === null, '未登录：isLoggedIn=false、boundPhone 空、session=null')
  ok(api.sessionLabel().indexOf('未登录') >= 0, '未登录文案：' + api.sessionLabel())

  const sess = await api.wxLogin({ nickname: '阿明' })
  ok(sess.openid === 'o_test_1' && sess.nickname === '阿明', '只带昵称也能登录，拿到 openid')
  ok(api.isLoggedIn() === true && api.boundPhone() === '', '登录不带手机号：会话里没有手机号')
  ok(sess.bound === false && api.sessionLabel().indexOf('手机号下单时再填') > 0, '文案如实说明手机号下单时再填：' + api.sessionLabel())
  ok(api.displayName() === '阿明', '显示名优先用微信昵称：' + api.displayName())
  const loginCall = global.wx._calls.filter((c) => c.path === '/api/wx/login')[0]
  ok(!!loginCall && loginCall.data.code === 'CODE_MOCK', 'body 带 wx.login 拿到的 code')
  ok(loginCall.data.nickname === '阿明' && loginCall.data.phone === undefined, 'body 带昵称、不带手机号')
  ok(!!global.wx._calls.filter((c) => c.method === 'LOGIN')[0], '确实调用了 wx.login')

  // 头像昵称单独保存：空值保留服务端原值
  const prof = await api.saveProfile({ nickname: '阿明', avatar: 'https://x/a.png' })
  ok(prof.nickname === '阿明' && prof.avatar === 'https://x/a.png', '头像昵称保存后回写本地会话')
  await api.saveProfile({}).catch(() => {})
  const profCall = global.wx._calls.filter((c) => c.path === '/api/wx/profile').pop()
  ok(profCall.data.openid === 'o_test_1', '保存头像昵称带上 openid，服务端才知道存给谁')

  // 手机号是下单时填的（D31）：填过一次要记住，价格与地址簿都靠它（D24/D18）
  api.rememberPhone('13800001111')
  ok(api.boundPhone() === '13800001111', '下单填过的手机号被记住：' + api.boundPhone())
  list = await api.listProducts()
  const reqPath = global.wx._calls.filter((c) => c.path.indexOf('/api/products') === 0).pop().path
  ok(reqPath.indexOf('onSale=1') > 0, '顾客端只请求上架商品：' + reqPath)
  ok(reqPath.indexOf('phone=13800001111') > 0, '记住手机号后请求带 phone，让服务端按等级给价：' + reqPath)
  const addrs = await api.listAddresses()
  ok(addrs.length === 1 && addrs[0].id === '7', '地址簿按记住的手机号取：' + JSON.stringify(addrs))
  const addrPath = global.wx._calls.filter((c) => c.path.indexOf('/api/addresses') === 0).pop().path
  ok(addrPath.indexOf('phone=13800001111') > 0, '地址簿请求带手机号：' + addrPath)
  await api.listAddresses('13900002222')
  const addrPath2 = global.wx._calls.filter((c) => c.path.indexOf('/api/addresses') === 0).pop().path
  ok(addrPath2.indexOf('phone=13900002222') > 0, '地址簿允许显式传手机号（下单页刚填的那个优先）：' + addrPath2)

  // 服务端给了有效价 price 就用它（零售价仍保留，便于页面显示划线价）
  global.wx = mkWx([
    { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: false, circuitOpen: false, cloudFails: 0 } },
    {
      method: 'GET', path: '/api/products',
      body: { items: [{ code: '6901234567892', name: '可口可乐', spec: '330ml 罐', category: '饮料', unit: '罐', salePrice: 2.5, wholesalePrice: 2.2, price: 2.2, tier: 'wholesale', stock: 10 }], total: 1, tier: 'wholesale' }
    }
  ])
  await api.probe()
  list = await api.listProducts()
  ok(list[0].salePrice === 2.2 && list[0].retailPrice === 2.5, '有效价取服务端 price（批发 2.20，零售价留 2.50）')
  ok(list[0].priceText === '2.20', '显示价按有效价格式化：' + list[0].priceText)

  // 退出登录：会话与价格缓存一起清掉（免得留旧价）
  global.wx.setStorageSync('sdy_mp_products', [{ code: 'x' }])
  api.clearSession()
  ok(api.isLoggedIn() === false && api.session() === null, '退出登录后会话清空')
  ok(!global.wx.getStorageSync('sdy_mp_products'), '退出登录后价格缓存作废')

  // 没有 wx.login 的环境（例如被误用到 H5）
  const savedLogin = global.wx.login
  delete global.wx.login
  let lerr = ''
  await api.wxLogin({}).catch((e) => { lerr = e.message })
  ok(lerr.indexOf('wx.login') >= 0, '没有 wx.login 时报错：' + lerr)
  global.wx.login = savedLogin
  // wx.login 本身失败
  global.wx._loginFail = 'login:fail mock'
  lerr = ''
  await api.wxLogin({}).catch((e) => { lerr = e.message })
  ok(lerr.indexOf('login:fail mock') >= 0, 'wx.login 失败原文透出：' + lerr)
  global.wx._loginFail = ''
  // 微信没给 code
  global.wx._loginCode = ''
  lerr = ''
  await api.wxLogin({}).catch((e) => { lerr = e.message })
  ok(lerr.indexOf('没有返回 code') >= 0, '没有 code 时报错：' + lerr)
  global.wx._loginCode = 'CODE_MOCK'

  // 服务端拒绝：错误文案原样透出（D12）
  global.wx = mkWx(ROUTES.concat([
    { method: 'POST', path: '/api/wx/login', status: 400, body: { error: '手机号格式不对（要 11 位、1 开头）' } }
  ]))
  await api.probe()
  lerr = ''
  await api.wxLogin({ phone: '12345' }).catch((e) => { lerr = e.message })
  ok(lerr.indexOf('手机号格式不对') >= 0, '服务端错误原文透出：' + lerr)
  ok(api.isLoggedIn() === false, '登录失败不留会话')

  // 离线时不冒充登录成功
  global.wx = wxOffline
  await api.probe()
  lerr = ''
  await api.wxLogin({}).catch((e) => { lerr = e.message })
  ok(lerr.indexOf('后端未连接') >= 0, '离线直接拒绝登录：' + lerr)

  /* ---------- ⑩ 员工身份与员工接口（第 26 轮 / D32） ---------- */
  section('⑩ 员工身份与员工接口（扫码只读 / 入库出库盘点）')
  const STAFF_TOK = 'f0e1d2c3'.repeat(8)
  const STAFF_LOGIN = {
    method: 'POST', path: '/api/wx/login',
    body: { ok: true, openid: 'o_staff_1', bound: false, phone: '', name: '', nickname: '阿明', avatar: '', tier: 'retail', role: 'staff', staffToken: STAFF_TOK }
  }
  const STAFF_ROUTES = [
    { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: false, circuitOpen: false, cloudFails: 0 } },
    { method: 'GET', path: '/api/staff/overview', body: { ok: true, lowStock: 5, stats: { todayRevenue: 128.5, todayOrders: 6, pending: 2, lowStockCount: 1, products: 12 }, pendingOrders: [], lowStockItems: [], recent: [] } },
    { method: 'GET', path: '/api/staff/scan', body: { ok: true, code: '6901234567890', found: true, lowStock: 5, product: { code: '6901234567890', name: '农夫山泉 550ml', unit: '瓶', salePrice: 2, stock: 7, onSale: true }, recent: [] } },
    { method: 'POST', path: '/api/stock/change', body: { ok: true, stock: 9 } },
    { method: 'POST', path: '/api/products/onsale', body: { ok: true, updated: 1 } },
    { method: 'POST', path: '/api/products', body: { ok: true } },
    { method: 'GET', path: '/api/products', body: { items: SERVER_PRODUCTS, total: 2 } }
  ]

  // 没登录 / 普通顾客：员工接口在本地就被挡住，一个包都不发出去
  global.wx = mkWx(STAFF_ROUTES.concat([STAFF_LOGIN]))
  api.clearSession()
  await api.probe()
  ok(api.sessionRole() === 'customer' && api.isStaff() === false, '默认身份是顾客')
  ok(api.staffToken() === '' && JSON.stringify(api.staffHeaders()) === '{}', '没有员工令牌时请求头是空的')
  ok(api.view() === 'customer', '默认看顾客界面')
  const beforeCalls = global.wx._calls.length
  let serr = ''
  await api.staffOverview().catch((e) => { serr = e.message })
  ok(serr.indexOf('还不是员工') >= 0, '不是员工：工作台直接拒绝：' + serr)
  serr = ''
  await api.staffScan('6901234567890').catch((e) => { serr = e.message })
  ok(serr.indexOf('还不是员工') >= 0, '不是员工：扫码台直接拒绝')
  serr = ''
  await api.changeStock('6901234567890', 'stock_in', 1).catch((e) => { serr = e.message })
  ok(serr.indexOf('还不是员工') >= 0, '不是员工：改库存直接拒绝')
  serr = ''
  await api.saveProduct({ code: '6900000000001', name: '新品' }).catch((e) => { serr = e.message })
  ok(serr.indexOf('还不是员工') >= 0, '不是员工：建档直接拒绝')
  serr = ''
  await api.setOnSale(['6901234567890'], false).catch((e) => { serr = e.message })
  ok(serr.indexOf('还不是员工') >= 0, '不是员工：上下架直接拒绝')
  ok(global.wx._calls.length === beforeCalls, '被本地挡住时一个请求都不发（不做无用功）')

  // 员工身份登录：服务端给 role + 令牌
  const ssess = await api.wxLogin({ nickname: '阿明', role: 'staff' })
  ok(ssess.role === 'staff' && api.isStaff() === true, '员工登录后本机记住员工身份')
  ok(api.staffToken() === STAFF_TOK, '员工令牌存进会话：' + api.staffToken().slice(0, 8) + '…')
  ok(api.view() === 'staff', '以员工身份登录后界面就是员工版')
  const slogin = global.wx._calls.filter((c) => c.path === '/api/wx/login').pop()
  ok(slogin.data.role === 'staff', '登录时把「我是员工」一并提交：' + JSON.stringify(slogin.data))

  // 员工接口都要带令牌（服务端只认 X-Staff-Token）
  const ov = await api.staffOverview()
  ok(ov.stats.todayRevenue === 128.5, '工作台数据来自服务端')
  const ovCall = global.wx._calls.filter((c) => c.path === '/api/staff/overview').pop()
  ok(ovCall.header && ovCall.header['X-Staff-Token'] === STAFF_TOK, '工作台请求带 X-Staff-Token')
  const scn = await api.staffScan('6901234567890')
  ok(scn.found === true && scn.product.stock === 7, '扫码台查到货与库存')
  const scnCall = global.wx._calls.filter((c) => c.path.indexOf('/api/staff/scan') === 0).pop()
  ok(scnCall.path.indexOf('code=6901234567890') > 0 && scnCall.header['X-Staff-Token'] === STAFF_TOK, '扫码请求带条码与令牌：' + scnCall.path)
  ok(JSON.stringify(api.staffHeaders()) === JSON.stringify({ 'X-Staff-Token': STAFF_TOK }), '复用同一个令牌头')

  // 改库存：三种口径（入库增量 / 出库负数 / 盘点绝对值），流水带「谁改的」
  const c1 = await api.changeStock('6901234567890', 'stock_in', 3)
  const chCall = global.wx._calls.filter((c) => c.path === '/api/stock/change').pop()
  ok(chCall.data.kind === 'stock_in' && chCall.data.qty === 3, '入库：stock_in +3')
  ok(chCall.data.reason === '员工小程序操作' && chCall.data.by === '阿明', '不填原因时用兜底文案，操作人写当前微信名：' + JSON.stringify(chCall.data))
  await api.changeStock('6901234567890', 'adjust', -2, '员工小程序出库')
  ok(global.wx._calls.filter((c) => c.path === '/api/stock/change').pop().data.reason === '员工小程序出库', '扫码台给的原因原样带上')
  ok(global.wx._calls.filter((c) => c.path === '/api/stock/change').pop().data.qty === -2, '出库：adjust 传负数')
  await api.changeStock('6901234567890', 'stock_take', 5, '员工小程序盘点')
  ok(global.wx._calls.filter((c) => c.path === '/api/stock/change').pop().data.qty === 5, '盘点：stock_take 传实盘数')
  ok(!!c1, '改库存返回服务端结果')

  // 建档 / 改档案：不传 stock 就绝对不碰库存（D16）
  await api.saveProduct({ code: '6900000000001', name: '新品矿泉水', salePrice: 2.5, costPrice: 1.5 })
  const pCall = global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/products').pop()
  ok(pCall.data.code === '6900000000001' && pCall.data.stock === undefined, '建档不传 stock：完全不碰库存')
  ok(pCall.data.isWholesale === false && pCall.data.img === '', '建档把可选字段补齐（覆盖式 upsert 不会清掉别的）')
  await api.saveProduct({ code: '6900000000001', name: '新品矿泉水', stock: 6 })
  ok(global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/products').pop().data.stock === 6, '明确传 stock 才覆盖库存')
  serr = ''
  await api.saveProduct({ code: '', name: 'x' }).catch((e) => { serr = e.message })
  ok(serr.indexOf('商品条码不能为空') >= 0, '没条码不给建档：' + serr)
  serr = ''
  await api.saveProduct({ code: '1', name: '  ' }).catch((e) => { serr = e.message })
  ok(serr.indexOf('商品名称不能为空') >= 0, '没名字不给建档')

  // 上下架：只动状态（D23）
  serr = ''
  await api.setOnSale([], true).catch((e) => { serr = e.message })
  ok(serr.indexOf('先选商品') >= 0, '没选商品不给上下架')
  await api.setOnSale(['6901234567890'], false)
  const osCall = global.wx._calls.filter((c) => c.path === '/api/products/onsale').pop()
  ok(osCall.data.codes[0] === '6901234567890' && osCall.data.onSale === false, '下架只发 codes + onSale')

  // 员工库存页看得到已下架的货（顾客端只请求 onSale=1）
  await api.listAllProducts('农夫')
  const allCall = global.wx._calls.filter((c) => c.path.indexOf('/api/products') === 0).pop()
  ok(allCall.path.indexOf('keyword=') > 0 && allCall.path.indexOf('onSale=1') < 0, '员工列表带关键字、且不限定上架：' + allCall.path)

  // 界面开关与身份是两件事：切回顾客版不丢员工身份
  api.setView('customer')
  ok(api.view() === 'customer' && api.isStaff() === true && api.staffToken() === STAFF_TOK, '切回顾客版：身份与令牌都还在')
  api.setView('staff')
  ok(api.view() === 'staff', '还能再切回员工版')

  // 员工以顾客身份登录：界面留在顾客版，但令牌照样给（方便「我的」里一键进工作台）
  global.wx = mkWx(STAFF_ROUTES.concat([STAFF_LOGIN]))
  api.clearSession()
  await api.probe()
  await api.wxLogin({ nickname: '阿明', role: 'customer' })
  ok(api.isStaff() === true && api.view() === 'customer', '员工选顾客身份登录：留在顾客版，身份仍是员工')
  ok(api.staffToken() === STAFF_TOK, '员工选顾客身份登录也拿到令牌（不是提权，本来就有）')

  // 普通顾客登录：拿不到令牌，也进不去员工页
  global.wx = mkWx(STAFF_ROUTES.concat([LOGIN_OK]))
  api.clearSession()
  await api.probe()
  await api.wxLogin({})
  ok(api.isStaff() === false && api.staffToken() === '' && api.view() === 'customer', '普通顾客登录：没有角色也没有令牌')

  /* ---------- ⑪ 第 28 轮：排序 / 分页 / 热销 / 同类推荐 ---------- */
  section('⑪ 第 28 轮契约：排序分页（7.2）+ 热销（7.3）+ 同类推荐（7.4）')

  // 导出面：R27 踩过「定义了没导出」的坑，这里直接盯 module.exports
  ok(typeof api.hotProducts === 'function' && typeof api.alternatives === 'function',
    'hotProducts / alternatives 都在 module.exports 里')
  ok(Array.isArray(api.SORTS) && api.SORTS.indexOf('price_asc') >= 0 && api.SORTS.indexOf('default') >= 0 && api.PAGE_LIMIT_MAX === 200,
    '排序取值与分页上限也导出了：' + JSON.stringify(api.SORTS))

  // 离线：老调用向后兼容（只传 2 个参数仍返回商品数组）
  global.wx = wxOffline
  await api.probe()
  const p28old = await api.listProducts('', '')
  ok(Array.isArray(p28old) && p28old.length === 6, '只传 2 个参数的老调用仍返回数组（向后兼容，6 条演示商品）')

  // 离线分页：传 opts 才返回契约对象
  const p28off = await api.listProducts('', '', { sort: 'price_asc', limit: 2, offset: 0 })
  ok(!Array.isArray(p28off) && p28off.items.length === 2 && p28off.total === 6 && p28off.limit === 2 &&
    p28off.offset === 0 && p28off.hasMore === true,
    '传 opts 返回 {items,total,limit,offset,hasMore}：' + JSON.stringify({ n: p28off.items.length, total: p28off.total, hasMore: p28off.hasMore }))
  ok(p28off.tier === '', '离线没有等级信息时 tier 给空串（不是 undefined）')
  ok(p28off.items[0].name === '农夫山泉' && p28off.items[1].name === '可口可乐',
    '离线 price_asc 按有效价升序：' + p28off.items.map((p) => p.name).join(' < '))
  const p28off2 = await api.listProducts('', '', { sort: 'price_asc', limit: 2, offset: 4 })
  ok(p28off2.items.length === 2 && p28off2.hasMore === false, 'offset=4 翻到最后一页 → hasMore=false')
  const p28off3 = await api.listProducts('', '', { sort: 'price_desc', limit: 1, offset: 0 })
  ok(p28off3.items[0].name === '青岛啤酒', '离线 price_desc 从最贵的开始：' + p28off3.items[0].name)

  const p28offHot = await api.hotProducts(6)
  ok(p28offHot.items.length === 6 && p28offHot.total === 6, '离线热销降级到本地演示商品（6 件）')
  const p28offAlt = await api.alternatives('6901234567892', 5)
  ok(p28offAlt.items.length === 5 && p28offAlt.items.every((p) => p.code !== '6901234567892' && p.stock > 0),
    '离线同类推荐排除自身、只给有货的（最多 5 件）')
  ok(p28offAlt.items[0].category === '饮料', '离线同类推荐优先同分类：' + p28offAlt.items[0].name)

  // 在线：sort/limit/offset 原样拼进 query，返回按服务端字段
  const P28_ROUTES = [
    { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: false, circuitOpen: false, cloudFails: 0 } },
    { method: 'GET', re: /^\/api\/products$/, body: { items: SERVER_PRODUCTS, total: 2, limit: 20, offset: 0, hasMore: false, tier: 'retail' } },
    { method: 'GET', re: /^\/api\/products\/hot$/, body: { items: SERVER_PRODUCTS, total: 2 } },
    { method: 'GET', re: /^\/api\/products\/alternatives$/, body: { items: [SERVER_PRODUCTS[0]], total: 1 } }
  ]
  global.wx = mkWx(P28_ROUTES)
  await api.probe()
  const p28on = await api.listProducts('可乐', '', { sort: 'price_asc', limit: 20, offset: 0 })
  const p28call = global.wx._calls.filter((c) => c.path.indexOf('/api/products?') === 0).pop()
  ok(p28call.path.indexOf('sort=price_asc') > 0 && p28call.path.indexOf('limit=20') > 0 && p28call.path.indexOf('offset=0') > 0,
    'sort/limit/offset 原样拼进 query：' + p28call.path)
  ok(p28on.items.length === 2 && p28on.total === 2 && p28on.hasMore === false && p28on.tier === 'retail',
    '在线分页按服务端字段返回，tier 原样带回：' + p28on.tier)
  ok(p28call.path.indexOf('keyword=' + encodeURIComponent('可乐')) > 0, '关键词照旧带上：' + p28call.path)

  for (const s of ['default', 'hot', 'price_asc', 'price_desc']) {
    await api.listProducts('', '', { sort: s, limit: 20, offset: 0 })
    const c = global.wx._calls.filter((x) => x.path.indexOf('/api/products?') === 0).pop()
    ok(c.path.indexOf('sort=' + s) > 0, '排序值逐字传 ' + s)
  }

  const p28hot = await api.hotProducts(6)
  const p28hotCall = global.wx._calls.filter((c) => c.path.indexOf('/api/products/hot?') === 0).pop()
  ok(p28hotCall.path.indexOf('limit=6') > 0, '热销请求 limit 原样传：' + p28hotCall.path)
  ok(p28hot.items.length === 2 && p28hot.total === 2, '热销返回 {items,total}')
  await api.hotProducts()
  const p28hotCall2 = global.wx._calls.filter((c) => c.path.indexOf('/api/products/hot?') === 0).pop()
  ok(p28hotCall2.path.indexOf('limit=8') > 0, '热销 limit 缺省 8（契约 7.3）：' + p28hotCall2.path)

  const p28alt = await api.alternatives('6900000000009', 5)
  const p28altCall = global.wx._calls.filter((c) => c.path.indexOf('/api/products/alternatives?') === 0).pop()
  ok(p28altCall.path.indexOf('code=6900000000009') > 0 && p28altCall.path.indexOf('limit=5') > 0,
    '同类推荐带 code + limit=5：' + p28altCall.path)
  ok(p28alt.items.length === 1 && p28alt.total === 1, '同类推荐返回 {items,total}')

  // 失败要 reject（不吞成空数组），页面才能走「出错可重试」而不是「没有这件商品」
  global.wx = mkWx([
    { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: false, circuitOpen: false, cloudFails: 0 } },
    { method: 'GET', re: /^\/api\/products(\?|$)/, fail: 'request:fail timeout' },
    { method: 'GET', re: /^\/api\/products\/(hot|alternatives)$/, fail: 'request:fail timeout' }
  ])
  await api.probe()
  let p28err = ''
  await api.listProducts('', '', { sort: 'hot', limit: 20, offset: 0 }).catch((e) => { p28err = String((e && e.message) || e) })
  ok(p28err.length > 0, '分页清单失败 → reject：' + p28err)
  p28err = ''
  await api.hotProducts(6).catch((e) => { p28err = String((e && e.message) || e) })
  ok(p28err.length > 0, '热销请求失败 → reject（不吞成空数组）')
  p28err = ''
  await api.alternatives('6900000000009', 5).catch((e) => { p28err = String((e && e.message) || e) })
  ok(p28err.length > 0, '同类推荐请求失败 → reject（不吞成空数组）')

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错：', e)
  process.exit(1)
})

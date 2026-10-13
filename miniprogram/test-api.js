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
      calls.push({ method: method, path: full, url: opts.url, data: opts.data })
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
  { method: 'POST', re: /^\/api\/orders\/[^/]+\/advance$/, body: Object.assign({}, SERVER_ORDER, { status: 'cancelled' }) }
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
  store.addToCart({ code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', unit: '罐', emoji: '🥤', salePrice: 2.5 }, 2)
  ok(store.cartCount() === 2 && store.cartAmount() === 5, '购物车 2 件 / 合计 5 元')
  store.addToCart({ code: '6901234567892', salePrice: 2.5, name: '可口可乐' }, 1)
  ok(store.cartCount() === 3 && store.getCart().length === 1, '同条码合并而不是新增一行')

  let r = await api.createOrder({
    customerName: '张三', phone: '13800138000', address: '',
    deliveryType: 'pickup', items: store.orderItems()
  })
  ok(r.local === false, '在线下单 local=false')
  ok(r.order.statusText === '待处理', '状态文案：待处理')
  ok(r.order.deliveryText === '到店自提', '配送方式文案：到店自提')
  ok(r.order.totalText === '5.00' && r.order.feeText === '0.00', '总额/配送费格式化为两位小数')
  ok(r.order.summary === '可口可乐×2', '订单摘要按服务端回单生成：' + r.order.summary)
  ok(r.order.createdText.indexOf('2026-10-11') === 0, '创建时间本地化：' + r.order.createdText)
  const post = global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/orders')[0]
  ok(!!post, '确实发出 POST /api/orders')
  ok(post.data.deliveryType === 'pickup' && post.data.address === '', 'body：自提不带地址')
  ok(post.data.items.length === 1 && post.data.items[0].code === '6901234567892' && post.data.items[0].qty === 3, 'body：只传 code+qty（价格由服务端算）')
  ok(post.data.customerName === '张三' && post.data.phone === '13800138000', 'body：收货人信息')

  const olist = await api.listOrders()
  ok(olist.length === 1 && olist[0].id === SERVER_ORDER.id, '订单列表来自后端')
  let got = await api.getOrder(SERVER_ORDER.id)
  ok(got.total === 5, '订单详情按 id 查询')
  let cancelled = await api.cancelOrder(SERVER_ORDER.id)
  ok(cancelled.statusText === '已取消', '取消后状态文案：已取消')

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

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错：', e)
  process.exit(1)
})

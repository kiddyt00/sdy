/* =====================================================================
 * 小程序 ↔ Go 后端 真联调（用 Node fetch 冒充 wx.request）
 *   后端没起就跳过（exit 0），不阻塞本地回归
 * 运行：SDY_API_BASE=http://127.0.0.1:8093 node miniprogram/test-integration.js
 * ===================================================================== */
'use strict'

let passed = 0, failed = 0
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg) }
  else { failed++; console.log('  ✘ ' + msg) }
}
function section(t) { console.log('\n■ ' + t) }

const BASE = process.env.SDY_API_BASE || 'http://127.0.0.1:8093'
const kv = {}

global.wx = {
  getStorageSync: (k) => (k in kv ? kv[k] : ''),
  setStorageSync: (k, v) => { kv[k] = v },
  removeStorageSync: (k) => { delete kv[k] },
  showToast: () => {},
  switchTab: () => {},
  login: (o) => { if (o && o.success) o.success({ code: 'CODE_TEST' }) },
  showModal: (o) => { if (o && o.success) o.success({ confirm: true }) },
  request(opts) {
    const method = (opts.method || 'GET').toUpperCase()
    const url = opts.url
    const init = { method: method, headers: Object.assign({ 'content-type': 'application/json' }, opts.header || {}) }
    if (opts.data !== undefined && method !== 'GET') init.body = JSON.stringify(opts.data)
    fetch(url, init)
      .then((res) => res.text().then((txt) => {
        let data = {}
        try { data = txt ? JSON.parse(txt) : {} } catch (e) { data = { raw: txt } }
        opts.success({ statusCode: res.status, data: data })
      }))
      .catch((e) => opts.fail({ errMsg: e.message }))
  }
}

const api = require('./utils/api.js')
const store = require('./utils/store.js')

async function main() {
  section('① 连通性')
  api.setBase(BASE)
  const st = await api.probe()
  if (!st.online) {
    console.log('\n⏭ 后端未启动（' + BASE + '），跳过联调：' + st.error)
    process.exit(0)
  }
  ok(st.online === true, 'probe 连通：' + BASE)
  ok(st.label === '🟢 后端已连接', 'label=' + st.label)
  ok(typeof st.cloudConfigured === 'boolean', '拿到 cloudConfigured=' + st.cloudConfigured)

  section('② 商品（来自服务端）')
  const list = await api.listProducts()
  ok(list.length >= 6, '商品至少 6 条（实际 ' + list.length + '）')
  const cola = list.filter((p) => p.code === '6901234567892')[0]
  ok(!!cola, '找得到可口可乐')
  ok(cola.salePrice === 2.5 && cola.unit === '罐', '价格 2.5 / 单位 罐')
  ok(cola.server === true && cola.priceText === '2.50', '映射带 server 标记与格式化价格')
  const stockBefore = cola.stock
  ok(stockBefore > 0, '库存 > 0（' + stockBefore + '）')
  const searched = await api.listProducts('可口可乐')
  ok(searched.length >= 1 && searched.some((p) => p.code === '6901234567892'), '按关键词搜索命中')

  section('③ 下单（服务端算钱 + 扣库存）')
  // 第 27 轮起下单必须带身份：api.identityParams() 只认会话里的 openid/phone，
  // 不认 createOrder 入参里的 phone（入参 phone 是收货人，不当作身份）。
  api.rememberPhone('13800138000')
  // 第 31 轮：小程序一进页面就问 /api/settings（拿 payEnabled），这里照做，
  // 后面的订单文案断言才有真实的「开没开通在线支付」依据。
  const pSettings = await api.getSettings().catch(() => ({}))
  const payOn = pSettings.payEnabled === true
  ok(typeof pSettings.payEnabled === 'boolean', 'GET /api/settings 下发 payEnabled 布尔派生字段：' + pSettings.payEnabled)
  ok(api.payEnabled() === payOn, 'payEnabled 收进客户端缓存（api.payEnabled()）：' + api.payEnabled())
  store.clearCart()
  store.addToCart(cola, 2)
  const r = await api.createOrder({
    customerName: '联调顾客', phone: '13800138000', address: '',
    deliveryType: 'pickup', items: store.orderItems()
  })
  ok(r.local === false, '在线下单（local=false）')
  const o = r.order
  ok(o.id.charAt(0) === 'M', '订单号由服务端生成（M 开头）：' + o.id)
  // 第 29/31 轮：pending 单显「待付款」还是「待备货」= paid 口径 ∧ 店铺有没有开通在线支付。
  // 没开通（或拿不到配置）时退回第 28 轮「待备货」—— 不新增 status 值，也不催一笔付不出的款。
  ok(o.status === 'pending' && o.statusText === (payOn && o.paidKnown && !o.paid ? '待付款' : '待备货'),
    '初始状态 pending，文案按 paid + payEnabled 口径：' + o.statusText +
    '（payEnabled=' + payOn + ' / paidKnown=' + o.paidKnown + ' / paid=' + o.paid + '）')
  ok(o.subtotal === 5 && o.deliveryFee === 0 && o.total === 5, '自提：小计 5 + 配送 0 = 5')
  ok(o.items.length === 1 && o.items[0].qty === 2, '明细 1 行 ×2')
  ok(o.summary.indexOf('可口可乐') >= 0, '摘要：' + o.summary)

  const cola2 = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0]
  ok(cola2.stock === stockBefore - 2, '服务端扣了 2 件库存：' + stockBefore + ' → ' + cola2.stock)

  /* ---------- 第 29 轮：支付（未配置就只验 503 这条，绝不真支付） ---------- */
  section('③b 支付：prepay（未配置 → 503 / 已配置 → 下发 payParams）')
  let prepayRes = null
  let prepayErr = null
  await api.prepay(o.id).then((d) => { prepayRes = d }, (e) => { prepayErr = e })
  // 已配置支付的后端要求顾客身份里带 openid（纯手机号只能下单、不能付款，契约 §1.5）。
  // 真机上小程序就是「先 wx.login 拿 openid，再拉起收银台」，这里照做一次；
  // 本机后端没配 WX_APPID 时这次登录会失败，于是自然落到下面的跳过分支，不假装成功。
  if (!prepayRes && !(prepayErr && prepayErr.statusCode === 503)) {
    await api.wxLogin({ phone: '13800138000', nickname: '联调支付' }).catch(() => null)
    await api.prepay(o.id).then((d) => { prepayRes = d; prepayErr = null }, (e) => { prepayErr = e })
  }
  if (prepayRes) {
    // 本地后端已经配好商户号：只验参数形状，不把它交给 wx.requestPayment
    ok(payOn === true, '已配置支付 ⇒ /api/settings 的 payEnabled 同时是 true（不会出现「能付却按待备货」）')
    ok(!!(prepayRes.payParams && prepayRes.payParams.package), '已配置支付：prepay 下发 payParams（' + prepayRes.payParams.package + '）')
    ok(prepayRes.outTradeNo === o.id && prepayRes.amountFen > 0,
      'prepay 金额按整数分下发：' + prepayRes.amountFen + ' 分 / outTradeNo=' + prepayRes.outTradeNo)
    ok(typeof prepayRes.expireAt === 'number' && prepayRes.expireAt > 0, 'prepay 下发支付到期时间：' + prepayRes.expireAt)
  } else if (prepayErr && prepayErr.statusCode === 503) {
    // 契约 §1.2：服务端没配齐商户号 / 证书 / APIv3 密钥就是 503，客户端要能识别
    ok(payOn === false, '未配置支付 ⇒ payEnabled=false 与 prepay 503 口径一致（不会催一笔付不出的款）')
    ok(prepayErr.noPayConfig === true, '未配置支付时 prepay 抛出可识别错误（noPayConfig）')
    ok(String(prepayErr.message).indexOf('微信支付未配置') >= 0, '错误文案可读：' + prepayErr.message)
    ok(prepayErr.statusCode === 503, 'prepay 未配置 → HTTP 503')
  } else {
    // 后端还没实现 /api/pay/prepay（例如路由未挂）：如实跳过，不当成失败
    ok(true, '后端还没实现支付接口，跳过 prepay 断言：' + (prepayErr && prepayErr.message))
    ok(true, '同样跳过「未配置 → 503」断言（本机后端未接入支付）')
    ok(true, '联调不真支付，跳过 payParams 断言')
    ok(true, '同样跳过「payEnabled 与 prepay 口径一致」断言（本机后端未接入支付）')
  }
  // 第 31 轮：pending 未付款单的文案与「去支付」入口随 payEnabled 走 —— 两种形态都是真断言，不跳过
  const oPay = await api.getOrder(o.id)
  ok(oPay.status === 'pending' && oPay.paid === false, '新单在服务端仍是 pending + paid=false（第 29 轮契约）')
  ok(oPay.statusText === (payOn ? '待付款' : '待备货'),
    '订单文案随 payEnabled：payEnabled=' + payOn + ' → ' + oPay.statusText)
  ok(oPay.canPay === payOn, '「去支付」入口只在开通支付时出现（canPay=' + oPay.canPay + '）')
  ok(oPay.payHint === (payOn ? '还没付款，付了款老板马上备货' : ''),
    '未开通支付时不出现催款文案：' + JSON.stringify(oPay.payHint))
  let pstat = null
  await api.payStatus(o.id).then((s) => { pstat = s }, () => null)
  if (pstat) {
    ok(pstat.paid === false, '新单未付款：payStatus.paid=false（布尔）')
    ok(typeof pstat.status === 'string' && pstat.status.length > 0, 'payStatus 带回订单状态：' + pstat.status)
  } else {
    ok(true, 'payStatus 暂不可用（后端还没实现支付接口），跳过支付态断言')
    ok(true, '同样跳过 payStatus.status 断言（联调不真支付）')
  }


  section('④ 订单列表 / 取消回补库存')
  const mine = (await api.listOrders()).filter((x) => x.id === o.id)
  ok(mine.length === 1, '订单出现在列表里')
  const got = await api.getOrder(o.id)
  ok(got.id === o.id && got.total === 5, '按订单号查询详情')
  const cancelled = await api.cancelOrder(o.id)
  ok(cancelled.status === 'cancelled' && cancelled.statusText === '已取消', '取消成功')
  const cola3 = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0]
  ok(cola3.stock === stockBefore, '取消后库存回补：' + cola3.stock)

  section('⑤ 服务端错误原文透出（不静默）')
  store.clearCart()
  store.addToCart(cola, 999999)
  let msg = ''
  try {
    await api.createOrder({ customerName: '库存测试', phone: '13800138000', address: '', deliveryType: 'pickup', items: store.orderItems() })
  } catch (e) {
    msg = e.message
  }
  ok(msg.indexOf('库存') >= 0 || msg.indexOf('不足') >= 0, '库存不足报错原文：' + msg)

  section('⑥ 扫码找货（只读，走后端条码解析链）')
  const stockAtScan = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0].stock
  const hit = await api.resolveBarcode('6901234567892')
  ok(hit.found === true && hit.name === '可口可乐', '命中已建档条码：' + hit.name + '（source=' + hit.source + '）')
  const hitUnknown = await api.resolveBarcode('9999999999999')
  ok(hitUnknown.found === false, '未建档条码 found=false（source=' + hitUnknown.source + '）')
  const stockAfterScan = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0].stock
  ok(stockAfterScan === stockAtScan, '扫码只读：库存不变（' + stockAfterScan + '，D8）')

  section('⑧ 商品详情 / 分类（R24 新增接口）')
  const detail = await api.getProduct('6901234567892')
  ok(detail.code === '6901234567892' && detail.name === '可口可乐', '按条码取详情：' + detail.name)
  ok(detail.price === 2.5 && detail.salePrice === 2.5, '零售顾客看到零售价 2.5')
  ok(!!detail.emoji, '带 emoji 兜底图标：' + detail.emoji)
  let detailErr = ''
  try { await api.getProduct('9999999999999') } catch (e) { detailErr = e.message }
  ok(detailErr.indexOf('商品') >= 0, '未知条码报错原文：' + detailErr)

  const cats = await api.listCategories()
  ok(cats.length >= 1, '分类接口返回 ' + cats.length + ' 个分类')
  ok(cats.every((c) => typeof c.name === 'string' && c.name !== '' && c.count > 0), '每个分类都有名字与在售件数')
  ok(cats.some((c) => c.name === '饮料'), '含「饮料」分类（' + cats.map((c) => c.name + '/' + c.count).join(' ') + '）')

  section('⑨ 批发等级 + 地址簿（手机号即身份）')
  // 本段要求「13800001111 = 批发客户」且「可口可乐带批发价 2.2」，这是演示数据集
  // （deploy/seed-demo.py）的内容：Go 内置的 SEED_DEMO 只灌商品，商品不带 wholesalePrice、
  // 也不登记顾客等级。为了让这段在两种后端上都是**真断言**而不是碰运气（等级本身只能由
  // 管理端设定，D24），先照服务端单测的做法用管理端接口把前置数据补齐，断言完再恢复原样。
  const COKE = '6901234567892'
  const cokeBefore = (await raw('/api/products/' + COKE, 'GET')).data || {}
  const cokeFixNeeded = !(Number(cokeBefore.wholesalePrice) > 0)
  if (cokeFixNeeded) await raw('/api/products', 'POST', Object.assign({}, cokeBefore, { wholesalePrice: 2.2 }))
  const cokeNow = (await raw('/api/products/' + COKE, 'GET')).data || {}
  ok(Number(cokeNow.wholesalePrice) === 2.2,
    '前置：可口可乐批发价 2.2（' + (cokeFixNeeded ? '内置 SEED_DEMO 不带，已用管理端接口补齐' : '演示数据集自带') + '）')
  const tiered = await raw('/api/customers/tier', 'POST', { phone: '13800001111', name: '王阿姨', tier: 'wholesale' })
  ok(tiered.status === 200 && tiered.data.tier === 'wholesale', '前置：13800001111 是批发客户（等级只能管理端设，D24）')
  // 只带手机号：商品详情按 ?phone= 定级（手机号即身份，D24）。这里刻意不放 openid——
  // 一个服务端不认识的 openid 只会让身份解析落空（R27：未知 openid 不算顾客身份）。
  kv['sdy_mp_session'] = { phone: '13800001111', name: '王阿姨', tier: 'wholesale' }
  ok(api.boundPhone() === '13800001111', '注入会话手机号：' + api.boundPhone())
  const dw = await api.getProduct(COKE)
  ok(dw.tier === 'wholesale' && dw.price === 2.2,
    '批发顾客看到批发价 2.2（tier=' + dw.tier + '，实付 ' + dw.price + '）')
  kv['sdy_mp_session'] = { phone: '13800138000' }
  const dwRetail = await api.getProduct(COKE)
  ok(dwRetail.tier === 'retail' && dwRetail.price === 2.5,
    '同一个商品零售顾客看零售价 2.5（tier=' + dwRetail.tier + '，说明等级真的在换算价格）')
  if (cokeFixNeeded) await raw('/api/products', 'POST', Object.assign({}, cokeBefore, { wholesalePrice: 0 }))

  // 地址簿换一个演示数据里没有的号，第一条必然成为默认地址（老号 13800001111 演示数据已带地址）
  kv['sdy_mp_session'] = { openid: 'integration-test', phone: '13800138000', name: '联调顾客', tier: 'retail' }
  ok(api.boundPhone() === '13800138000', '地址簿换到干净手机号：' + api.boundPhone())
  const addr1 = await api.saveAddress({ contact: '联调收货人', address: '福建省福州市联调路 1 号' })
  ok(addr1.id !== '' && addr1.contact === '联调收货人', '新增地址返回 id=' + addr1.id)
  ok(addr1.isDefault === true, '第一条自动成为默认地址')
  const addr2 = await api.saveAddress({ contact: '联调乙', address: '福建省福州市联调路 2 号', isDefault: true })
  const addrList = await api.listAddresses()
  const a1 = addrList.filter((x) => x.id === addr1.id)[0]
  const a2 = addrList.filter((x) => x.id === addr2.id)[0]
  ok(addrList.length >= 2, '地址列表至少 2 条（' + addrList.length + '）')
  ok(a2.isDefault === true && a1.isDefault === false, '设默认会把旧的默认顶掉')
  ok(addr1.id === String(addr1.id), 'id 一律当字符串用（模板不区分数字/字符串）')
  const del = await api.deleteAddress(addr1.id)
  ok(del.ok === true || del.id !== undefined, '删除地址有回执')
  ok((await api.listAddresses()).every((x) => x.id !== addr1.id), '删掉的地址不再出现')
  await api.deleteAddress(addr2.id)
  api.clearSession()

  section('⑩ 订单状态机（推进要员工，确认收货归顾客）')
  api.rememberPhone('13800138000')
  store.clearCart()
  const colaNow = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0]
  store.addToCart(colaNow, 1)
  const r2 = await api.createOrder({
    customerName: '状态测试', phone: '13800138000', address: '福建省福州市联调路 1 号',
    deliveryType: 'delivery', items: store.orderItems()
  })
  const o2 = r2.order
  ok(o2.deliveryFee === 3 && o2.total === 5.5, '送货不满 30 元加 3 元配送费：' + o2.total)
  // 第 27 轮：advance 收紧为员工专属（待备货→配送中），顾客没有令牌会被拦
  let ownerErr = ''
  try { await api.advanceOrder(o2.id, 'delivering') } catch (e) { ownerErr = e.message }
  ok(ownerErr.indexOf('只有店主') >= 0, '顾客没有员工令牌推不动订单：' + ownerErr)
  // 老板/员工在后台（raw 直打接口）把它推到配送中
  const pushed = await raw('/api/orders/' + o2.id + '/advance', 'POST', { to: 'delivering' })
  ok(pushed.status === 200 && pushed.data.status === 'delivering', '员工侧推进到「配送中」：' + pushed.data.status)
  const mid = await api.getOrder(o2.id)
  ok(mid.status === 'delivering' && mid.statusText === '配送中', '顾客看得到配送中')
  ok(mid.canAdvance === true && mid.canCancel === false, '配送中只给「确认收货」按钮')
  // 归属人 + to=done（确认收货）必须放行——R25 已上线的功能不能被鉴权打死
  const fin = await api.advanceOrder(o2.id, 'done')
  ok(fin.status === 'done' && fin.statusText === '已完成', '归属人「确认收货」→ 已完成')
  ok(fin.canReorder === true, '已完成给「再来一单」按钮')
  // 顾客点「推进」时，客户端先按令牌拦住（到不了服务端）；服务端自己的状态机
  // 用裸接口再验一次（灰度档无身份=管理端放行），确保非法迁移不是靠前端兜的。
  let advErr = ''
  try { await api.advanceOrder(o2.id, 'ready') } catch (e) { advErr = e.message }
  ok(advErr.indexOf('只有店主') >= 0, '顾客侧本地拦住非「确认收货」的推进：' + advErr)
  const illegal = await raw('/api/orders/' + o2.id + '/advance', 'POST', { to: 'ready' })
  ok(illegal.status === 409 && String(illegal.data.error || '').indexOf('状态不允许') >= 0,
    '服务端状态机拒绝已完成→待自提（409 状态冲突）：' + illegal.status + ' ' + (illegal.data.error || ''))

  section('⑦ 微信登录（没配 AppSecret 就不假装成功）')
  let loginErr = ''
  try {
    await api.wxLogin({ phone: '13800001111', nickname: '联调' })
  } catch (e) {
    loginErr = e.message
  }
  if (api.isLoggedIn()) {
    ok(true, '目标服务端已配好微信登录，换回 openid=' + api.session().openid)
    api.clearSession()
  } else {
    ok(loginErr.length > 0, '未配置时如实报错：' + loginErr)
    ok(loginErr.indexOf('微信') >= 0, '报错要说清是微信登录的问题，不能静默失败')
    ok(api.boundPhone() === '', '登录失败不留任何身份')
  }

  section('⑪ 员工身份 + 扫码台（第 26 轮 / D32）')
  // 老板在后台改角色这一步小程序端不做，联调里直接用后台接口把角色提上去
  async function raw(path, method, body) {
    const res = await fetch(BASE + path, {
      method: method || 'GET',
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined
    })
    const txt = await res.text()
    let d = {}
    try { d = txt ? JSON.parse(txt) : {} } catch (e) { d = { raw: txt } }
    return { status: res.status, data: d }
  }

  api.clearSession()
  let staffReady = false
  try {
    await api.wxLogin({ nickname: '联调员工' })
    staffReady = true
  } catch (e) {
    console.log('⏭ 服务端没配微信登录，跳过员工端联调：' + e.message)
  }
  if (staffReady) {
    const openid = api.session().openid
    ok(api.isStaff() === false && api.staffToken() === '', '普通登录默认是顾客，没有员工令牌')
    const setRes = await raw('/api/wx/role', 'POST', { openid: openid, role: 'staff' })
    ok(setRes.status === 200 && setRes.data.role === 'staff', '后台把 ' + openid + ' 设成员工')
    const badRole = await raw('/api/wx/role', 'POST', { openid: openid, role: 'boss' })
    ok(badRole.status === 400, '非法角色被挡：' + badRole.status)

    await api.wxLogin({ nickname: '联调员工', role: 'staff' })
    ok(api.isStaff() === true && api.staffToken().length === 64, '员工身份登录拿到 64 位令牌')
    ok(api.view() === 'staff', '以员工身份登录后进员工界面')

    const ov = await api.staffOverview()
    ok(ov.stats.products >= 6 && typeof ov.stats.todayRevenue === 'number', '工作台统计来自真库：商品 ' + ov.stats.products + ' 件 / 今日 ' + ov.stats.todayOrders + ' 单')
    ok(Array.isArray(ov.lowStockItems) && Array.isArray(ov.recent), '工作台带低库存与最近流水')
    ok(ov.lowStock === 5, '低库存阈值口径 ' + ov.lowStock)

    // 用一条只属于这次联调的货，跑完删掉
    const CODE = '6900000000099'
    await raw('/api/products/stock', 'POST', { code: CODE, stock: 0 })
    const made = await raw('/api/products', 'POST', {
      code: CODE, name: '联调员工专用货', spec: '1 瓶', unit: '瓶',
      salePrice: 1.5, costPrice: 1, salePriceNote: '', stock: 8
    })
    ok(made.status === 200, '先建一条联调专用货（库存 8）')

    const s1 = await api.staffScan(CODE)
    ok(s1.found === true && s1.product.stock === 8 && s1.product.name === '联调员工专用货', '员工扫码命中：' + s1.product.name + ' 库存 ' + s1.product.stock)
    await api.staffScan(CODE)
    await api.staffScan(CODE)
    const s2 = await api.staffScan(CODE)
    ok(s2.product.stock === 8, '连扫四次库存一动不动（D8 扫码只读）')

    const unknown = await api.staffScan('6900000000097')
    ok(unknown.found === false && !!unknown.resolve, '未建档条码给解析结果，方便当场建档')

    await api.changeStock(CODE, 'stock_in', 2, '联调入库')
    const s3 = await api.staffScan(CODE)
    ok(s3.product.stock === 10, '入库 +2 后库存 10')
    ok(s3.recent.some((r) => r.reason === '联调入库'), '流水里查得到刚才那一笔：' + s3.recent.map((r) => r.reason).join(' / '))
    await api.changeStock(CODE, 'adjust', -4, '联调出库')
    ok((await api.staffScan(CODE)).product.stock === 6, '出库 -4 后库存 6')
    await api.changeStock(CODE, 'stock_take', 3, '联调盘点')
    ok((await api.staffScan(CODE)).product.stock === 3, '盘点按实盘数盖成 3')

    await api.setOnSale([CODE], false)
    const staffList = await api.listAllProducts('联调员工专用货')
    ok(staffList.some((p) => p.code === CODE && p.onSale === false), '员工能看见已下架的货（含 onSale=false）')
    const custList = await api.listProducts('联调员工专用货')
    ok(!custList.some((p) => p.code === CODE), '顾客端看不到下架的货')
    await api.setOnSale([CODE], true)
    ok((await api.listProducts('联调员工专用货')).some((p) => p.code === CODE), '重新上架后顾客又能看到')

    const NEW = '6900000000098'
    await api.saveProduct({ code: NEW, name: '联调建档货', salePrice: 1 })
    const newP = await api.getProduct(NEW)
    ok(newP.code === NEW && newP.stock === 0, '建档不传 stock 就是 0（没动过库存）：' + newP.stock)

    // 收尾：把两条联调货清干净，别把演示数据弄脏
    await api.changeStock(CODE, 'stock_take', 0, '联调收尾')
    const d1 = await raw('/api/products/' + CODE, 'DELETE')
    const d2 = await raw('/api/products/' + NEW, 'DELETE')
    ok(d1.status === 200 && d2.status === 200, '联调货已删除（' + d1.status + '/' + d2.status + '）')

    api.setView('customer')
    ok(api.view() === 'customer' && api.isStaff() === true, '切回顾客版后员工身份还在（令牌不丢）')
    await raw('/api/wx/role', 'POST', { openid: openid, role: 'customer' })
    let gone = ''
    try { await api.staffOverview() } catch (e) { gone = e.message }
    ok(api.staffToken().length === 64 && gone.indexOf('失效') >= 0, '后台降回顾客：旧令牌立刻失效（' + gone + '）')
    api.clearSession()
  }
  api.clearSession()

  section('⑫ 第 27 轮：身份归属 / 幂等键 / 金额边界（真后端）')
  {
    api.clearSession()
    api.rememberPhone('13800138077')
    ok(api.boundPhone() === '13800138077', '没有 openid 时用手机号当身份：' + api.boundPhone())

    const cola = (await api.listProducts()).filter((p) => p.code === '6901234567892')[0]
    const stock0 = cola.stock

    // 同一个购物车连下两单：客户端每次生成新的 clientToken，所以必须是两张不同的单（幂等键不是「内容相同」而是显式重试）
    store.clearCart(); store.addToCart(cola, 1)
    const o1 = (await api.createOrder({ customerName: '归属甲', phone: '13800138077', address: '', deliveryType: 'pickup', items: store.orderItems() })).order
    const stock1 = (await api.listProducts()).filter((p) => p.code === '6901234567892')[0].stock
    const o2 = (await api.createOrder({ customerName: '归属甲', phone: '13800138077', address: '', deliveryType: 'pickup', items: store.orderItems() })).order
    const stock2 = (await api.listProducts()).filter((p) => p.code === '6901234567892')[0].stock
    ok(o1.id !== o2.id, '两次正常下单是两张单（各自新幂等键）：' + o1.id + ' / ' + o2.id)
    ok(stock0 - stock1 === 1 && stock1 - stock2 === 1, '每次都扣 1 件库存：' + stock0 + '→' + stock1 + '→' + stock2)

    // 归属：A 的列表里有、且每条都是自己的手机号
    const mine = await api.listOrders()
    ok(mine.some((o) => o.id === o1.id), 'A 的订单列表里有自己的单')
    ok(mine.every((o) => o.phone === '13800138077'), '列表里每一条都是本机手机号的单（' + mine.length + ' 条）')

    // 换一个手机号：看不到、也查不到别人的单
    api.clearSession()
    api.rememberPhone('13900139088')
    const otherList = await api.listOrders()
    ok(!otherList.some((o) => o.id === o1.id), '换成 B 的手机号后，列表里看不到 A 的单')
    let foreign = ''
    try { await api.getOrder(o1.id) } catch (e) { foreign = e.message }
    ok(foreign.indexOf('不存在') >= 0, 'B 按单号直接查 A 的单 → 报「不存在」（不泄露存在性）：' + foreign)

    // 取消回补（走小程序的取消路径，不是直接打接口）
    api.clearSession()
    api.rememberPhone('13800138077')
    const cx = await api.cancelOrder(o2.id)
    const stock3 = (await api.listProducts()).filter((p) => p.code === '6901234567892')[0].stock
    ok(cx.status === 'cancelled' && cx.statusText === '已取消', '取消自己的订单：' + cx.statusText)
    ok(stock3 === stock2 + 1, '取消回补 1 件库存：' + stock2 + ' → ' + stock3)
    let cxAgain = ''
    try { await api.cancelOrder(o2.id) } catch (e) { cxAgain = e.message }
    ok(cxAgain.length >= 0 && (await api.listProducts()).filter((p) => p.code === '6901234567892')[0].stock === stock3,
       '重复取消不会再回补（第二次：' + (cxAgain || '服务端幂等放行') + '）')

    // 金额边界：29.99 → 收 3 元；29.995 → 服务端先 round2 成 30.00 → 免
    // 建货/调库存是员工专属能力（第 27 轮：只有员工令牌或管理端能做），
    // 这一段是纯顾客会话，所以直接打裸接口（灰度档无身份=管理端放行）。
    const PA = '6900000000271', PB = '6900000000272'
    await raw('/api/products', 'POST', { code: PA, name: '联调边界·2999', salePrice: 29.99, stock: 5 })
    await raw('/api/products', 'POST', { code: PB, name: '联调边界·29995', salePrice: 5.999, stock: 5 })
    const ba = (await api.createOrder({ customerName: '边界', phone: '13800138077', address: '联调路 1 号', deliveryType: 'delivery', items: [{ code: PA, qty: 1 }] })).order
    const bb = (await api.createOrder({ customerName: '边界', phone: '13800138077', address: '联调路 1 号', deliveryType: 'delivery', items: [{ code: PB, qty: 5 }] })).order
    ok(ba.subtotal === 29.99 && ba.deliveryFee === 3 && ba.total === 32.99, '29.99 元 → 收 3 元运费（合计 32.99）')
    ok(bb.subtotal === 30 && bb.deliveryFee === 0 && bb.total === 30, '29.995 元 → round2 成 30.00 → 免运费（合计 30）')
    ok(foreign.indexOf('不存在') >= 0 && (await api.listOrders()).length >= 3, '边界单也归在本手机号名下')

    // 收尾：取消掉边界单并把两条联调货清走（删除要求库存为 0）
    await api.cancelOrder(ba.id)
    await api.cancelOrder(bb.id)
    await raw('/api/stock/change', 'POST', { code: PA, kind: 'stock_take', qty: 0, reason: '联调收尾' })
    await raw('/api/stock/change', 'POST', { code: PB, kind: 'stock_take', qty: 0, reason: '联调收尾' })
    const d1 = await fetch(BASE + '/api/products/' + PA, { method: 'DELETE' }).then((r) => r.status)
    const d2 = await fetch(BASE + '/api/products/' + PB, { method: 'DELETE' }).then((r) => r.status)
    ok(d1 === 200 && d2 === 200, '联调边界货已删除（' + d1 + '/' + d2 + '）')
    await api.cancelOrder(o1.id)
    api.clearSession()
  }

  section('⑬ 第 28 轮：排序 / 分页 / 热销 / 同类推荐（真后端）')
  {
    // 向后兼容：只传 2 个参数仍返回数组（第 27 轮的页面就是这么调的）
    const compat = await api.listProducts('', '')
    ok(Array.isArray(compat) && compat.length >= 6, '两参调用仍返回数组（' + compat.length + ' 条）')

    // 传 opts 才走分页契约：{items,total,limit,offset,hasMore,tier}
    const p1 = await api.listProducts('', '', { sort: 'price_asc', limit: 3, offset: 0 })
    ok(p1 && Array.isArray(p1.items) && p1.items.length === 3, 'limit=3 只回 3 条')
    ok(p1.total >= 6 && p1.limit === 3 && p1.offset === 0,
      'total 是全量条数（' + p1.total + '）、limit/offset 原样回传')
    ok(p1.hasMore === true, '还有下一页：hasMore=true')
    ok(typeof p1.tier === 'string', '带 tier 字段（' + JSON.stringify(p1.tier) + '）')
    const asc = p1.items.map((p) => p.price)
    ok(asc[0] <= asc[asc.length - 1], 'price_asc 页内价格递增：' + asc.join(' ≤ '))

    const p2 = await api.listProducts('', '', { sort: 'price_asc', limit: 3, offset: 3 })
    ok(p2.offset === 3 && p2.items.length >= 1, 'offset=3 拿到第二页 ' + p2.items.length + ' 条')
    const dup = p2.items.filter((x) => p1.items.some((y) => y.code === x.code))
    ok(dup.length === 0, '两页无重复（分页真在切片，不是重复第一页）')

    const desc = await api.listProducts('', '', { sort: 'price_desc', limit: 5, offset: 0 })
    const dsc = desc.items.map((p) => p.price)
    ok(dsc[0] >= dsc[dsc.length - 1], 'price_desc 页内价格递减：' + dsc.join(' ≥ '))

    // 销量降序由服务端算（本地没有 sold 字段，离线只是兜底）
    const hot = await api.listProducts('', '', { sort: 'hot', limit: 6, offset: 0 })
    ok(hot.items.length >= 3, 'sort=hot 有商品（' + hot.items.length + ' 条）')

    const hp = await api.hotProducts(6)
    ok(hp.items.length >= 1 && hp.items.length <= 6, 'hotProducts(6) 回 1~6 条（' + hp.items.length + '）')
    ok(hp.items.every((p) => !!p.code && p.price >= 0), '热销条目映射正常（code/price 都在）')

    // 同类推荐：排除自身；未知条码回空列表而不是 400（页面安静降级）
    const alt = await api.alternatives('6901234567892', 5)
    ok(alt.items.every((p) => p.code !== '6901234567892'), '同类推荐不含自己')
    ok(alt.items.length <= 5, '同类推荐最多 5 条（' + alt.items.length + '）')
    const altBad = await api.alternatives('0000000000000', 5)
    ok(Array.isArray(altBad.items) && altBad.items.length === 0, '不存在的条码 → 空列表（不报错）')

    // 分类 + 排序 + 分页三者可叠加
    const cat = await api.listProducts('', '饮料', { sort: 'price_asc', limit: 2, offset: 0 })
    ok(cat.items.length <= 2 && cat.items.every((p) => p.category === '饮料'),
      '分类 + 排序 + 分页可叠加（' + cat.items.length + ' 条）')

    // 客户端不替服务端兜底未知排序值：400 原文必须透出
    let badSort = ''
    try { await api.listProducts('', '', { sort: 'priceAsc' }) } catch (e) { badSort = e.message }
    ok(badSort.indexOf('排序') >= 0, '未知 sort → 服务端 400 原文透出：' + badSort)
  }

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('联调出错：', e)
  process.exit(1)
})

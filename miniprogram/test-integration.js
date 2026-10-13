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
    const init = { method: method, headers: { 'content-type': 'application/json' } }
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
  store.clearCart()
  store.addToCart(cola, 2)
  const r = await api.createOrder({
    customerName: '联调顾客', phone: '13800138000', address: '',
    deliveryType: 'pickup', items: store.orderItems()
  })
  ok(r.local === false, '在线下单（local=false）')
  const o = r.order
  ok(o.id.charAt(0) === 'M', '订单号由服务端生成（M 开头）：' + o.id)
  ok(o.status === 'pending' && o.statusText === '待处理', '初始状态 pending/待处理')
  ok(o.subtotal === 5 && o.deliveryFee === 0 && o.total === 5, '自提：小计 5 + 配送 0 = 5')
  ok(o.items.length === 1 && o.items[0].qty === 2, '明细 1 行 ×2')
  ok(o.summary.indexOf('可口可乐') >= 0, '摘要：' + o.summary)

  const cola2 = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0]
  ok(cola2.stock === stockBefore - 2, '服务端扣了 2 件库存：' + stockBefore + ' → ' + cola2.stock)

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
  kv['sdy_mp_session'] = { openid: 'integration-test', phone: '13800001111', name: '王阿姨', tier: 'wholesale' }
  ok(api.boundPhone() === '13800001111', '注入会话手机号：' + api.boundPhone())
  const dw = await api.getProduct('6901234567892')
  ok(dw.tier === 'wholesale' && dw.price === 2.2, '批发顾客看到批发价 2.2（tier=' + dw.tier + '）')

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

  section('⑩ 订单状态机（配送→完成，非法迁移要拦）')
  store.clearCart()
  const colaNow = (await api.listProducts('可口可乐')).filter((p) => p.code === '6901234567892')[0]
  store.addToCart(colaNow, 1)
  const r2 = await api.createOrder({
    customerName: '状态测试', phone: '13800138000', address: '福建省福州市联调路 1 号',
    deliveryType: 'delivery', items: store.orderItems()
  })
  const o2 = r2.order
  ok(o2.deliveryFee === 3 && o2.total === 5.5, '送货不满 30 元加 3 元配送费：' + o2.total)
  const moving = await api.advanceOrder(o2.id, 'delivering')
  ok(moving.status === 'delivering' && moving.statusText === '配送中', '待处理→配送中')
  ok(moving.canAdvance === true && moving.canCancel === false, '配送中只给「确认收货」按钮')
  const fin = await api.advanceOrder(o2.id, 'done')
  ok(fin.status === 'done' && fin.statusText === '已完成', '配送中→已完成')
  ok(fin.canReorder === true, '已完成给「再来一单」按钮')
  let advErr = ''
  try { await api.advanceOrder(o2.id, 'ready') } catch (e) { advErr = e.message }
  ok(advErr.indexOf('状态不允许') >= 0, '已完成不能退回待自提：' + advErr)

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

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('联调出错：', e)
  process.exit(1)
})

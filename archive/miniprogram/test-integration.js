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

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('联调出错：', e)
  process.exit(1)
})

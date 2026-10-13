/* =====================================================================
 * 小程序页面冒烟测试（无开发者工具环境：假 wx + 假 Page 注册）
 *   覆盖：app.json 页面文件齐全 / 首页加购与分类 / 购物车算钱与校验 /
 *         下单（离线落本地）/ 订单列表与再来一单 / 我的页面改后端地址
 * 运行：node miniprogram/test-pages.js
 * ===================================================================== */
'use strict'
const fs = require('fs')
const path = require('path')

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
  return {
    _kv: kv,
    _calls: calls,
    toasts: [],
    tabs: [],
    getStorageSync: (k) => (k in kv ? kv[k] : ''),
    setStorageSync: (k, v) => { kv[k] = v },
    removeStorageSync: (k) => { delete kv[k] },
    showToast: function (o) { this.toasts.push(o && o.title) },
    switchTab: function (o) { this.tabs.push(o && o.url) },
    stopPullDownRefresh: () => {},
    showModal: (o) => { if (o && o.success) o.success({ confirm: true }) },
    request(opts) {
      const method = (opts.method || 'GET').toUpperCase()
      const full = String(opts.url).replace(/^https?:\/\/[^/]+/, '')
      const p = full.split('?')[0]
      calls.push({ method: method, path: full, data: opts.data })
      for (const r of routes) {
        if (r.method === method && (r.path === p || (r.re && r.re.test(p)))) {
          if (r.fail) { opts.fail({ errMsg: r.fail }); return }
          const payload = typeof r.body === 'function' ? r.body({ method: method, path: p, data: opts.data }) : r.body
          opts.success({ statusCode: r.status || 200, data: payload === undefined ? {} : payload })
          return
        }
      }
      opts.success({ statusCode: 404, data: { error: '无此路由: ' + p } })
    }
  }
}

const OFFLINE = [{ method: 'GET', path: '/healthz', fail: 'request:fail timeout' }]
const SERVER_PRODUCTS = [
  { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', unit: '罐', salePrice: 2.5, stock: 120 },
  { code: '6907992751797', name: '伊利纯牛奶', brand: '伊利', spec: '250ml 盒', category: '乳品', unit: '盒', salePrice: 3.5, stock: 80 }
]
const ONLINE = [
  { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: true, circuitOpen: false, cloudFails: 0 } },
  { method: 'GET', path: '/api/products', body: { items: SERVER_PRODUCTS, total: 2 } },
  { method: 'POST', path: '/api/orders', status: 201, body: { id: 'M1', customerName: '张三', phone: '13800138000', deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }], createdAt: '2026-10-11T02:30:00Z' } },
  { method: 'GET', path: '/api/orders', body: { items: [{ id: 'M1', customerName: '张三', phone: '13800138000', deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }], createdAt: '2026-10-11T02:30:00Z' }], total: 1 } }
]

/* ---------------- 页面加载器 ---------------- */
const ROOT = __dirname
let captured = null
global.Page = (def) => { captured = def }
const api = require('./utils/api.js')
const store = require('./utils/store.js')
global.getApp = () => ({ globalData: {}, refreshStatus: () => api.probe() })

function loadPage(rel) {
  captured = null
  delete require.cache[require.resolve(path.join(ROOT, rel))]
  require(path.join(ROOT, rel))
  if (!captured) throw new Error(rel + ' 没有调用 Page()')
  return makeInstance(captured)
}
function makeInstance(def) {
  const inst = Object.create(def)
  inst.data = JSON.parse(JSON.stringify(def.data || {}))
  inst.setData = function (o) { Object.assign(this.data, o) }
  return inst
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)) }

async function main() {
  /* ---------- ① 工程结构 ---------- */
  section('① 小程序工程结构')
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  ok(appJson.pages.length === 4, 'app.json 声明 4 个页面')
  ok(appJson.tabBar.list.length === 4, 'tabBar 4 个入口')
  let allOk = true
  appJson.pages.forEach((p) => {
    ;['.js', '.wxml', '.json'].forEach((ext) => { if (!exists(p + ext)) { allOk = false; console.log('    缺文件：' + p + ext) } })
  })
  ok(allOk, '每个页面都有 .js / .wxml / .json')
  ok(appJson.tabBar.list.every((t) => appJson.pages.indexOf(t.pagePath) >= 0), 'tabBar 指向的页面都在 pages 里')
  JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
  ok(true, 'project.config.json 是合法 JSON')
  ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'sitemap.json'), 'utf8')).rules.length > 0, 'sitemap.json 合法')
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  ok(appJs.indexOf('refreshStatus') > 0, 'app.js 暴露 refreshStatus（页面靠它探测后端）')

  /* ---------- ② 首页 ---------- */
  section('② 首页（离线上线都可用）')
  global.wx = mkWx(OFFLINE)
  let page = loadPage('pages/index/index.js')
  await page.onShow()
  ok(page.data.products.length === 6, '离线：展示 6 条演示商品')
  ok(page.data.statusLabel.indexOf('本地演示') >= 0, '离线：胶囊提示本地演示')
  page.onCategory({ currentTarget: { dataset: { cat: '饮料' } } })
  ok(page.data.products.length === 2 && page.data.products.every((p) => p.category === '饮料'), '按分类过滤到 2 条饮料')
  page.onCategory({ currentTarget: { dataset: { cat: '全部' } } })
  ok(page.data.products.length === 6, '切回「全部」恢复 6 条')
  page.onAdd({ currentTarget: { dataset: { code: '6901234567892' } } })
  ok(page.data.cartCount === 1 && page.data.cartAmountText === '2.50', '加购后角标 1 件 / ¥2.50')
  ok(global.wx.toasts.indexOf('已加入购物车') >= 0, '加购有 toast 反馈')

  // 扫码找货（只读，D8）：识别条码 → 填搜索框筛出来，绝不自动加购
  global.wx.scanCode = (o) => o.success({ result: '6901234567892' })
  const hitScan = await page.onScan()
  ok(hitScan && hitScan.found === true && hitScan.name === '可口可乐', '扫码命中本地演示商品')
  ok(page.data.keyword === '可口可乐', '扫码后搜索框填商品名：' + page.data.keyword)
  ok(page.data.products.length === 1 && page.data.products[0].code === '6901234567892', '扫码后列表筛到该商品')
  ok(page.data.cartCount === 1, '扫码只读：不自动加购（仍 1 件）')
  ok(global.wx.toasts.indexOf('已找到：可口可乐') >= 0, '扫码命中给出 toast 反馈')

  global.wx.scanCode = (o) => o.success({ result: '9999999999999' })
  const missScan = await page.onScan()
  ok(missScan && missScan.found === false, '未建档条码如实返回 not_found')
  ok(page.data.keyword === '9999999999999', '未建档时把条码填进搜索框，交老板人工看')
  ok(page.data.products.length === 0, '未建档 → 列表为空（不假装有货）')

  global.wx.scanCode = (o) => o.fail({ errMsg: 'scanCode:fail cancel' })
  const cancelScan = await page.onScan()
  ok(cancelScan === null, '用户取消扫码 → 返回 null，不打扰')
  ok(page.data.keyword === '9999999999999' && page.data.products.length === 0, '取消扫码不改页面数据')

  page.goCart()
  ok(global.wx.tabs.indexOf('/pages/cart/cart') >= 0, '「去购物车」切到购物车 tab')

  global.wx = mkWx(ONLINE)
  page = loadPage('pages/index/index.js')
  await page.onShow()
  ok(page.data.online === true, '在线：online=true')
  ok(page.data.products.length === 2 && page.data.products[0].server === true, '在线：商品来自服务端（2 条）')
  ok(page.data.statusLabel === '🟢 后端已连接', '在线：胶囊显示已连接')

  /* ---------- ③ 购物车 / 下单 ---------- */
  section('③ 购物车与下单')
  global.wx = mkWx(OFFLINE)
  store.clearCart()
  store.addToCart({ code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', unit: '罐', emoji: '🥤', salePrice: 2.5 }, 2)
  store.addToCart({ code: '6907992751797', name: '伊利纯牛奶', spec: '250ml 盒', unit: '盒', emoji: '🥛', salePrice: 3.5 }, 10)
  let cart = loadPage('pages/cart/cart.js')
  await cart.onShow()
  ok(cart.data.lines.length === 2, '购物车两行')
  ok(cart.data.subtotalText === '40.00', '小计 5 + 35 = 40.00')
  ok(cart.data.feeText === '0.00', '默认送货且满 30 → 免配送费')
  ok(cart.data.totalText === '40.00', '合计 40.00')
  ok(cart.data.feeHint === '已满 30 元，免配送费', '提示免配送费')
  cart.onDelivery({ currentTarget: { dataset: { kind: 'pickup' } } })
  ok(cart.data.feeHint === '自提免配送费', '切自提后提示自提免费')
  cart.onDelivery({ currentTarget: { dataset: { kind: 'delivery' } } })
  cart.onQty({ currentTarget: { dataset: { code: '6907992751797', delta: -6 } } })
  ok(cart.data.subtotalText === '19.00', '牛奶减到 4 盒 → 小计 19.00')
  ok(cart.data.feeText === '3.00' && cart.data.totalText === '22.00', '未满 30 → 配送费 3 元，合计 22.00')
  cart.onQty({ currentTarget: { dataset: { code: '6907992751797', delta: 6 } } })
  cart.onRemove({ currentTarget: { dataset: { code: '6907992751797' } } })
  ok(cart.data.lines.length === 1 && cart.data.subtotalText === '5.00', '删掉牛奶只剩可乐 5.00')
  cart.onClear()
  ok(cart.data.empty === true, '清空后显示空态')

  // 校验：手机号不合法不发单
  store.addToCart({ code: '6901234567892', name: '可口可乐', salePrice: 2.5 }, 2)
  await cart.onShow()
  cart.onName({ detail: { value: '张三' } })
  cart.onPhone({ detail: { value: '138' } })
  const before = global.wx._calls.filter((c) => c.method === 'POST').length
  await cart.submit()
  ok(global.wx.toasts.indexOf('请填写 11 位手机号') >= 0, '手机号不合法给出提示')
  ok(global.wx._calls.filter((c) => c.method === 'POST').length === before, '校验不过不发请求')

  // 校验：送货上门必须要地址
  cart.onPhone({ detail: { value: '13800138000' } })
  await cart.submit()
  ok(global.wx.toasts.indexOf('送货上门需要地址') >= 0, '配送单缺地址被拦下')

  // 离线下单：本地记一笔，不冒充进系统
  cart.onAddress({ detail: { value: '3 栋 502' } })
  const r = await cart.submit()
  ok(r && String(r.id).charAt(0) === 'L', '离线下单返回本地订单号（L 开头，未入库）：' + (r && r.id))
  ok(cart.data.empty === true && store.cartCount() === 0, '下单后购物车清空')
  ok(store.getCustomer().phone === '13800138000', '收货信息被记住（下次自动填）')
  ok(global.wx.toasts.some((t) => t && t.indexOf('本地演示') >= 0), '离线明确提示未入库：' + global.wx.toasts[global.wx.toasts.length - 1])

  /* ---------- ④ 订单页 ---------- */
  section('④ 我的订单')
  let orders = loadPage('pages/orders/orders.js')
  await orders.onShow()
  ok(orders.data.orders.length === 1, '离线订单列表读到本地那笔')
  ok(orders.data.orders[0].statusText === '待处理', '状态文案：待处理')
  ok(orders.data.orders[0].deliveryText === '送货上门', '配送方式：送货上门')
  ok(orders.data.orders[0].summary.indexOf('可口可乐') >= 0, '摘要含商品名：' + orders.data.orders[0].summary)
  const oid = orders.data.orders[0].id
  orders.onReorder({ currentTarget: { dataset: { id: oid } } })
  ok(store.cartCount() === 2, '「再来一单」把 2 件放回购物车')
  await orders.onCancel({ currentTarget: { dataset: { id: oid } } })
  ok(orders.data.orders[0].statusText === '已取消', '确认后订单变已取消')

  global.wx = mkWx(ONLINE)
  orders = loadPage('pages/orders/orders.js')
  await orders.onShow()
  ok(orders.data.orders.length === 1 && orders.data.orders[0].id === 'M1', '在线：订单来自服务端')

  /* ---------- ⑤ 我的 ---------- */
  section('⑤ 我的（连接状态 + 后端地址）')
  global.wx = mkWx(OFFLINE)
  const mine = loadPage('pages/mine/mine.js')
  await mine.onShow()
  ok(mine.data.statusLabel.indexOf('本地演示') >= 0, '显示当前状态')
  ok(mine.data.statusDetail.indexOf('不会入库') > 0, '说明离线下单不入库')
  ok(mine.data.shop.name === '小邻里超市', '店铺信息就位')
  mine.onBase({ detail: { value: 'http://192.168.1.9:8093' } })
  await mine.saveBase()
  ok(api.base() === 'http://192.168.1.9:8093', '保存后 base 生效：' + api.base())
  ok(global.wx.toasts.indexOf('保存了，但还没连上') >= 0, '保存后仍连不上会如实提示')
  mine.goOrders()
  ok(global.wx.tabs.indexOf('/pages/orders/orders') >= 0, '我的 → 订单 tab')

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错：', e)
  process.exit(1)
})

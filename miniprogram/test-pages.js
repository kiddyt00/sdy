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
    navs: [],
    titles: [],
    previews: [],
    badges: [],
    clipboard: [],
    calls2: [],
    back: 0,
    redirs: [],
    relaunches: [],
    scans: [],
    getStorageSync: (k) => (k in kv ? kv[k] : ''),
    setStorageSync: (k, v) => { kv[k] = v },
    removeStorageSync: (k) => { delete kv[k] },
    showToast: function (o) { this.toasts.push(o && o.title) },
    switchTab: function (o) { this.tabs.push(o && o.url) },
    navigateTo: function (o) { this.navs.push(o && o.url) },
    navigateBack: function () { this.back++ },
    // 员工端要用的三个：跳转（底栏/扫码台）、重启（进工作台）、扫码（69 码）
    redirectTo: function (o) { this.redirs.push(o && o.url) },
    reLaunch: function (o) { this.relaunches.push(o && o.url) },
    scanCode: function (o) {
      this.scans.push({ scanType: (o && o.scanType) || [], onlyFromCamera: !!(o && o.onlyFromCamera) })
      if (this._scanFail) { if (o && o.fail) o.fail({ errMsg: 'scanCode:fail cancel' }); return }
      if (o && o.success) o.success({ result: this._scanResult || '6901234567890' })
    },
    setNavigationBarTitle: function (o) { this.titles.push(o && o.title) },
    previewImage: function (o) { this.previews.push(o && o.urls) },
    setTabBarBadge: function (o) { this.badges.push(o) },
    removeTabBarBadge: function (o) { this.badges.push({ removed: o && o.index }) },
    setClipboardData: function (o) { this.clipboard.push(o && o.data) },
    makePhoneCall: function (o) { this.calls2.push(o && o.phoneNumber) },
    stopPullDownRefresh: () => {},
    login: function (o) {
      this._calls.push({ method: 'LOGIN', path: 'wx.login', data: null })
      if (this._loginFail) { if (o && o.fail) o.fail({ errMsg: this._loginFail }); return }
      if (o && o.success) o.success({ code: this._loginCode || 'CODE_PAGE' })
    },
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
const rules = require('./utils/rules.js')
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
  // 真机 setData 支持第二个回调参数（库存页的「只看低库存」靠它重排）
  inst.setData = function (o, cb) {
    Object.assign(this.data, o)
    if (typeof cb === 'function') cb()
  }
  return inst
}
function exists(rel) { return fs.existsSync(path.join(ROOT, rel)) }

async function main() {
  /* ---------- ① 工程结构 ---------- */
  section('① 小程序工程结构')
  const appJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  ok(appJson.pages.length === 15, 'app.json 声明 15 个页面（10 顾客 + 5 员工）')
  ok(appJson.tabBar.list.length === 5, 'tabBar 5 个入口')
  let allOk = true
  appJson.pages.forEach((p) => {
    ;['.js', '.wxml', '.json', '.wxss'].forEach((ext) => { if (!exists(p + ext)) { allOk = false; console.log('    缺文件：' + p + ext) } })
  })
  ok(allOk, '每个页面都有 .js / .wxml / .json / .wxss')
  ok(appJson.tabBar.list.every((t) => appJson.pages.indexOf(t.pagePath) >= 0), 'tabBar 指向的页面都在 pages 里')
  JSON.parse(fs.readFileSync(path.join(ROOT, 'project.config.json'), 'utf8'))
  ok(true, 'project.config.json 是合法 JSON')
  ok(JSON.parse(fs.readFileSync(path.join(ROOT, 'sitemap.json'), 'utf8')).rules.length > 0, 'sitemap.json 合法')
  const appJs = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8')
  ok(appJs.indexOf('refreshStatus') > 0, 'app.js 暴露 refreshStatus（页面靠它探测后端）')

  /* ---------- ①.1 Vant 接入（手搓 miniprogram_npm，必须在盘上） ---------- */
  section('①.1 Vant Weapp 接入')
  ok(exists('miniprogram_npm/@vant/weapp/button/index.wxml'), 'miniprogram_npm 里有 Vant 实体（手搓构建）')
  ok(!!appJson.usingComponents && Object.keys(appJson.usingComponents).length >= 12,
    'app.json 全局声明了 ' + Object.keys(appJson.usingComponents || {}).length + ' 个 Vant 组件')
  let vMiss = []
  Object.keys(appJson.usingComponents || {}).forEach((tag) => {
    const rel = appJson.usingComponents[tag].replace(/^@vant\/weapp\//, 'miniprogram_npm/@vant/weapp/')
    ;['.js', '.json', '.wxml'].forEach((ext) => { if (!exists(rel + ext)) vMiss.push(rel + ext) })
  })
  ok(vMiss.length === 0, '每个声明过的 van-* 在 miniprogram_npm 里都有实体' + (vMiss.length ? '（缺 ' + vMiss.slice(0, 3).join(' / ') + '）' : ''))
  ok((appJson.usingComponents || {})['van-button'] === '@vant/weapp/button/index', 'usingComponents 用官方 @vant/weapp/<name>/index 路径')

  // 模板里出现的 van-* 必须声明过，否则真机/工具里是 "component not found" 白屏
  const declared = Object.keys(appJson.usingComponents || {})
  const usedTags = {}
  const readWxmls = [''].concat(appJson.pages).map((p) => (p ? p + '.wxml' : 'app.wxml')).filter((f) => exists(f))
  readWxmls.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    const m = src.match(/<van-[a-z0-9-]+/g) || []
    m.forEach((t) => { usedTags[t.slice(1)] = (usedTags[t.slice(1)] || 0) + 1 })
  })
  const undeclared = Object.keys(usedTags).filter((t) => declared.indexOf(t) < 0)
  ok(undeclared.length === 0, '页面里用到的 ' + Object.keys(usedTags).length + ' 个 van-* 都已在 app.json 声明' + (undeclared.length ? '（漏 ' + undeclared.join(',') + '）' : ''))

  // wxs 引用要真的存在（tools.wxs 负责价格格式化）
  let wxsMiss = []
  readWxmls.forEach((f) => {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8')
    ;(src.match(/<wxs[^>]*src="([^"]+)"/g) || []).forEach((line) => {
      const rel = line.match(/src="([^"]+)"/)[1].replace(/^\.\.\/\.\.\//, '').replace(/^\.\//, '')
      if (!exists(rel)) wxsMiss.push(f + ' → ' + rel)
    })
  })
  ok(wxsMiss.length === 0, 'wxs 引用都存在' + (wxsMiss.length ? '（缺 ' + wxsMiss.join(', ') + '）' : ''))

  // 品牌主题：app.wxss 把 Vant 主色改成了店里那支绿
  const appWxss = fs.readFileSync(path.join(ROOT, 'app.wxss'), 'utf8')
  ok(appWxss.indexOf('--brand: #16a34a') > 0, 'app.wxss 定义了品牌绿')
  ok(appWxss.indexOf('--button-primary-background-color: #16a34a') > 0, 'Vant 主按钮被改成品牌绿')
  ok(appWxss.indexOf('button::after') > 0, '抹平了原生 button 的默认边框')

  // 原生 input 自带 1.4rem(=56rpx) 默认高度，再叠上下 padding 会被 box-sizing 压成 24rpx
  // 内容区 → 字只露上半截（老板在购物车三个输入框里看到的）。必须写死 height + line-height。
  const inputCss = (appWxss.match(/\.input\s*\{[\s\S]*?\}/) || [''])[0]
  ok(/height:\s*80rpx/.test(inputCss), '.input 写死高度（原生 input 默认高度不够）')
  ok(/line-height:\s*78rpx/.test(inputCss), '.input 写死 line-height（字才不会只露上半截）')
  ok(/padding:\s*0\s+20rpx/.test(inputCss), '.input 纵向 padding 归零（高度交给 height 管）')

  /* ---------- ② 首页 ---------- */
  section('② 首页（离线上线都可用）')
  global.wx = mkWx(OFFLINE)
  let page = loadPage('pages/index/index.js')
  await page.onShow()
  ok(page.data.products.length === 6, '离线：展示 6 条演示商品')
  ok(page.data.online === false, '离线：online=false（首页只显示灰点）')
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
  // 第 25 轮（D31）：连接状态只留一个小圆点，页面不再出现「后端已连接」这种开发信息
  const indexWxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')
  ok(indexWxml.indexOf('sdot') > 0 && indexWxml.indexOf('statusLabel') < 0, '首页店铺条只有状态圆点，不显示状态文案')
  ok(indexWxml.indexOf('后端已连接') < 0 && indexWxml.indexOf('class="badge') < 0, '首页不再出现「后端已连接」胶囊')
  // 全页面扫一遍：顾客端不许出现连接状态这类开发文案（第 25 轮收口⑤后，顾客端连调试面板都没有了）
  const appJsonAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  const devWords = ['后端已连接', '后端连接', '探测中', 'statusLabel', '开发者选项', '调试面板']
  const offenders = []
  appJsonAll.pages.forEach((p) => {
    const wxml = fs.readFileSync(path.join(ROOT, p + '.wxml'), 'utf8')
    devWords.forEach((w) => {
      if (wxml.indexOf(w) >= 0) offenders.push(p + ' → ' + w)
    })
  })
  ok(offenders.length === 0, '10 个页面都不出现开发信息' + (offenders.length ? '：' + offenders.join(' / ') : '（干净）'))
  const dotPages = appJsonAll.pages.filter((p) => {
    const wxml = fs.readFileSync(path.join(ROOT, p + '.wxml'), 'utf8')
    return wxml.indexOf('cdot') >= 0 || wxml.indexOf('mdot') >= 0
  })
  ok(dotPages.length === 4, '首页 / 购物车 / 订单 / 我的 都只留小圆点：' + dotPages.join(' , '))

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
  ok(orders.data.orders[0].statusText === '待备货', '状态文案：待备货（第 27 轮与 Web 归一）')
  ok(orders.data.orders[0].deliveryText === '送货上门', '配送方式：送货上门')
  ok(orders.data.orders[0].summary.indexOf('可口可乐') >= 0, '摘要含商品名：' + orders.data.orders[0].summary)
  const oid = orders.data.orders[0].id
  orders.onReorder({ currentTarget: { dataset: { id: oid } } })
  ok(store.cartCount() === 2, '「再来一单」把 2 件放回购物车')
  await orders.onCancel({ currentTarget: { dataset: { id: oid } } })
  ok(orders.data.orders[0].statusText === '已取消', '确认后订单变已取消')

  global.wx = mkWx(ONLINE)
  // 第 27 轮：订单/地址接口按身份过滤，换回在线后要重新带上手机号（换假 wx 会换掉本地存储）
  api.rememberPhone('13800138000')
  orders = loadPage('pages/orders/orders.js')
  await orders.onShow()
  ok(orders.data.orders.length === 1 && orders.data.orders[0].id === 'M1', '在线：订单来自服务端')
  // 第 25 轮收口③：6 个状态标签（全部→已取消）不许顶出屏幕。
  // Vant 默认 swipe-threshold=5，6 个标签会走「横向滚动」分支（每格 22% → 溢出），改成 6 让它等分。
  const ordersWxml = fs.readFileSync(path.join(ROOT, 'pages/orders/orders.wxml'), 'utf8')
  const ordersWxss = fs.readFileSync(path.join(ROOT, 'pages/orders/orders.wxss'), 'utf8')
  ok(/swipe-threshold="\{\{6\}\}"/.test(ordersWxml), '订单状态条 6 个标签等分排下（swipe-threshold=6），不横向溢出')
  ok(/van-tabs\s*\{[\s\S]*?--tab-font-size:\s*23rpx/.test(ordersWxss), '标签字号压到 23rpx，六格排得更紧凑')
  const tabLabels = rules.STATUS_TABS.map((t) => t.label)
  ok(tabLabels.length === 6 && tabLabels[5] === '已取消', '状态标签仍是 6 个（全部 → 已取消）：' + tabLabels.join(' / '))

  /* ---------- ⑤ 我的 ---------- */
  section('⑤ 我的（连接状态 + 登录区）')
  global.wx = mkWx(OFFLINE)
  const mine = loadPage('pages/mine/mine.js')
  await mine.onShow()
  ok(mine.data.online === false, '离线：连接状态为 false（页面上只显示灰点）')
  ok(mine.data.statusDetail === undefined && mine.data.apiBase === undefined && mine.data.devMode === undefined,
    '页面 data 里不再留调试面板字段（devMode / statusDetail / apiBase）')
  ok(mine.data.shop.name === '啥都有快送', '店铺信息就位')
  mine.goOrders()
  ok(global.wx.tabs.indexOf('/pages/orders/orders') >= 0, '我的 → 订单 tab')
  // 第 25 轮（D31）：头像必须是正圆——button 的默认 padding / 行高 / ::after 边框不重置就会变成椭圆
  const mineWxml = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')
  const mineWxss = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxss'), 'utf8')
  ok(mineWxml.indexOf('后端连接') < 0 && mineWxml.indexOf('mdot') > 0, '不再显示「后端连接」一行，只留状态圆点')
  ok(mineWxml.indexOf('type="number"') < 0, '登录卡里不再有手机号输入框')
  ok(mineWxml.indexOf('open-type="chooseAvatar"') > 0 && mineWxml.indexOf('type="nickname"') > 0, '用微信官方「头像昵称填写能力」')
  // 头像只留顶部一个（登录卡里再放一个就会出现两个头像）
  const avatarBtns = mineWxml.split('open-type="chooseAvatar"').length - 1
  ok(avatarBtns === 1, '头像只显示一处，不重复：chooseAvatar 出现 ' + avatarBtns + ' 次')
  ok(mineWxss.indexOf('.lavbtn') < 0 && mineWxss.indexOf('.lav ') < 0, '登录卡里的第二个头像样式已清掉')
  // 第 25 轮收口④：头像不再可点（去掉「更换头像」）——可见的圆容器是纯 view/image，
  // 身上不再挂 button；chooseAvatar 挪到绿色框里的登录按钮上（微信唯一允许拿真实头像的入口）。
  ok(mineWxml.indexOf('mavatar-wrap') > 0 && mineWxml.indexOf('mavatar-hit') < 0 && mineWxml.indexOf('mavatar-btn') < 0,
    '头像＝纯 view 圆容器（不再套 button、不能点）')
  ok(mineWxss.indexOf('.mavatar-hit') < 0, '透明点击层样式已删除')
  ok(!/mavatar-wrap[\s\S]{0,240}open-type/.test(mineWxml), '圆头像身上没有任何 open-type（点它不弹头像选择器）')
  ok(/class="lbtn"[^>]*open-type="chooseAvatar"[^>]*bindchooseavatar="onChooseAvatar"/.test(mineWxml),
    '登录按钮本身就是微信头像选择按钮（选头像与登录合成一步）')
  ok(mineWxml.indexOf('换头像') < 0 && mineWxml.indexOf('点头像') < 0, '页面不再有任何「换头像」的说法')
  // 独立登录卡删掉，登录行搬进绿色框（老板：「有点功能冗余，直接把登录做在绿色框就行了」）
  ok(mineWxml.indexOf('mcard login') < 0 && mineWxml.indexOf('class="linput"') < 0 && mineWxss.indexOf('.linput') < 0,
    '绿色框下面那张「微信登录」卡已删除（功能冗余）')
  ok(mineWxml.indexOf('class="mlogin"') > mineWxml.indexOf('class="mhead"') &&
     mineWxml.indexOf('class="mlogin"') < mineWxml.indexOf('class="mgrid"'),
    '登录行 .mlogin 就在绿色框 .mhead 里面')
  ok(mineWxml.indexOf('class="mrow"') > 0, '身份行 .mrow（头像 + 昵称 + 状态点）')
  ok(mineWxml.indexOf('保存头像昵称') < 0 && mineWxml.indexOf('微信头像昵称') < 0,
    '没有「微信头像昵称」卡与保存按钮：登录即用微信头像昵称')
  // 第 25 轮收口③⑤：调试面板整块删除——顾客端不许有任何开发入口。
  // （老板先要求「开发者选项」不能显示，再要求「长按版本号进面板」这个功能也不要了。）
  ok(mineWxml.indexOf('开发者选项') < 0 && mineWxml.indexOf('mf-dev') < 0 && mineWxss.indexOf('.mf-dev') < 0,
    '「我的」页不再出现可见的「开发者选项」入口')
  ok(mineWxml.indexOf('bindlongpress') < 0 && mineWxml.indexOf('toggleDev') < 0 && mineWxml.indexOf('devMode') < 0,
    '长按版本号进调试面板的入口也删掉了（老板：这个功能也不需要）')
  ok(mineWxml.indexOf('调试面板') < 0 && mineWxml.indexOf('dtitle') < 0 && mineWxss.indexOf('.dtitle') < 0 &&
     mineWxml.indexOf('statusDetail') < 0 && mineWxml.indexOf('后端地址') < 0,
    '调试面板整块删除（含后端地址输入框与状态详情）')
  ok(typeof mine.toggleDev !== 'function' && typeof mine.onBase !== 'function' &&
     typeof mine.saveBase !== 'function' && typeof mine.clearAll !== 'function',
    '页面也不再暴露调试面板的方法')
  ok(mineWxml.indexOf('>退出登录<') > 0 && mineWxml.indexOf('class="mcard exit"') > 0,
    '「退出登录」留在顾客区（它是顾客的正常功能）')

  /* ---------- ⑥ 我的：微信登录（不绑手机号） ---------- */
  section('⑥ 我的（微信登录：只要 openid + 头像昵称）')
  const LOGIN_ROUTE = {
    method: 'POST', path: '/api/wx/login',
    body: { ok: true, openid: 'o_page_1', bound: false, phone: '', name: '', nickname: '阿明', avatar: '', tier: 'retail' }
  }
  const PROFILE_ROUTE = {
    method: 'POST', path: '/api/wx/profile',
    body: { ok: true, openid: 'o_page_1', nickname: '阿明', avatar: '' }
  }
  global.wx = mkWx(ONLINE.concat([LOGIN_ROUTE, PROFILE_ROUTE]))
  const acc = loadPage('pages/mine/mine.js')
  await acc.onShow()
  ok(acc.data.loggedIn === false && acc.data.sessionLabel.indexOf('未登录') >= 0, '未登录：如实显示未登录')
  // 第 25 轮（D31）：登录不再问手机号，选好昵称直接登
  acc.onNickname({ detail: { value: '阿明' } })
  const logged = await acc.doLogin()
  ok(!!logged && logged.openid === 'o_page_1', '不填手机号也能登录，拿到 openid')
  ok(acc.data.loggedIn === true, '登录后页面切到已登录态')
  ok(acc.data.bound === undefined && acc.data.phone === undefined, '登录态里不再有手机号字段')
  ok(acc.data.sessionPhone === '' && api.boundPhone() === '', '登录不带手机号：会话里没手机号')
  ok(acc.data.sessionLabel.indexOf('手机号下单时再填') > 0, '如实说明手机号下单时再填：' + acc.data.sessionLabel)
  ok(acc.data.tierText === '零售', '等级由服务端下发（登录不提权）')
  ok(acc.data.busy === false, '登录成功后复位 busy')
  ok(global.wx.toasts.filter((t) => String(t).indexOf('登录成功') === 0).length === 1, '有且只有一次登录成功提示')
  // 第 25 轮收口④：登录按钮＝头像按钮——选完头像立刻登录（不再有「更换头像」这个独立动作）
  const beforeLogin = global.wx._calls.filter((c) => c.path === '/api/wx/login').length
  const av = await acc.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_av.png' } })
  ok(!!av && av.openid === 'o_page_1', '选完头像自动完成登录（拿到 openid）')
  ok(global.wx._calls.filter((c) => c.path === '/api/wx/login').length === beforeLogin + 1, '选头像那一下只发一次登录请求')
  ok(acc.data.avatar === 'wxfile://tmp_av.png', '选中头像后立刻显示')
  ok(global.wx._kv['sdy_mp_avatar'] === 'wxfile://tmp_av.png', '头像落到本机缓存，重启不丢')
  ok(typeof acc.saveProfile !== 'function' && typeof acc.pushProfile !== 'function', '页面没有「保存头像昵称」的方法（没有保存入口）')
  const wf = global.wx._calls.filter((c) => c.path === '/api/wx/login').pop()
  ok(wf && wf.data.nickname === '阿明', '登录 body 带上昵称：' + JSON.stringify(wf && wf.data.nickname))
  ok(wf && !wf.data.avatar, '本机路径（wxfile://）不回传服务端：服务端只认 http(s)')
  await acc.onChooseAvatar({ detail: { avatarUrl: 'https://mall.shadouyou.cloud/a.png' } })
  const httpLogin = global.wx._calls.filter((c) => c.path === '/api/wx/login').pop()
  ok(httpLogin && httpLogin.data.avatar === 'https://mall.shadouyou.cloud/a.png', 'http(s) 头像随登录一起交给服务端')
  // 下单时记住手机号（手机号是价格身份与地址簿钥匙，D24/D31）
  ok(api.boundPhone() === '', '下单前会话里没有手机号')
  api.rememberPhone('13800001111')
  ok(api.boundPhone() === '13800001111', '下单填过的手机号被记住，价格与地址簿才能用')
  // 退出登录
  await acc.doLogout()
  ok(acc.data.loggedIn === false, '退出后回到未登录')
  ok(acc.data.avatar === '' && !global.wx._kv['sdy_mp_avatar'],
    '退出登录后头像必须清掉（绿色框里不许再挂着上一个人的头像）')
  ok(acc.data.nickname === '', '退出登录后昵称也清掉')
  ok(global.wx.toasts.indexOf('已退出登录') >= 0, '退出有明确提示')

  /* ---------- ⑦ 商品详情（浏览 → 详情 → 加购 / 立即购买） ---------- */
  section('⑦ 商品详情页')
  global.wx = mkWx(OFFLINE)
  await api.probe() // 真机上 app.onLaunch 先探一次，页面才知道离线还是在线
  const goods = loadPage('pages/goods/goods.js')
  await goods.onLoad({ code: '6901234567892' })
  ok(goods.data.p && goods.data.p.name === '可口可乐', '离线也能看详情（本地演示商品）')
  ok(goods.data.tierText === '零售' && goods.data.tierHint === '', '零售顾客看不到「按批发价」这类话')
  ok(global.wx.titles.indexOf('可口可乐') >= 0, '标题改成商品名')
  goods.onStep({ detail: 3 })
  ok(goods.data.qty === 3, '步进器数量：3')
  goods.addCart()
  ok(store.cartCount() === 3, '详情页加购 3 件')
  ok(global.wx.toasts.indexOf('已加入购物车') >= 0, '加购有明确提示')
  // 超库存要拦住
  store.clearCart()
  goods.onStep({ detail: 999 })
  goods.addCart()
  ok(store.cartCount() === 0 && String(global.wx.toasts[global.wx.toasts.length - 1]).indexOf('只剩') >= 0, '超过库存不让加：' + global.wx.toasts[global.wx.toasts.length - 1])
  // 立即购买：直通结算（tab 页不能 navigateTo）
  goods.onStep({ detail: 2 })
  goods.buyNow()
  ok(global.wx.tabs.indexOf('/pages/cart/cart') >= 0, '立即购买跳到购物车')
  const bn = store.takeBuyNow()
  ok(bn.length === 1 && bn[0].qty === 2, '立即购买把那一件带进结算')
  ok(bn[0].price === 2.5, '结算单价用服务端算好的有效价（D24）')

  global.wx = mkWx(OFFLINE)
  store.setBuyNow([{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2, unit: '罐' }])
  const bc = loadPage('pages/cart/cart.js')
  await bc.onShow()
  ok(bc.data.buyNow === true && bc.data.lines.length === 1 && bc.data.lines[0].qty === 2, '购物车进入「立即购买」模式，只结算那一件')
  ok(store.cartCount() === 0, '立即购买不污染购物车')

  /* ---------- ⑧ 分类页 ---------- */
  section('⑧ 分类页（左分类 + 右商品）')
  global.wx = mkWx(OFFLINE)
  const cate = loadPage('pages/category/category.js')
  await cate.onShow()
  ok(cate.data.cats.length === 5, '离线按商品自身分类归出 5 类')
  await cate.onSelect({ currentTarget: { dataset: { name: '饮料' } } })
  ok(cate.data.products.length === 2 && cate.data.products.every((p) => p.category === '饮料'), '选「饮料」→ 2 件')
  cate.onAdd({ currentTarget: { dataset: { code: '6901234567892' } } })
  ok(store.cartCount() === 1, '分类页可以直接加购')
  cate.onAdd({ currentTarget: { dataset: { code: '不存在的码' } } })
  ok(store.cartCount() === 1, '不存在的条码不会加进购物车')
  cate.goDetail({ currentTarget: { dataset: { code: '6901234567892' } } })
  ok(global.wx.navs.indexOf('/pages/goods/goods?code=6901234567892') >= 0, '点商品进详情')
  cate.goSearch()
  ok(global.wx.navs.indexOf('/pages/search/search') >= 0, '分类页能进搜索')

  /* ---------- ⑨ 搜索页 ---------- */
  section('⑨ 搜索页（历史 + 防抖 + 结果）')
  global.wx = mkWx(OFFLINE)
  const sea = loadPage('pages/search/search.js')
  sea.onLoad()
  await sea.onShow()
  ok(sea.data.hot.length > 0, '热门词就位')
  sea.onInput({ detail: { value: '可乐' } })
  const hit = await sea.doSearch(true)
  ok(hit.length === 1 && hit[0].name === '可口可乐', '搜「可乐」命中可口可乐')
  ok(sea.data.hist[0] === '可乐', '搜索词写进历史第一条')
  await sea.doSearch(true)
  ok(sea.data.hist.filter((x) => x === '可乐').length === 1, '重复搜同一个词不会堆历史')
  sea.onInput({ detail: { value: '莫须有的商品' } })
  const none = await sea.doSearch(false)
  ok(none.length === 0 && sea.data.empty === true, '搜不到时给空态')
  sea.onClear()
  ok(sea.data.keyword === '' && sea.data.searched === false, '清空输入回到热门/历史')
  sea.tapWord({ currentTarget: { dataset: { w: '啤酒' } } })
  ok(sea.data.keyword === '啤酒', '点热门词直接搜')
  sea.goDetail({ currentTarget: { dataset: { code: '6901001100113' } } })
  ok(global.wx.navs.indexOf('/pages/goods/goods?code=6901001100113') >= 0, '搜索结果进详情')
  sea.clearHist()
  ok(sea.data.hist.length === 0, '历史可以一键清空')

  /* ---------- ⑩ 订单详情 ---------- */
  section('⑩ 订单详情页')
  global.wx = mkWx(OFFLINE)
  const made = await api.createOrder({
    customerName: '张三', phone: '13800138000', deliveryType: 'pickup',
    items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }]
  })
  const oid2 = made.order.id
  const od = loadPage('pages/order/order.js')
  od.onLoad({ id: oid2 })
  await od.onShow()
  ok(od.data.o && od.data.o.id === oid2, '按订单号查到详情')
  ok(od.data.o.statusText === '待备货', '状态文案：待备货（第 27 轮与 Web 归一）')
  ok(od.data.o.canCancel === true && od.data.o.canAdvance === false, '待备货只给「取消订单」')
  ok(od.data.o.items[0].emoji && od.data.o.items[0].emoji.length > 0, '订单行没有图就用名字回推 emoji')
  od.copyId()
  ok(global.wx.clipboard[0] === oid2, '订单号可复制')
  await od.onCancel()
  ok(od.data.o.statusText === '已取消', '取消后详情同步为已取消')
  ok(od.data.o.canReorder === true, '已取消的单可以「再来一单」')
  od.onReorder()
  ok(store.cartCount() === 2, '再来一单把 2 件放回购物车')

  /* ---------- ⑪ 地址簿 ---------- */
  section('⑪ 地址簿（手机号即身份）')
  global.wx = mkWx(OFFLINE)
  const noLogin = loadPage('pages/address/list.js')
  noLogin.onLoad({ pick: '1' })
  await noLogin.onShow()
  ok(noLogin.data.loggedIn === false && noLogin.data.list.length === 0, '没绑手机号：如实说不给用')

  const ADDR_ROUTES = ONLINE.concat([
    LOGIN_ROUTE,
    { method: 'GET', path: '/api/addresses', body: { items: [{ id: 7, phone: '13800001111', contact: '王阿姨', address: '幸福小区 3 栋 201', isDefault: true }], total: 1 } },
    { method: 'POST', path: '/api/addresses', body: { id: 8, phone: '13800001111', contact: '李叔', address: '幸福小区 5 栋 102', isDefault: false } },
    { method: 'DELETE', re: /^\/api\/addresses\/\d+$/, body: { ok: true, id: 7 } }
  ])
  global.wx = mkWx(ADDR_ROUTES)
  await api.probe()
  await api.wxLogin({ nickname: '王阿姨' })
  api.rememberPhone('13800001111') // 手机号是下单时填的（D31），地址簿靠它当钥匙（D18）
  const ab = loadPage('pages/address/list.js')
  ab.onLoad({ pick: '1' })
  await ab.onShow()
  ok(ab.data.loggedIn === true, '下单填过手机号就能看地址簿')
  ok(ab.data.list.length === 1 && ab.data.list[0].contact === '王阿姨', '地址来自服务端')
  ok(ab.data.list[0].id === '7', 'id 统一成字符串（dataset 传参不会丢）')
  ab.onAdd()
  ok(global.wx.navs.indexOf('/pages/address/edit') >= 0, '能进新增地址')
  ab.onEdit({ currentTarget: { dataset: { id: '7' } } })
  ok(global.wx.navs.indexOf('/pages/address/edit?id=7') >= 0, '能进编辑地址')
  ab.onPick({ currentTarget: { dataset: { id: '7' } } })
  ok(global.wx.back === 1, '挑完地址自动回上一页')
  const picked = store.takePickedAddress()
  ok(picked && picked.contact === '王阿姨', '选中的地址交给购物车回填')
  await ab.onDelete({ currentTarget: { dataset: { id: '7' } } })
  ok(global.wx._calls.filter((c) => c.method === 'DELETE' && c.path.indexOf('/api/addresses/7') === 0).length === 1, '删除真的打到 DELETE /api/addresses/7')
  ok(global.wx.toasts.indexOf('已删除') >= 0, '删除有回执：' + JSON.stringify(global.wx.toasts))

  const ed = loadPage('pages/address/edit.js')
  ed.onLoad({})
  await ed.onShow()
  await ed.save()
  ok(global.wx.toasts.indexOf('请填写收货人') >= 0, '收货人必填')
  ed.onContact({ detail: { value: '一二三四五六七八九十一二三四五六七八九十一' } })
  await ed.save()
  ok(global.wx.toasts.indexOf('收货人不能超过 20 字') >= 0, '收货人 20 字上限（与后端一致）')
  ed.onContact({ detail: { value: '李叔' } })
  await ed.save()
  ok(global.wx.toasts.indexOf('请填写送货地址') >= 0, '地址必填')
  ed.onAddress({ detail: { value: '幸福小区 5 栋 102' } })
  ed.onDefault({ detail: true })
  ok(ed.data.isDefault === true, '默认地址开关')
  await ed.save()
  ok(global.wx.toasts.indexOf('已保存') >= 0, '保存成功有回执')
  const savedBody = global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/addresses').pop()
  ok(savedBody && savedBody.data.contact === '李叔' && savedBody.data.isDefault === true, '提交的 body 带收货人/地址/默认标记')
  ok(savedBody.data.phone === '13800001111', '提交时自动带上登录手机号（手机号即身份）')

  /* ---------- ⑫ 员工端（第 26 轮 / D32：员工身份 + 扫码台） ---------- */
  section('⑫ 员工端（身份 / 扫码只读 / 入库出库盘点 / 订单推进）')

  // 服务端下发的员工令牌（64 位 hex，本地伪造不出来）
  const STAFF_TOKEN = 'a1b2c3d4'.repeat(8)
  let lastStockReq = null
  let scanBody = {
    ok: true, code: '6901234567890', lowStock: 5, found: true,
    product: { code: '6901234567890', name: '农夫山泉 550ml', spec: '550ml 瓶', category: '饮料', unit: '瓶', salePrice: 2, costPrice: 1.2, wholesalePrice: 1.8, stock: 7, onSale: true },
    recent: [{ id: 9, ts: '2026-10-13T09:20:00Z', delta: 3, before: 4, after: 7, reason: '员工小程序入库', by: '阿明' }]
  }
  const nextStock = (cur, kind, qty) => (kind === 'stock_take' ? qty : Number(cur) + qty)
  const STAFF_ROUTES = [
    { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: true, circuitOpen: false, cloudFails: 0 } },
    // 员工身份登录：服务端除了 openid 还会下发 role=staff 与一次性令牌
    { method: 'POST', path: '/api/wx/login', body: { ok: true, openid: 'o_staff_1', bound: false, phone: '', nickname: '阿明', avatar: '', tier: 'retail', role: 'staff', staffToken: STAFF_TOKEN } },
    { method: 'GET', path: '/api/staff/overview', body: {
      ok: true, lowStock: 5, staff: { nickname: '阿明', role: 'staff' },
      stats: { todayRevenue: 128.5, todayOrders: 6, pending: 2, lowStockCount: 1, products: 12 },
      pendingOrders: [{ id: 'M9', customerName: '张三', total: 23.5, address: '幸福小区 3 栋', createdAt: '2026-10-13T02:30:00Z' }],
      lowStockItems: [{ code: '6901234567890', name: '农夫山泉 550ml', spec: '550ml 瓶', stock: 3, unit: '瓶' }],
      recent: [{ id: 9, ts: '2026-10-13T09:20:00Z', delta: 3, after: 7, reason: '员工小程序入库', by: '阿明', name: '农夫山泉 550ml' }]
    } },
    { method: 'GET', path: '/api/staff/scan', body: () => scanBody },
    { method: 'POST', path: '/api/stock/change', body: (o) => {
      lastStockReq = o.data
      const before = Number(scanBody.product.stock)
      const after = nextStock(before, o.data.kind, Number(o.data.qty) || 0)
      scanBody = Object.assign({}, scanBody, {
        found: true,
        product: Object.assign({}, scanBody.product, { stock: after }),
        recent: [{ id: 10, ts: '2026-10-13T10:00:00Z', delta: Number(o.data.qty), before: before, after: after, reason: o.data.reason, by: o.data.by }]
      })
      return { ok: true, code: o.data.code, kind: o.data.kind, before: before, stock: after }
    } },
    { method: 'GET', path: '/api/products', body: { items: [
      { code: '6901234567890', name: '农夫山泉 550ml', spec: '550ml 瓶', brand: '农夫山泉', category: '饮料', unit: '瓶', salePrice: 2, stock: 3, onSale: true },
      { code: '6907992751797', name: '伊利纯牛奶', spec: '250ml 盒', brand: '伊利', category: '乳品', unit: '盒', salePrice: 3.5, stock: 80, onSale: false }
    ], total: 2 } },
    { method: 'POST', path: '/api/products/onsale', body: { ok: true, updated: 1 } },
    { method: 'POST', path: '/api/products', body: { ok: true, product: { code: '6900000000001', name: '新品矿泉水', stock: 6 } } },
    { method: 'GET', path: '/api/settings', body: { name: '啥都有快送', phone: '13800000000', address: '幸福路 1 号', hours: '07:30 – 22:30' } },
    { method: 'GET', path: '/api/orders', body: { items: [{ id: 'M9', customerName: '张三', phone: '13800138000', address: '幸福小区 3 栋', deliveryType: 'delivery', subtotal: 23.5, deliveryFee: 0, total: 23.5, status: 'pending', items: [{ code: '6901234567890', name: '农夫山泉 550ml', price: 2, qty: 2 }], createdAt: '2026-10-13T02:30:00Z' }], total: 1 } },
    { method: 'POST', re: /^\/api\/orders\/[^/]+\/advance$/, body: { ok: true, id: 'M9', status: 'delivering' } }
  ]

  // ⑫.1 不是员工：员工页一个数据接口都不该打
  global.wx = mkWx(STAFF_ROUTES)
  await api.probe()
  const guard = loadPage('pages/staff/home.js')
  guard.onShow()
  ok(guard.data.ready === false && guard.data.loading === true, '不是员工：工作台不加载任何数据')
  ok(global.wx._calls.filter((c) => c.path.indexOf('/api/staff/') === 0).length === 0, '不是员工：没有打到 /api/staff/*')
  ok(global.wx.toasts.join('').indexOf('还不是员工') >= 0, '不是员工：友好提示让人回去找老板')

  // ⑫.2 员工身份登录：拿到 role=staff 与令牌，界面切到员工版
  const s = await api.wxLogin({ nickname: '阿明', role: 'staff' })
  ok(!!s && s.role === 'staff', '员工身份登录：服务端确认为 staff')
  ok(api.isStaff() === true && api.sessionRole() === 'staff', '本机记住员工身份')
  ok(api.staffToken() === STAFF_TOKEN, '拿到员工令牌（64 位 hex）')
  ok(api.view() === 'staff', '登录后界面切到员工版')

  // ⑫.3 工作台：今日营业额 / 待处理 / 低库存 / 最近流水
  const hw = loadPage('pages/staff/home.js')
  hw.onShow()
  await hw.load()
  ok(hw.data.ready === true && hw.data.error === '', '员工工作台连上后端')
  ok(hw.data.stats.revenueText === '128.50' && hw.data.stats.todayOrders === 6, '工作台显示今日营业额与单数')
  ok(hw.data.stats.pending === 2 && hw.data.stats.lowStockCount === 1, '工作台显示待处理与低库存数')
  ok(hw.data.pendingOrders.length === 1 && hw.data.pendingOrders[0].who === '张三', '待处理单带出顾客名')
  ok(hw.data.lowStockItems[0].stock === 3, '低库存货带出剩余数量')
  ok(hw.data.recent[0].deltaText === '+3', '最近流水带出增减：' + hw.data.recent[0].deltaText)
  const overviewCall = global.wx._calls.filter((c) => c.path === '/api/staff/overview').pop()
  ok(!!overviewCall, '工作台走 /api/staff/overview（一次取回）')

  // ⑫.4 工作台大按钮：调起扫码 → 带条码进扫码台
  hw.onScan()
  ok(global.wx.scans.length === 1 && global.wx.scans[0].scanType.indexOf('barCode') >= 0, '调起微信扫码（69 码走 barCode）')
  ok(global.wx.redirs.indexOf('/pages/staff/scan?code=6901234567890') >= 0, '扫到 69 码直接进扫码台：' + JSON.stringify(global.wx.redirs))

  // ⑫.5 扫码台命中：把货摆出来，但绝不动库存（D8）
  const sc = loadPage('pages/staff/scan.js')
  sc.onLoad({ code: '6901234567890' })
  await sc.onShow()
  await sc.load('6901234567890')
  ok(sc.data.found === true && sc.data.product.name === '农夫山泉 550ml', '扫 69 码查到本店商品')
  ok(sc.data.product.stock === 7 && sc.data.product.salePriceText === '2.00', '扫码台带出库存与售价')
  ok(sc.data.recent[0].reason === '员工小程序入库', '扫码台带出最近流水')
  ok(global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/stock/change').length === 0, '只扫码不改库存（D8 只读）')
  sc.onQty({ detail: { value: '3' } })
  await sc.stockIn()
  await new Promise((r) => setTimeout(r, 10))
  ok(!!lastStockReq && lastStockReq.kind === 'stock_in' && lastStockReq.qty === 3, '入库走 stock_in +3：' + JSON.stringify(lastStockReq))
  ok(lastStockReq.by === '阿明', '流水记下是谁动的：' + lastStockReq.by)
  ok(sc.data.product.stock === 10, '入库后扫码台刷新为 10')
  sc.setData({ qty: '2' })
  await sc.stockOut()
  await new Promise((r) => setTimeout(r, 10))
  ok(lastStockReq.kind === 'adjust' && lastStockReq.qty === -2, '出库走 adjust -2（增量）')
  ok(sc.data.product.stock === 8, '出库后库存变 8')
  sc.setData({ qty: '5' })
  await sc.stockTake()
  await new Promise((r) => setTimeout(r, 10))
  ok(lastStockReq.kind === 'stock_take' && lastStockReq.qty === 5, '盘点走 stock_take（实盘数）')
  ok(sc.data.product.stock === 5, '盘点后库存就是实盘数 5')

  // ⑫.6 上下架只动状态、不动库存（D23）
  await sc.toggleOnSale()
  await new Promise((r) => setTimeout(r, 10))
  const onsale = global.wx._calls.filter((c) => c.path === '/api/products/onsale').pop()
  ok(!!onsale && onsale.data.codes[0] === '6901234567890' && onsale.data.onSale === false, '下架只发 onsale：' + JSON.stringify(onsale && onsale.data))

  // ⑫.7 没建档的码：解析出名字填进建档表单，存完再扫就能看见
  scanBody = { ok: true, code: '6900000000001', lowStock: 5, found: false, resolve: { name: '新品矿泉水', spec: '500ml 瓶', source: 'openfoodfacts' }, recent: [] }
  sc.onCodeInput({ detail: { value: '6900000000001' } })
  await sc.search()
  ok(sc.data.found === false && !!sc.data.resolve, '没建档的码给出解析结果')
  ok(sc.data.form.name === '新品矿泉水', '解析出的名字预填进建档表单')
  sc.onFormInput({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '新品矿泉水' } })
  sc.onFormInput({ currentTarget: { dataset: { field: 'salePrice' } }, detail: { value: '2.5' } })
  sc.onFormInput({ currentTarget: { dataset: { field: 'costPrice' } }, detail: { value: '1.5' } })
  const saved = await sc.saveNew()
  const posted = global.wx._calls.filter((c) => c.method === 'POST' && c.path === '/api/products').pop()
  ok(!!posted && posted.data.code === '6900000000001' && posted.data.salePrice === 2.5, '建档真的提交到 /api/products：' + JSON.stringify(posted && posted.data))
  ok(posted.data.stock === undefined, '建档表单没填库存就不碰库存（D16）')

  // ⑫.8 库存页：能看见下架的货 + 只看低库存
  const sk = loadPage('pages/staff/stock.js')
  sk.onShow()
  await sk.load()
  ok(sk.data.list.length === 2, '库存页列出全部货（含已下架）')
  ok(sk.data.list[1].onSale === false, '员工能看见已下架的货（顾客端看不到）')
  sk.toggleLow()
  ok(sk.data.list.length === 1 && sk.data.list[0].code === '6901234567890', '只看低库存：只剩 1 件')
  sk.open({ currentTarget: { dataset: { code: '6901234567890' } } })
  ok(global.wx.redirs.indexOf('/pages/staff/scan?code=6901234567890') >= 0, '库存行点进扫码台看货')

  // ⑫.9 订单页：按状态机给按钮，推进后重新拉列表
  const so = loadPage('pages/staff/orders.js')
  so.onShow()
  await so.load()
  ok(so.data.list.length === 1 && so.data.list[0].id === 'M9', '员工订单页列出订单')
  ok(so.data.list[0].statusText === '待备货', '状态文案与顾客端逐字一致：' + so.data.list[0].statusText)
  ok(so.data.list[0].acts[0].to === 'delivering' && so.data.list[0].acts[0].label === '开始配送', '配送单给「开始配送」')
  ok(so.data.list[0].acts[1].to === 'cancelled' && so.data.list[0].acts[1].label === '取消', '待备货单也给「取消」')
  await so.advance({ currentTarget: { dataset: { id: 'M9', to: 'delivering', label: '开始配送' } } })
  await new Promise((r) => setTimeout(r, 10))
  const adv = global.wx._calls.filter((c) => c.path === '/api/orders/M9/advance').pop()
  ok(!!adv && adv.data.to === 'delivering', '推进订单打到 /api/orders/M9/advance')
  ok(global.wx.toasts.indexOf('已开始配送') >= 0, '推进有回执：' + JSON.stringify(global.wx.toasts.slice(-2)))

  // ⑫.10 员工「我的」：身份卡 + 切回顾客版 + 退出登录
  const sm = loadPage('pages/staff/mine.js')
  sm.onShow()
  await new Promise((r) => setTimeout(r, 10))
  ok(sm.data.name === '阿明' && sm.data.roleText.indexOf('员工') >= 0, '员工「我的」显示员工身份')
  ok(sm.data.shop.name === '啥都有快送', '员工「我的」带出门店信息')
  sm.switchCustomer()
  ok(api.view() === 'customer', '能切回顾客版（界面开关，不动服务端角色）')
  ok(api.isStaff() === true, '切回顾客版仍是员工身份，令牌还在')
  sm.logout()
  await new Promise((r) => setTimeout(r, 10))
  ok(api.isLoggedIn() === false, '员工也能退出登录')

  // ⑫.11 页面接线（本模型看不见真机，靠文件断言兜住）
  const mineWxmlStaff = fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')
  ok(mineWxmlStaff.indexOf('bindtap="pickRole"') >= 0, '「我的」页登录区有身份选择（顾客 / 员工）')
  ok(mineWxmlStaff.indexOf('bind:click="goStaff"') >= 0, '员工以顾客身份进来时留有工作台入口')
  let staffWired = true
  appJson.pages.filter((p) => p.indexOf('pages/staff/') === 0).forEach((p) => {
    const wxml = fs.readFileSync(path.join(ROOT, p + '.wxml'), 'utf8')
    const pageJson = JSON.parse(fs.readFileSync(path.join(ROOT, p + '.json'), 'utf8'))
    if (wxml.indexOf('<staff-nav') < 0) { staffWired = false; console.log('    少了员工底栏：' + p) }
    if (!(pageJson.usingComponents || {})['staff-nav']) { staffWired = false; console.log('    没声明 staff-nav：' + p) }
  })
  ok(staffWired, '5 个员工页都带自绘底栏并声明了 staff-nav')
  ok(fs.readFileSync(path.join(ROOT, 'pages/mine/mine.js'), 'utf8').indexOf('role: role') >= 0, '登录时把身份一起提交给服务端')

  /* ---------- ⑬ 第 27 轮：四态 / 角标 / 离线 / 二次确认 / 结算真源 ---------- */
  section('⑬ 第 27 轮：错误态与空态 / 角标同步 / 离线 / 二次确认 / 结算真源')
  const p27ui = require('./pages/common/ui.js')
  const p27health = { method: 'GET', path: '/healthz', body: { ok: true, cloudConfigured: true, circuitOpen: false, cloudFails: 0 } }
  const p27settings = { name: '啥都有快送', phone: '0531-88886666', address: '幸福路 1 号', lowStock: 2, minFree: 50, deliveryFee: 6, pickupFee: 0 }

  // ⑬.1 错误文案必须先过一遍「人话」转换（技术串绝不甩给顾客，业务错误原文透传）
  ok(p27ui.errText(new Error('无法连接后端（/api）：request:fail timeout')) === p27ui.NET_HINT,
    '网络类错误换成人话：' + p27ui.errText(new Error('无法连接后端（/api）：request:fail timeout')))
  ok(p27ui.errText(new Error('库存不足，只剩 1 件')) === '库存不足，只剩 1 件',
    '服务端的业务错误原文透传，不被盖成「没连上」')

  // ⑬.2 首页：请求失败 ≠ 没货（P0-1）
  const p27flaky = [p27health, { method: 'GET', path: '/api/products', fail: 'request:fail timeout' }]
  global.wx = mkWx(p27flaky)
  store.clearCart()
  const p27idx = loadPage('pages/index/index.js')
  p27idx.onLoad()
  await p27idx.onShow()
  ok(p27idx.data.online === true, '这台设备连着店里系统（不是离线自动降级）')
  ok(p27idx.data.loadErr === '店里系统没连上，请稍后重试', '商品接口失败 → 人话错误卡：' + p27idx.data.loadErr)
  ok(p27idx.data.empty === false && p27idx.data.products.length === 0, '请求失败不许冒充「没货」空态')
  // 只数商品列表请求（'/api/products?…'）；'/api/products/categories?…' 是分类请求，不能混进来
  const p27before = global.wx._calls.filter((c) => c.path.indexOf('/api/products?') === 0).length
  p27flaky[1].fail = null
  p27flaky[1].body = { items: SERVER_PRODUCTS, total: 2 }
  await p27idx.reload()
  ok(global.wx._calls.filter((c) => c.path.indexOf('/api/products?') === 0).length === p27before + 1, '「重新加载」真的重新发了一次请求')
  ok(p27idx.data.products.length === 2 && p27idx.data.loadErr === '', '重新加载成功后错误卡消失、列表回来')
  p27flaky[1].body = { items: [], total: 0 }
  await p27idx.reload()
  ok(p27idx.data.empty === true && p27idx.data.loadErr === '', '只有请求成功且为空，才显示「没有找到商品」')
  const p27idxWxml = fs.readFileSync(path.join(ROOT, 'pages/index/index.wxml'), 'utf8')
  ok(/bindtap="reload"/.test(p27idxWxml) && /wx:elif="\{\{loadErr\}\}"/.test(p27idxWxml), '首页错误卡接线到「重新加载」按钮')

  // ⑬.3 订单列表：失败 ≠ 没有订单（P0-1）
  const p27ofail = [p27health, { method: 'GET', path: '/api/orders', fail: 'request:fail timeout' }]
  global.wx = mkWx(p27ofail)
  api.rememberPhone('13800138000')
  let p27orders = loadPage('pages/orders/orders.js')
  await p27orders.onShow()
  ok(p27orders.data.loadErr === '店里系统没连上，请稍后重试', '订单列表失败 → 人话错误卡')
  ok(p27orders.data.empty === false, '订单接口失败不许说「这里还没有订单」')
  p27ofail[1].fail = null
  p27ofail[1].body = { items: [], total: 0 }
  await p27orders.reload()
  ok(p27orders.data.empty === true && p27orders.data.loadErr === '', '订单请求成功且为空才是空态')
  ok(/bindtap="reload"/.test(fs.readFileSync(path.join(ROOT, 'pages/orders/orders.wxml'), 'utf8')), '订单页错误卡 / 身份引导卡都有「重新加载」')

  // ⑬.4 身份前置拦截：没身份不打后端（P0-8）
  global.wx = mkWx(ONLINE)
  api.clearSession()
  await api.probe()
  ok(p27ui.hasIdentity() === false, '清掉会话后没有身份')
  p27orders = loadPage('pages/orders/orders.js')
  await p27orders.onShow()
  ok(p27orders.data.needIdentity === true, '在线但没身份 → 页面先拦住并引导登录 / 填手机号')
  ok(global.wx._calls.filter((c) => c.method === 'GET' && c.path.indexOf('/api/orders') === 0).length === 0,
    '没身份不打卡后端（顾客看不到「缺少身份」那种后端报错）')
  api.rememberPhone('13800138000')
  ok(p27ui.hasIdentity() === true, '下单时填过手机号，身份就绪')

  // ⑬.5 角标与计数在所有入口同步（P0-2）
  global.wx = mkWx(ONLINE)
  store.clearCart()
  const p27subIdx = loadPage('pages/index/index.js')
  p27subIdx.onLoad()
  await p27subIdx.onShow()
  ok(p27subIdx.data.cartCount === 0, '起点：首页计数 0')
  store.addToCart(SERVER_PRODUCTS[0], 2)
  ok(p27subIdx.data.cartCount === 2, '别处加购后首页计数自动跟上（store.subscribe）')
  const p27badge = global.wx.badges[global.wx.badges.length - 1]
  ok(!!p27badge && p27badge.text === '2', 'tabBar 角标同步成 2：' + JSON.stringify(p27badge))
  const p27subCat = loadPage('pages/category/category.js')
  p27subCat.onLoad()
  await p27subCat.onShow()
  store.clearCart()
  store.addToCart(SERVER_PRODUCTS[1], 1)
  ok(p27subCat.data.cartCount === 1, '分类页计数跟着 store 广播走（这个入口原来漏同步）')
  const p27subSearch = loadPage('pages/search/search.js')
  p27subSearch.onLoad()
  ok(p27subSearch.data.cartCount === 1, '搜索页一进来就带上车里现有件数')
  store.addToCart(SERVER_PRODUCTS[0], 1)
  ok(p27subSearch.data.cartCount === 2, '搜索页加购后本页计数同步（P0-7）')
  const p27subGoods = loadPage('pages/goods/goods.js')
  await p27subGoods.onLoad({ code: '6901234567892' })
  store.clearCart()
  store.addToCart(SERVER_PRODUCTS[0], 3)
  ok(p27subGoods.data.cartCount === 3, '商品详情页计数也实时跟着变（原来只在 onShow 刷一次）')

  // ⑬.6 离线下单：记一笔本地单，但绝不跳进「下单成功」流程（P0-3）
  global.wx = mkWx(OFFLINE)
  store.clearCart()
  store.addToCart({ code: '6901234567892', name: '可口可乐', salePrice: 2.5, unit: '罐' }, 2)
  const p27offCart = loadPage('pages/cart/cart.js')
  p27offCart.onLoad()
  await p27offCart.onShow()
  const p27modals = []
  global.wx.showModal = (o) => { p27modals.push(o); if (o && o.success) o.success({ confirm: true }) }
  p27offCart.onName({ detail: { value: '张三' } })
  p27offCart.onPhone({ detail: { value: '13800138000' } })
  p27offCart.onAddress({ detail: { value: '3 栋 502' } })
  const p27local = await p27offCart.submit()
  ok(!!p27local && String(p27local.id).charAt(0) === 'L', '离线仍记一笔本地单（不丢单）')
  ok(p27modals.length === 1 && p27modals[0].title === '离线未提交' && String(p27modals[0].content).indexOf('离线未提交') === 0,
    '离线下单弹「离线未提交，请连上店里系统后重试」')
  ok(global.wx.tabs.indexOf('/pages/orders/orders') < 0, '离线不跳进正常下单成功流程')
  await new Promise((r) => setTimeout(r, 700))
  ok(global.wx.tabs.indexOf('/pages/orders/orders') < 0, '等过 600ms 也不跳（没有排队的跳转）')
  ok(global.wx.toasts.some((t) => t && t.indexOf('本地演示') >= 0), '离线仍明确告知未入库')

  // ⑬.7 立即购买二次确认（P0-4）
  global.wx = mkWx(OFFLINE)
  const p27goods = loadPage('pages/goods/goods.js')
  await p27goods.onLoad({ code: '6901234567892' })
  p27goods.onStep({ detail: 2 })
  const p27bnModals = []
  global.wx.showModal = (o) => { p27bnModals.push(o); if (o && o.success) o.success({ confirm: false }) }
  p27goods.buyNow()
  ok(p27bnModals.length === 1 && p27bnModals[0].title === '马上下单？', '「立即购买」先弹二次确认')
  ok(global.wx.tabs.indexOf('/pages/cart/cart') < 0 && !store.takeBuyNow(), '点「再想想」什么都不发生（不跳转、不生成待下单）')
  global.wx.showModal = (o) => { if (o && o.success) o.success({ confirm: true }) }
  p27goods.buyNow()
  const p27bn = store.takeBuyNow()
  ok(!!p27bn && p27bn.length === 1 && p27bn[0].qty === 2, '确认后才放进结算（数量 2）')
  ok(global.wx.tabs.indexOf('/pages/cart/cart') >= 0, '确认后才跳购物车结算')

  // ⑬.8 结算区：配送费 / 免运费门槛 / 自提门店信息都来自 settings（P0-5）
  const p27onlineSettings = ONLINE.concat([{ method: 'GET', path: '/api/settings', body: p27settings }])
  global.wx = mkWx(p27onlineSettings)
  store.clearCart()
  store.addToCart({ code: '6901234567892', name: '可口可乐', unit: '罐', salePrice: 2.5, stock: 120 }, 2)
  const p27setCart = loadPage('pages/cart/cart.js')
  p27setCart.onLoad()
  await p27setCart.onShow()
  ok(p27setCart.data.shop.address === '幸福路 1 号' && p27setCart.data.shop.phone === '0531-88886666',
    '自提门店地址与电话来自 settings')
  ok(p27setCart.data.feeText === '6.00', '配送费取自服务端 settings（6 元），不是页面写死的 3 元')
  ok(String(p27setCart.data.feeHint).indexOf('还差 45 元') === 0, '免运费差额按 settings 的 50 元门槛算：' + p27setCart.data.feeHint)
  p27setCart.onDelivery({ currentTarget: { dataset: { kind: 'pickup' } } })
  ok(p27setCart.data.feeText === '0.00' && p27setCart.data.feeHint === '自提免配送费', '自提免配送费（同样走 settings/rules）')
  p27setCart.callShop()
  ok(global.wx.calls2[global.wx.calls2.length - 1] === '0531-88886666', '自提能一键打门店电话')
  const p27cartWxml = fs.readFileSync(path.join(ROOT, 'pages/cart/cart.wxml'), 'utf8')
  ok(p27cartWxml.indexOf('pickupinfo') > 0 && p27cartWxml.indexOf('shop.address') > 0, '自提时页面上真的显示门店地址')
  ok(p27cartWxml.indexOf('feeHint') > 0 && p27cartWxml.indexOf('feeText') > 0, '结算区显示配送费 / 免运费差额')

  // ⑬.9 购物车数量上限 + 失效商品分组 + 一键清理（P0-6）
  const p27low = [
    p27health,
    { method: 'GET', path: '/api/products', body: { items: [Object.assign({}, SERVER_PRODUCTS[0], { stock: 2 })], total: 1 } },
    { method: 'GET', path: '/api/settings', body: p27settings }
  ]
  global.wx = mkWx(p27low)
  store.clearCart()
  store.addToCart({ code: '6901234567892', name: '可口可乐', unit: '罐', salePrice: 2.5 }, 1)
  const p27cap = loadPage('pages/cart/cart.js')
  p27cap.onLoad()
  await p27cap.onShow()
  ok(p27cap.data.lines[0].max === 2, '步进器上限 = 该商品库存（' + p27cap.data.lines[0].max + '）')
  p27cap.onStep({ currentTarget: { dataset: { code: '6901234567892' } }, detail: 5 })
  ok(p27cap.data.lines[0].qty === 2, '数量超库存被夹回上限 2（不静默改数）')
  ok(global.wx.toasts.indexOf('最多只能买 2 件（库存就这么多）') >= 0, '超库存给出人话提示')
  p27low[1].body = { items: [], total: 0 }
  await p27cap.reload()
  ok(p27cap.data.lines.length === 0 && p27cap.data.badLines.length === 1, '已下架 / 没货的商品单独分组，不混进可买清单')
  ok(p27cap.data.badLines[0].name === '可口可乐', '失效分组里仍看得见是哪件')
  await p27cap.clearBad()
  ok(p27cap.data.badLines.length === 0 && store.cartCount() === 0, '一键清理把失效商品删掉（不给它们进订单）')
  ok(global.wx.toasts.indexOf('已清理') >= 0, '清理有回执')

  // ⑬.10 搜索结果里直接加购 + 缺货不可买（P0-7）
  const p27oos = [
    p27health,
    {
      method: 'GET',
      path: '/api/products',
      body: { items: SERVER_PRODUCTS.concat([{ code: '6900000000009', name: '冰红茶', unit: '瓶', salePrice: 3, stock: 0, category: '饮料' }]), total: 3 }
    }
  ]
  global.wx = mkWx(p27oos)
  store.clearCart()
  const p27search = loadPage('pages/search/search.js')
  p27search.onLoad()
  p27search.setData({ keyword: '饮料' })
  await p27search.doSearch(false)
  ok(p27search.data.searched === true && p27search.data.results.length === 3, '搜索结果正常渲染（' + p27search.data.results.length + ' 件）')
  p27search.onAdd({ currentTarget: { dataset: { code: '6900000000009' } } })
  ok(store.cartCount() === 0 && global.wx.toasts.indexOf('这件暂时没货') >= 0, '缺货商品加不进去（按钮不可用）')
  p27search.onAdd({ currentTarget: { dataset: { code: '6901234567892' } } })
  ok(store.cartCount() === 1 && p27search.data.cartCount === 1, '搜索结果里能直接加购，本页计数同步')
  const p27searchWxml = fs.readFileSync(path.join(ROOT, 'pages/search/search.wxml'), 'utf8')
  ok(/catchtap="onAdd"/.test(p27searchWxml) && /item\.stock\s*<=\s*0/.test(p27searchWxml), '搜索结果的加购按钮接上，并按库存标缺货')
  ok(p27searchWxml.indexOf('sstock') > 0 && p27searchWxml.indexOf('lowStock') > 0, '搜索结果里显示库存 / 缺货状态（阈值来自服务端）')

  // ⑬.11 低库存阈值单一真源（P0-9）
  global.wx = mkWx(p27onlineSettings)
  await api.probe()
  await api.getSettings()
  ok(api.lowStock() === 2, 'api.lowStock() 读服务端下发的阈值（2），不是兜底 5')
  const p27g2 = loadPage('pages/goods/goods.js')
  await p27g2.onLoad({ code: '6901234567892' })
  ok(p27g2.data.lowStock === 2, '商品详情页阈值来自服务端：' + p27g2.data.lowStock)
  ok(loadPage('pages/staff/stock.js').data.lowStock === 2, '员工端库存页阈值同样来自服务端（单一真源）')
  ok(loadPage('pages/staff/home.js').data.lowStock === 2, '员工工作台阈值也不再写死 5')
  let p27hard = 0
  ;['pages/index/index.wxml', 'pages/search/search.wxml', 'pages/category/category.wxml', 'pages/goods/goods.wxml'].forEach((f) => {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8')
    if (/stock\s*<=\s*5\b/.test(t) || /仅剩\s*5/.test(t)) { p27hard++; console.log('    还在写死阈值：' + f) }
  })
  ok(p27hard === 0, '四个顾客页的「仅剩 N 件」都用 lowStock 变量，没有写死的 5')

  // ⑬.12 地址簿 / 我的：同样区分「失败」与「空」（P0-1）
  const p27afail = [p27health, { method: 'GET', path: '/api/addresses', fail: 'request:fail timeout' }]
  global.wx = mkWx(p27afail)
  api.rememberPhone('13800001111')
  const p27addr = loadPage('pages/address/list.js')
  await p27addr.onShow()
  ok(p27addr.data.loadErr === '店里系统没连上，请稍后重试', '地址列表失败 → 人话错误卡')
  ok(p27addr.data.empty === false, '地址接口失败不许说「还没有收货地址」')
  p27afail[1].fail = null
  p27afail[1].body = { items: [] }
  await p27addr.reload()
  ok(p27addr.data.empty === true && p27addr.data.loadErr === '', '地址请求成功且为空才是空态')
  const p27mfail = [p27health, { method: 'GET', path: '/api/orders', fail: 'request:fail timeout' }]
  global.wx = mkWx(p27mfail)
  api.rememberPhone('13800138000')
  const p27mine = loadPage('pages/mine/mine.js')
  await p27mine.onShow()
  ok(p27mine.data.loadErr === '店里系统没连上，请稍后重试', '「我的」页订单数拉不到 → 错误卡（不是显示 0）')
  p27mfail[1].fail = null
  p27mfail[1].body = { items: [], total: 0 }
  await p27mine.reload()
  ok(p27mine.data.loadErr === '' && p27mine.data.loading === false, '「我的」页重新加载后错误卡消失')
  ok(/bindtap="reload"/.test(fs.readFileSync(path.join(ROOT, 'pages/mine/mine.wxml'), 'utf8')), '「我的」页错误卡也有「重新加载」')

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错：', e)
  process.exit(1)
})

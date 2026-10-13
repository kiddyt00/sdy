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
    getStorageSync: (k) => (k in kv ? kv[k] : ''),
    setStorageSync: (k, v) => { kv[k] = v },
    removeStorageSync: (k) => { delete kv[k] },
    showToast: function (o) { this.toasts.push(o && o.title) },
    switchTab: function (o) { this.tabs.push(o && o.url) },
    navigateTo: function (o) { this.navs.push(o && o.url) },
    navigateBack: function () { this.back++ },
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
  ok(appJson.pages.length === 10, 'app.json 声明 10 个页面')
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
  // 全页面扫一遍：顾客端不许出现连接状态这类开发文案（后端地址只留在「我的 → 开发者选项」）
  const appJsonAll = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
  const devWords = ['后端已连接', '后端连接', '探测中', 'statusLabel']
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
  ok(mine.data.online === false, '离线：连接状态为 false（页面上只显示灰点）')
  ok(mine.data.statusDetail.indexOf('不会入库') > 0, '开发者选项里才说明离线下单不入库')
  ok(mine.data.shop.name === '啥都有快送', '店铺信息就位')
  mine.onBase({ detail: { value: 'http://192.168.1.9:8093' } })
  await mine.saveBase()
  ok(api.base() === 'http://192.168.1.9:8093', '保存后 base 生效：' + api.base())
  ok(global.wx.toasts.indexOf('保存了，但还没连上') >= 0, '保存后仍连不上会如实提示')
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
  ok(mineWxss.indexOf('box-sizing: border-box') > 0 && mineWxss.indexOf('.mavatar-btn::after') > 0, '头像按钮重置了 button 默认样式（真圆）')

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
  // 头像：chooseAvatar 给的是本机临时路径，真机上先落本地（存不下也无所谓）
  const av = await acc.onChooseAvatar({ detail: { avatarUrl: 'wxfile://tmp_av.png' } })
  ok(acc.data.avatar === 'wxfile://tmp_av.png' && av === 'wxfile://tmp_av.png', '选中头像后立刻显示')
  ok(global.wx._kv['sdy_mp_avatar'] === 'wxfile://tmp_av.png', '头像落到本机缓存，重启不丢')
  // 已登录时保存头像昵称
  await acc.saveProfile()
  ok(global.wx.toasts.indexOf('已保存，下次进来自动带出来') >= 0, '保存头像昵称有反馈：' + JSON.stringify(global.wx.toasts))
  ok(acc.data.saving === false, '保存后复位 saving')
  // 下单时记住手机号（手机号是价格身份与地址簿钥匙，D24/D31）
  ok(api.boundPhone() === '', '下单前会话里没有手机号')
  api.rememberPhone('13800001111')
  ok(api.boundPhone() === '13800001111', '下单填过的手机号被记住，价格与地址簿才能用')
  // 退出登录
  await acc.doLogout()
  ok(acc.data.loggedIn === false, '退出后回到未登录')
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
  ok(od.data.o.statusText === '待处理', '状态文案：待处理')
  ok(od.data.o.canCancel === true && od.data.o.canAdvance === false, '待处理只给「取消订单」')
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

  console.log('\n========================================')
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项')
  process.exit(failed ? 1 : 0)
}

main().catch((e) => {
  console.error('测试自身出错：', e)
  process.exit(1)
})

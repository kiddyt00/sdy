/* =====================================================================
 * 页面启动冒烟测试（假 DOM，不起浏览器）
 *   把 index.html / admin.html 里的内联脚本真的跑一遍，捕获启动期报错，
 *   覆盖两条路径：① 后端不可用 → 本地演示渲染 ② 后端可用 → 拉镜像后渲染
 * 运行：node test-page-boot.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const Mall = require('./mall.js');
const Pricing = require('./pricing.js');
const Admin = require('./mall-admin.js');
const SdyApi = require('./sdy-api.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ ' + msg); }
}
function section(t) { console.log('\n■ ' + t); }

// 抽出 HTML 里的内联脚本（最后一段 <script>…</script>）
function inlineScript(file) {
  const html = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const m = html.match(/<script>\n([\s\S]*?)\n<\/script>/);
  if (!m) throw new Error(file + ' 未找到内联脚本');
  return m[1];
}

function fakeEl(id) {
  return { id: id, innerHTML: '', textContent: '', value: '', className: '', title: '', style: {}, checked: false,
    focus: function () {}, dispatchEvent: function () {}, addEventListener: function () {}, removeEventListener: function () {} };
}

// 造一个「浏览器环境」：Node 全局（Mall/SdyApi 用）+ vm 沙箱（页面脚本用）共用同一份
function makeEnv(opts) {
  const els = {};
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
  };
  const window = {};
  if (opts && opts.base) window.SDY_API_BASE = opts.base;
  const fetchImpl = (opts && opts.fetch) || (async () => { throw new Error('offline'); });

  global.localStorage = localStorage;
  global.window = window;
  global.fetch = fetchImpl;
  SdyApi._resetForTest();
  SdyApi.configure({ fetchImpl: fetchImpl, mall: Mall, admin: Admin, timeoutMs: 300, base: (opts && opts.base) || '' });

  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, AbortController: AbortController,
    document: { getElementById: id => (els[id] || (els[id] = fakeEl(id))), querySelectorAll: () => [] },
    localStorage: localStorage, window: window, fetch: fetchImpl,
    confirm: () => true, alert: () => {}, prompt: (opts && opts.prompt) || (() => null),
    Mall: Mall, Pricing: Pricing, Admin: Admin, SdyApi: SdyApi
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  return { ctx: ctx, els: els, store: store };
}

async function bootPage(file, envOpts) {
  const env = makeEnv(envOpts);
  Mall._resetForTest();
  Mall.loadCatalog();
  vm.runInContext(inlineScript(file), env.ctx, { filename: file });
  await new Promise(r => setTimeout(r, (envOpts && envOpts.wait) || 120));
  return env;
}

const offline = { fetch: async () => { throw new Error('connection refused'); } };
const online = {
  base: 'http://127.0.0.1:8093',
  fetch: async (url, opts) => {
    const p = String(url).replace(/^https?:\/\/[^/]+/, '');
    const method = (opts && opts.method) || 'GET';
    const routes = {
      'GET /healthz': { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true },
      'GET /api/products': { total: 2, items: [
        { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', salePrice: 2.5, costPrice: 1.8, refPrice: 3, unit: '罐', stock: 118, syncStatus: 'synced' },
        { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', category: '饮料', salePrice: 1.8, costPrice: 1.1, unit: '瓶', stock: 200, syncStatus: 'pending' }
      ] },
      'GET /api/orders': { total: 1, items: [
        { id: 'M123', customerName: '张三', phone: '13800000000', address: '', deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }], createdAt: '2026-10-10T08:05:00Z' }
      ] },
      'GET /api/pricing/check': { total: 2, over: 0, violations: [] }
    };
    const hit = routes[method + ' ' + p];
    if (!hit) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no route ' + p }) };
    return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
  }
};

(async function main() {
  console.log('页面启动冒烟：index.html / admin.html（假 DOM，真跑内联脚本）');

  /* ---------- 顾客端：离线 ---------- */
  section('① index.html · 后端不可用（本地演示）');
  {
    const env = await bootPage('index.html', offline);
    ok(env.els.modeBadge.className.indexOf('dot-mode') >= 0 && env.els.modeBadge.className.indexOf('off') >= 0, '顶部只留一个小灰点：' + env.els.modeBadge.className);
    ok(env.els.modeBadge.textContent === '' && env.els.modeBadge.title.length > 0, '顾客端不露「后端已连接」字样，说明只在 title 里：' + env.els.modeBadge.title);
    ok(env.els.grid.innerHTML.indexOf('可口可乐') >= 0, '商品网格已渲染（含种子商品）');
    ok(env.els.cats.innerHTML.indexOf('全部') >= 0, '分类栏已渲染');
    ok(env.els.cartDot.innerHTML !== undefined, '购物车角标元素存在');
    ok(env.els.filters.innerHTML.indexOf('待备货') >= 0, '订单筛选栏已渲染');
  }

  /* ---------- 顾客端：在线 ---------- */
  section('② index.html · 后端可用（拉镜像）');
  {
    const env = await bootPage('index.html', online);
    ok(env.els.modeBadge.className.indexOf('dot-mode') >= 0 && env.els.modeBadge.className.indexOf('on') >= 0, '后端可用时小点是绿的：' + env.els.modeBadge.className);
    ok(SdyApi.on() === true, 'SdyApi 处于 server 模式');
    ok(Mall.loadCatalog().length === 2, '页面已被后端镜像覆盖（2 条，非 6 条种子）');
    ok(env.els.grid.innerHTML.indexOf('可口可乐') >= 0, '用后端数据渲染商品网格');
    ok(env.els.grid.innerHTML.indexOf('伊利纯牛奶') < 0, '种子商品已被后端数据替换');
    ok(env.els.orders.innerHTML.indexOf('M123') >= 0, '订单页渲染后端订单 ' + 'M123');
  }

  /* ---------- 管理端：离线 ---------- */
  section('③ admin.html · 后端不可用（本地演示）');
  {
    const env = await bootPage('admin.html', offline);
    ok(env.els.modeBadge.textContent.indexOf('本地演示') >= 0, '顶部状态：' + env.els.modeBadge.textContent);
    ok(env.els.filters.innerHTML.indexOf('全部') >= 0, '订单筛选栏已渲染');
    ok(env.els.orders.innerHTML.length > 0, '订单区已渲染（' + env.els.orders.innerHTML.slice(0, 24) + '…）');
    ok(env.els.stockRows.innerHTML.indexOf('可口可乐') >= 0, '库存页渲染出商品行');
    ok(env.els.stockRows.innerHTML.indexOf('入库单号') >= 0, '库存页含入库/改数/盘点三种操作');
    ok(env.els.pricingTable.innerHTML.indexOf('防线上限') >= 0, '价格规则表已渲染');
  }

  /* ---------- 管理端：在线 ---------- */
  section('④ admin.html · 后端可用');
  {
    const env = await bootPage('admin.html', online);
    ok(env.els.modeBadge.textContent.indexOf('已连接') >= 0, '顶部状态：' + env.els.modeBadge.textContent);
    ok(env.els.stockRows.innerHTML.indexOf('118') >= 0, '库存页显示后端库存 118');
    ok(env.els.custList.innerHTML.indexOf('张三') >= 0, '顾客档案从后端订单沉淀（张三）');
    ok(env.els.orders.innerHTML.indexOf('M123') >= 0, '订单区渲染后端订单');
  }

  /* ---------- 管理端 · 商品档案页（离线建档/编辑） ---------- */
  section('⑤ admin.html · 商品档案页（建档 / 编辑表单）');
  {
    const env = await bootPage('admin.html', offline);
    const ctx = env.ctx;
    ok(env.els.prodStats.innerHTML.indexOf('档案总数') >= 0, '商品档案统计卡已渲染');
    ok(env.els.prodCount.textContent.indexOf('共 6 个') >= 0, '商品计数：' + env.els.prodCount.textContent);
    ok(env.els.prodCats.innerHTML.indexOf('饮料') >= 0, '分类 chips 渲染（含饮料）');
    ok(env.els.prodTable.innerHTML.indexOf('可口可乐') >= 0, '商品表格渲染种子商品');
    ok(env.els.prodTable.innerHTML.indexOf('编辑') >= 0 && env.els.prodTable.innerHTML.indexOf('删除') >= 0, '每行有编辑/删除按钮');
    ctx.switchTab('products');
    ok(env.els.navProducts.className.indexOf('nv on') >= 0, '侧边栏「商品档案」入口高亮');
    ok(env.els.viewProducts.className.indexOf('hide') < 0, '切换后商品档案页可见');
    ok(env.els.crumb.textContent === '商品档案', '面包屑同步为商品档案');

    // 编辑态：回填 + 不改库存
    ctx.openProductDlg('6901234567892');
    ok(env.els.pfName.value.indexOf('可口可乐') >= 0, '编辑弹窗回填名称');
    ok(env.els.pfCode.disabled === true, '编辑态条码不可改');
    ok(env.els.pfStockRow.style.display === 'none', '编辑态隐藏库存输入（不变量：编辑不改库存）');
    ok(env.els.dlgProduct.className.indexOf('show') >= 0, '弹窗已打开');
    ctx.closeProductDlg();
    ok(env.els.dlgProduct.className.indexOf('show') < 0, '弹窗已关闭');

    // 新建态：即时校验 + 保存
    ctx.openProductDlg('');
    ok(env.els.pfStockRow.style.display !== 'none', '新建态显示初始库存输入');
    env.els.pfCode.value = '6909999999999';
    env.els.pfName.value = '';
    ctx.checkProductForm();
    ok(env.els.pfMsg.innerHTML.indexOf('名称') >= 0, '空名称即时提示：' + env.els.pfMsg.innerHTML.replace(/<[^>]+>/g, ''));
    env.els.pfName.value = '测试商品';
    env.els.pfSale.value = '9.9';
    env.els.pfRef.value = '5';
    ctx.checkProductForm();
    ok(env.els.pfMsg.innerHTML.indexOf('比价防线') >= 0, '超价即时提示比价防线');
    env.els.pfRef.value = '';
    env.els.pfStock.value = '3';
    ctx.checkProductForm();
    ok(env.els.pfMsg.innerHTML.indexOf('校验通过') >= 0, '合法表单即时校验通过');
    await ctx.submitProduct();
    const np = Mall.getProduct('6909999999999');
    ok(!!np, '建档成功写入商品库');
    ok(np && np.stock === 3, '初始库存 3 已写入');
    ok(np && np.syncStatus === '待同步', '建档标记待同步');
    ok(Admin.getStockLog().filter(x => x.code === '6909999999999').length >= 2, '建档留了两条流水（建档 + 初始入库）');
    ok(env.els.prodCount.textContent.indexOf('共 7 个') >= 0, '保存后列表刷新：' + env.els.prodCount.textContent);
    ok(env.els.dlgProduct.className.indexOf('show') < 0, '保存后弹窗自动关闭');
  }

  /* ---------- 管理端 · 在线写入（建档/编辑/删除走 api shim） ---------- */
  section('④b admin.html · 商品档案在线写入');
  {
    const calls = [];
    const recFetch = async (url, opts) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      const method = (opts && opts.method) || 'GET';
      if (p === '/api/products' && method === 'POST') {
        const body = JSON.parse(opts.body);
        calls.push(body);
        return { ok: true, status: 200, text: async () => JSON.stringify(body) };
      }
      if (p.indexOf('/api/products/') === 0 && method === 'DELETE') {
        calls.push({ del: decodeURIComponent(p.replace('/api/products/', '')) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, code: p.split('/').pop() }) };
      }
      return online.fetch(url, opts);
    };
    const env = await bootPage('admin.html', { base: 'http://127.0.0.1:8093', fetch: recFetch });
    const ctx = env.ctx;
    ok(Mall.getProduct('6901234567892') != null, '在线镜像已拉到商品档案');
    // 编辑：不带 stock
    ctx.openProductDlg('6901234567892');
    env.els.pfSale.value = '2.6';
    await ctx.submitProduct();
    ok(calls.length === 1 && calls[0].code === '6901234567892', '编辑走 POST /api/products');
    ok(calls[0] && calls[0].stock === undefined, '编辑请求不带 stock（后端保留库存）');
    // 建档：带初始库存
    ctx.openProductDlg('');
    env.els.pfCode.value = '6908888888888';
    env.els.pfName.value = '在线新品';
    env.els.pfSale.value = '4';
    env.els.pfStock.value = '5';
    await ctx.submitProduct();
    ok(calls.length === 2 && calls[1].stock === 5, '建档请求带初始库存 5');
    // 删除：库存非 0 时本地规则先拦住，不发请求
    await ctx.delProduct('6902083881234');
    ok(calls.length === 2, '库存非 0 时不发删除请求（本地规则先拦）');
    // 库存清零但订单 M123 仍在进行 → 本地规则拦住
    Mall.updateProduct('6901234567892', { stock: 0 });
    await ctx.delProduct('6901234567892');
    ok(calls.length === 2, '有进行中订单时不发删除请求（本地规则先拦）');
    // 另一个商品无进行中订单，清零后可删
    Mall.updateProduct('6902083881234', { stock: 0 });
    await ctx.delProduct('6902083881234');
    ok(calls.length === 3 && calls[2] && calls[2].del === '6902083881234', '库存 0 且无进行中订单 → DELETE /api/products/{code}');
  }

  /* ---------- 管理端 · 小票打印（离线、不真打印） ---------- */
  section('⑥ admin.html · 小票 / 配送单打印');
  {
    const env = await bootPage('admin.html', offline);
    const ctx = env.ctx;
    ok(env.els.stName.value === Admin.DEFAULT_STORE.name, '系统页抬头表单回填默认店名：' + env.els.stName.value);
    Mall.addToCart('6901234567892', 2);
    const o = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '张三', phone: '13800000000' } });
    ctx.renderOrders();
    ok(env.els.orders.innerHTML.indexOf('🖨 小票') >= 0, '每张订单末尾有「🖨 小票」按钮');
    let printed = 0;
    env.ctx.window.print = function () { printed++; };
    ctx.printOrder(o.id);
    ok(printed === 1, 'printOrder 只唤起一次打印');
    const html = env.els.printRoot.innerHTML;
    ok(html.indexOf(o.id) >= 0 && html.indexOf('receipt') >= 0, '小票已写入打印区并含单号');
    ok(html.indexOf('应收') >= 0 && html.indexOf('到店自提') >= 0, '票面含应收与自提方式');
    ok(html.indexOf(Admin.DEFAULT_STORE.name) >= 0, '票头用本地抬头（默认店名）');
    ok(html.indexOf('¥5.00') >= 0, '行金额按 2.50 × 2 计算');
    // 抬头保存后立即生效
    env.els.stName.value = '啥都有快送';
    env.els.stPhone.value = '0571-88888888';
    env.els.stAddr.value = '幸福路 1 号';
    env.els.stFooter.value = '欢迎再来';
    ctx.saveStore();
    ok(Admin.getStoreInfo().name === '啥都有快送', '抬头保存进本地设置');
    ctx.printOrder(o.id);
    ok(env.els.printRoot.innerHTML.indexOf('啥都有快送') >= 0 && env.els.printRoot.innerHTML.indexOf('0571-88888888') >= 0, '再打印时票头已更新');
    // 批量打印待备货
    Mall.addToCart('6902083881234', 1);
    const o2 = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '李四', phone: '13900000000', address: '幸福路2号' } });
    printed = 0;
    ctx.printPending();
    ok(printed === 1 && (env.els.printRoot.innerHTML.match(/class="receipt/g) || []).length === 2, '批量打印 2 张待备货小票（一次唤起）');
    ok(env.els.printRoot.innerHTML.indexOf('r-break') >= 0, '多张小票之间分页');
    ok(env.els.printRoot.innerHTML.indexOf('幸福路2号') >= 0 && env.els.printRoot.innerHTML.indexOf('配送费') >= 0, '配送单票面含地址与配送费');
    // 全部完成后没有待备货 → 不唤起打印
    Mall.advanceOrder(o.id, 'ready');
    Mall.advanceOrder(o.id, 'done');
    Mall.advanceOrder(o2.id, 'delivering');
    Mall.advanceOrder(o2.id, 'done');
    printed = 0;
    ctx.printPending();
    ok(printed === 0, '没有待备货订单时不唤起打印');
    ok(ctx.printOrder('M00000') === undefined && printed === 0, '打印不存在的订单不唤起打印（只提示）');
  }

  /* ---------- 管理端：销售报表（D19） ---------- */
  section('⑧ admin.html · 销售报表 / 日报');
  {
    const env = await bootPage('admin.html', offline);
    const ctx = env.ctx;
    const todayAt = h => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
    const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); d.setHours(10, 0, 0, 0); return d.getTime(); };
    const kToday = Admin.dayKey(todayAt(12)), kFirst7 = Admin.dayKey(daysAgo(6));
    const mk = (id, at, extra) => Object.assign({
      id: id, createdAt: at, status: 'done', deliveryType: 'pickup', items: [], subtotal: 0, deliveryFee: 0, total: 0,
      customer: { name: '测试', phone: '13800000000', address: '' }
    }, extra);
    Mall._save(Mall.KEYS.orders, [
      mk('R1', todayAt(12), { status: 'done', deliveryType: 'delivery', items: [{ code: 'c1', name: '可口可乐', spec: '330ml', unit: '罐', price: 1.8, qty: 11 }], subtotal: 19.8, deliveryFee: 3, total: 22.8 }),
      mk('R2', todayAt(9), { status: 'pending', items: [{ code: 'c2', name: '加碘盐', spec: '400g', unit: '袋', price: 1.8, qty: 1 }], subtotal: 1.8, total: 1.8 }),
      mk('R3', daysAgo(1), { status: 'done', items: [{ code: 'c3', name: '农夫山泉', spec: '550ml', unit: '瓶', price: 12.9, qty: 1 }], subtotal: 12.9, total: 12.9 })
    ]);
    ctx.switchTab('report');
    ok(env.els.navReport.className.indexOf('on') >= 0 && env.els.viewReport.className.indexOf('hide') < 0, '侧栏「销售报表」可切换且视图显示');
    ok(env.els.crumb.textContent === '销售报表', '面包屑跟随切换：' + env.els.crumb.textContent);
    ok(env.els.rptRanges.innerHTML.split('chip').length - 1 === 6, '六个区间 chip');
    ok(env.els.rptRanges.innerHTML.indexOf('chip on') >= 0, '默认选中「今天」');
    ok(env.els.rptRange.textContent.indexOf(kToday) >= 0 && env.els.rptRange.textContent.indexOf('非取消') >= 0, '区间说明含日期与统计口径');
    ok((env.els.rptKpis.innerHTML.match(/class="kpi/g) || []).length === 8, '八张 KPI 卡');
    ok(env.els.rptKpis.innerHTML.indexOf('¥24.60') >= 0, '今日营业额 ¥24.60（22.80 + 1.80）');
    ok(env.els.rptKpis.innerHTML.indexOf('环比') >= 0, 'KPI 卡带环比文案');
    ok(env.els.rptKpis.innerHTML.indexOf('12 件') >= 0 && env.els.rptKpis.innerHTML.indexOf('2 个商品') >= 0, 'KPI 卡含售出件数与商品数');
    ok(ctx.kpiSize('¥27.00') === '' && ctx.kpiSize('¥0.00 / ¥0.00') === ' sm' && ctx.kpiSize('¥12345.67 / ¥23456.78') === ' xs',
      'KPI 数值按字符数降档：单值 26px / 成对 19px / 超长 15px');
    ok(env.els.rptKpis.innerHTML.indexOf('k-value sm">¥') >= 0, '「已完成 / 进行中」成对数值按降档类渲染（不许换行）');
    const themeCss = fs.readFileSync(path.join(__dirname, 'assets/theme.css'), 'utf8');
    ok(/\.kpi \.k-value \{[^}]*white-space: nowrap/.test(themeCss), 'theme.css：KPI 数值强制 nowrap，成对数值不许折成两行');
    ok(/\.kpi \.k-value\.sm \{[^}]*font-size: 19px/.test(themeCss) && /\.kpi \.k-value\.xs \{[^}]*font-size: 15px/.test(themeCss),
      'theme.css：含 19px / 15px 两档降级字号（长数值不撑破卡片）');
    ok((env.els.rptBars.innerHTML.match(/rpt-bar/g) || []).length === 1, '今天区间一根柱');
    ok(env.els.rptBars.innerHTML.indexOf('title="' + kToday) >= 0, '柱子带日期悬停提示');
    ctx.pickRange('7d');
    ok((env.els.rptBars.innerHTML.match(/rpt-bar/g) || []).length === 7, '近 7 天七根柱');
    ok(env.els.rptBarLabels.innerHTML.split('<span').length - 1 === 7, '近 7 天七个横轴刻度');
    ok(env.els.rptBars.innerHTML.indexOf('rpt-bar zero') >= 0, '零单日柱子灰显（不消失）');
    ok(env.els.rptRange.textContent.indexOf(kFirst7) >= 0, '近 7 天起点 = 6 天前：' + env.els.rptRange.textContent);
    ctx.pickRange('today');
    ok(env.els.rptTop.innerHTML.indexOf('可口可乐') >= 0 && env.els.rptTop.innerHTML.indexOf('91.7%') >= 0, '热销榜含商品与占比（11/12 = 91.7%）');
    ok(env.els.rptTop.innerHTML.indexOf('¥19.80') >= 0, '热销榜金额 = 1.80 × 11');
    ok(env.els.rptText.textContent.indexOf('销售日报') >= 0 && env.els.rptText.textContent.indexOf('营业额：¥24.60') >= 0, '日报预览已生成');
    ok(env.els.rptText.textContent.indexOf('热销 TOP 2') >= 0, '日报含热销 TOP');

    let printed = 0, snap = '';
    env.ctx.window.print = function () { printed++; snap = env.els.printRoot.innerHTML; };
    ctx.printReport();
    ok(printed === 1 && snap.indexOf('rptPrint') >= 0 && snap.indexOf('销售日报') >= 0, '打印日报唤起一次打印并写入打印区');
    ok(env.els.printRoot.innerHTML === '', '打印完清空打印区（不留残影）');

    let copied = '';
    env.ctx.navigator = { clipboard: { writeText: function (t) { copied = t; return Promise.resolve(); } } };
    ctx.copyReport();
    await new Promise(r => setTimeout(r, 20));
    ok(copied.indexOf('销售日报') >= 0 && copied.indexOf('热销 TOP') >= 0, '复制日报把纯文本送进剪贴板');
    ok(env.els.toast.className.indexOf('show') >= 0, '复制后有提示');

    Mall._save(Mall.KEYS.orders, []);
    ctx.renderReport();
    ok(env.els.rptTop.innerHTML.indexOf('还没有订单') >= 0, '零单时热销榜显示空状态');
    ok((env.els.rptBars.innerHTML.match(/rpt-bar zero/g) || []).length === 1, '零单时柱子为灰柱');
  }

  /* ---------- 顾客端：收货地址簿（D18） ---------- */
  section('⑦ index.html · 收货地址簿（结算带出 / 保存 / 管理）');
  {
    const env = await bootPage('index.html', offline);
    const ctx = env.ctx;
    const PHONE = '13800000001';
    // 结算/地址簿相关元素在启动时未被页面访问过，先按 id 取出来再断言
    ['cPhone', 'cName', 'cAddr', 'addrSave', 'addrPick', 'addrPickWrap', 'addrField', 'dlgCheckout', 'dlgAddr',
      'afPhone', 'afContact', 'afAddr', 'afDefault', 'afTitle', 'addrBookList', 'toast'].forEach(function (id) {
      env.els[id] = ctx.document.getElementById(id);
    });
    const els = env.els;
    const fill = function (name, addr) { els.cName.value = name; els.cAddr.value = addr; els.addrSave.checked = true; };
    const newOrder = async function (addr) {          // 真实流程：重新点结算 → 带出默认地址 → 按需改地址 → 下单
      Mall.addToCart('6901234567892', 2);
      await ctx.goCheckout();
      ctx.pickDelivery('delivery');
      if (addr) els.cAddr.value = addr;
      els.addrSave.checked = true;
      await ctx.submitOrder();
    };

    // 1) 空地址簿：给提示，不报错
    Mall.addToCart('6901234567892', 2);
    els.cPhone.value = PHONE;
    await ctx.goCheckout();
    ok(els.dlgCheckout.className.indexOf('show') >= 0, 'goCheckout 打开结算弹窗');
    ctx.pickDelivery('delivery');
    ok(els.addrField.className.indexOf('hide') < 0, '选配送 → 显示地址输入');
    ok(els.addrPickWrap.className.indexOf('hide') < 0, '选配送 → 显示常用地址区');
    ok(els.addrPick.innerHTML.indexOf('还没有存过地址') >= 0, '空地址簿给出提示文案');
    ctx.pickDelivery('pickup');
    ok(els.addrPickWrap.className.indexOf('hide') >= 0, '选自提 → 收起常用地址区');

    // 2) 下单勾选「保存到地址簿」→ 写入并成为默认
    ctx.pickDelivery('delivery');
    fill('王阿姨', '幸福路1号 3单元 501');
    await ctx.submitOrder();
    let book = Mall.listAddresses(PHONE);
    ok(book.length === 1 && book[0].contact === '王阿姨', '下单后自动存进地址簿');
    ok(book[0].isDefault === true, '第一条地址成为默认地址');
    ok(book[0].address === '幸福路1号 3单元 501', '存下来的地址内容正确');

    // 3) 带出的默认地址原样下单 → 不重复写；改了门牌 → 存成新的一条且不覆盖旧地址
    await newOrder(null);
    ok(Mall.listAddresses(PHONE).length === 1, '带出默认地址原样下单 → 不重复写地址簿');
    await newOrder('幸福路1号 3单元 502');
    book = Mall.listAddresses(PHONE);
    ok(book.length === 2, '换了地址再下单 → 新增一条');
    ok(book.filter(a => a.address === '幸福路1号 3单元 501').length === 1 && book[0].isDefault === true, '旧地址仍在且仍是默认（不被覆盖）');

    // 4) 再结算：默认地址一键带出并高亮
    els.cName.value = ''; els.cAddr.value = '';
    Mall._save('mall_customer', { name: '', phone: PHONE, address: '' });
    Mall.addToCart('6901234567892', 2);
    await ctx.goCheckout();
    ok(els.cName.value === '王阿姨' && els.cAddr.value === '幸福路1号 3单元 501', '默认地址自动带出收货人与地址');
    ctx.pickDelivery('delivery');
    ok(els.addrPick.innerHTML.indexOf('王阿姨') >= 0 && els.addrPick.innerHTML.indexOf('默认') >= 0, '常用地址区列出地址并标默认');
    ok(els.addrPick.innerHTML.indexOf('addr-item on') >= 0, '带出的那条高亮选中');

    // 5) 地址簿管理弹窗
    await ctx.openAddrBook();
    ok(els.dlgAddr.className.indexOf('show') >= 0, 'openAddrBook 打开地址簿弹窗');
    ok(els.afPhone.value === PHONE, '管理弹窗预填手机号');
    ok(els.addrBookList.innerHTML.indexOf('王阿姨') >= 0, '管理弹窗列出地址');
    ok(els.addrBookList.innerHTML.indexOf('编辑') >= 0 && els.addrBookList.innerHTML.indexOf('删除') >= 0, '每条含编辑/删除按钮');
    ok((els.addrBookList.innerHTML.match(/设为默认/g) || []).length === 1, '只有非默认那条显示「设为默认」');

    // 6) 新增一条：不抢默认，默认仍排最前
    const id1 = Mall.defaultAddress(PHONE).id;
    els.afContact.value = '王叔叔';
    els.afAddr.value = '幸福路2号 1单元 101';
    els.afDefault.checked = false;
    await ctx.saveAddrForm();
    book = Mall.listAddresses(PHONE);
    ok(book.length === 3, '新增地址成功（共 3 条）');
    ok(Mall.defaultAddress(PHONE).id === id1, '新地址不抢默认');

    // 7) 校验拦截：文案与后端一致
    els.afContact.value = '';
    await ctx.saveAddrForm();
    ok(els.toast.textContent === '收货人不能为空', '空收货人被拦截并提示：' + els.toast.textContent);
    ok(Mall.listAddresses(PHONE).length === 3, '被拦截时不写入');
    els.afContact.value = '王叔叔';

    // 8) 编辑 + 设为默认
    const id2 = Mall.listAddresses(PHONE).filter(a => a.contact === '王叔叔')[0].id;
    ctx.editAddr(id2);
    ok(els.afTitle.textContent === '编辑地址' && els.afContact.value === '王叔叔', '编辑回填表单');
    els.afAddr.value = '幸福路2号 1单元 102';
    await ctx.saveAddrForm();
    ok(Mall.listAddresses(PHONE).filter(a => a.address === '幸福路2号 1单元 102').length === 1, '编辑保存生效');
    await ctx.setDefaultAddr(id2);
    ok(Mall.defaultAddress(PHONE).id === id2, '「设为默认」生效');
    ok(els.addrBookList.innerHTML.indexOf('设为默认') >= 0, '换默认后原默认那条出现「设为默认」按钮');

    // 9) 删除默认 → 剩下最早一条顶为默认
    await ctx.delAddr(id2);
    book = Mall.listAddresses(PHONE);
    ok(book.length === 2 && book.filter(a => a.id === id1).length === 1, '删除地址生效');
    ok(book.filter(a => a.isDefault).length === 1 && Mall.defaultAddress(PHONE).id === id1, '删掉默认地址 → 剩下最早一条顶为默认');

    // 10) 清空按钮
    ctx.editAddr(id1);
    ctx.resetAddrForm();
    ok(els.afTitle.textContent === '新增地址' && els.afContact.value === '' && els.afPhone.value === PHONE, 'resetAddrForm 清空表单并保留手机号');
  }

  /* ---------- 管理端 · 批量改价 / 批量操作（D20） ---------- */
  section('⑨ admin.html · 批量改价 / 批量操作（D20）');
  {
    const env = await bootPage('admin.html', offline);
    const ctx = env.ctx;
    const el = id => ctx.document.getElementById(id);
    ctx.switchTab('products');
    ok(el('bulkPreview').innerHTML.indexOf('还没有勾选商品') >= 0, '未勾选时预览区给空状态');
    ok(env.els.bulkFilterCount.textContent === '6', '面板显示当前筛选商品数：' + env.els.bulkFilterCount.textContent);

    Admin.saveProduct({ code:'BB1', name:'批量甲', category:'饮料', unit:'瓶', costPrice:6, salePrice:9, refPrice:10, isWholesale:false, stock:12 });
    Admin.saveProduct({ code:'BB2', name:'批量乙', category:'饮料', unit:'瓶', costPrice:14, salePrice:20, refPrice:10, isWholesale:true, stock:3 });
    env.els.prodQ.value = '批量';
    ctx.renderProducts();
    ok(env.els.prodTable.innerHTML.indexOf('批量甲') >= 0 && env.els.prodTable.innerHTML.indexOf('可口可乐') < 0, '按关键词筛选出待批量商品');
    ok(env.els.bulkFilterCount.textContent === '2', '筛选计数同步为 2');

    ctx.bulkSelectAll();
    ok(env.els.prodAll.checked === true, '「勾选当前筛选」后表头全选态为真');
    ok((env.els.prodTable.innerHTML.match(/checked onchange/g) || []).length === 2, '表格里 2 行 checkbox 都被勾上');
    ok(env.els.bulkSelHint.textContent.indexOf('已勾选 2 个') >= 0, '面板提示：' + env.els.bulkSelHint.textContent);

    env.els.bulkMode.value = 'pct'; env.els.bulkValue.value = '20'; env.els.bulkStep.value = '0.01';
    ctx.renderBulkPreview();
    ok(env.els.bulkPreview.innerHTML.indexOf('超防线') >= 0, '预览标出超防线商品（BB1 10.80 > 9.50）');
    ok(env.els.bulkPreview.innerHTML.indexOf('批发') >= 0, '预览标出批发商品（跳过比价检查）');
    ok(env.els.bulkSelHint.textContent.indexOf('可改 1') >= 0 && env.els.bulkSelHint.textContent.indexOf('超防线 1') >= 0, '面板汇总：可改 1 / 超防线 1');

    ctx.useBulkCaps();
    ok(env.els.bulkSelHint.textContent.indexOf('可改 2') >= 0, '「按防线顶格」后可改变 2 个');
    ok(env.els.bulkPreview.innerHTML.indexOf('9.50') >= 0, '预览出现顶格价 9.50');

    const logBefore = Admin.getStockLog().length;
    await ctx.applyBulk();
    ok(Mall.getProduct('BB1').salePrice === 9.5 && Mall.getProduct('BB2').salePrice === 24, '批量改价落库：9.50 / 24.00');
    ok(Mall.getProduct('BB1').stock === 12 && Mall.getProduct('BB2').stock === 3, '批量改价一律不动库存（D16）');
    ok(Admin.getStockLog().length === logBefore + 2, '每款写一条商品流水');
    ok(env.els.bulkResult.innerHTML.indexOf('成功 2 个') >= 0, '结果区显示成功数');
    ok(env.els.toast.className.indexOf('show') >= 0, '完成后弹 toast');

    el('bulkCat').value = ' 冲调 ';
    await ctx.applyBulkCat();
    ok(Mall.getProduct('BB1').category === '冲调' && Mall.getProduct('BB2').category === '冲调', '批量改分类落库（并 trim）');
    ok(env.els.bulkResult.innerHTML.indexOf('批量改分类：冲调') >= 0, '结果区带改分类标签');
    ok(Mall.getProduct('BB1').salePrice === 9.5, '改分类不动售价');

    el('bulkWhole').value = '1';
    await ctx.applyBulkWhole();
    ok(Mall.getProduct('BB1').isWholesale === true && Mall.getProduct('BB2').isWholesale === true, '批量设为批发生效');
    el('bulkWhole').value = '0';
    await ctx.applyBulkWhole();
    ok(Mall.getProduct('BB1').isWholesale === false, '批量取消批发：合规那款生效');
    ok(Mall.getProduct('BB2').isWholesale === true, '取消批发后被比价防线拦住（BB2 售 24.00 > 顶格 9.50）');
    ok(el('bulkResult').innerHTML.indexOf('取消批发后') >= 0, '结果区说明被拦原因');
    ok(Mall.getProduct('BB2').salePrice === 24 && Mall.getProduct('BB1').salePrice === 9.5, '被拦的款价格分毫未动');

    ctx.bulkClear();
    ok(env.els.bulkSelHint.textContent.indexOf('先在上表勾选') >= 0, '清空勾选后回到未选状态');
    ok(env.els.bulkResult.innerHTML === '', '清空勾选同时清空上一批结果');
    env.els.prodQ.value = '';
    ctx.renderProducts();
    ok(env.els.bulkFilterCount.textContent === '8', '清空关键词后计数回到全部 8 个商品');
  }

  /* ---------- 任务池⑥：商品图片与分类管理 / 批量上下架（D23） ---------- */
  section('⑩ 商品图片与上下架（任务池⑥ / D23）');
  {
    // 顾客端：有图用图，没图回退 emoji；下架商品整条链路都拦住
    const env = await bootPage('index.html', offline);
    const ctx = env.ctx;
    Mall.updateProduct('6901234567892', { img: 'https://cdn.example.com/kele.jpg' });
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('<img class="pimg" src="https://cdn.example.com/kele.jpg"') >= 0, '顾客端商品卡渲染商品图');
    Mall.updateProduct('6901234567892', { onSale: false });
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('可口可乐') < 0, '下架商品从顾客端列表消失');
    ctx.openDetail('6901234567892');
    ok(env.els.toast.textContent.indexOf('已下架') >= 0, '直接点开下架商品 → 提示已下架：' + env.els.toast.textContent);
    ok(!env.els.dlgDetail || env.els.dlgDetail.className.indexOf('show') < 0, '下架商品不会打开详情弹窗');
    Mall.updateProduct('6901234567892', { onSale: true });
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('可口可乐') >= 0, '重新上架后顾客端又能看到');
    Mall.updateProduct('6901234567892', { img: '' });
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('class="pimg"') < 0, '没填图片时回退 emoji 占位');

    // 管理端：缩略图列 / 图片字段 / 单个上下架 / 批量上下架 / 分类改名入口
    const aenv = await bootPage('admin.html', { fetch: offline.fetch, prompt: () => '酒水' });
    const actx = aenv.ctx;
    ok(aenv.els.prodTable.innerHTML.indexOf('class="thumb-wrap') >= 0, '商品表格每行有缩略图占位');
    ok(aenv.els.prodTable.innerHTML.indexOf('>下架</button>') >= 0, '在售商品行有「下架」按钮');
    ok(aenv.els.prodCats.innerHTML.indexOf('chip-x') >= 0, '分类 chip 带改名入口（分类管理）');

    actx.openProductDlg('6901234567892');
    ok(!!aenv.els.pfImg, '建档表单有「商品图片地址」字段');
    aenv.els.pfImg.value = ' https://cdn.example.com/kele.jpg ';
    await actx.submitProduct();
    ok(Mall.getProduct('6901234567892').img === 'https://cdn.example.com/kele.jpg', '表单保存图片地址（自动去空格）');
    actx.renderProducts();
    ok(aenv.els.prodTable.innerHTML.indexOf('<img class="thumb" src="https://cdn.example.com/kele.jpg"') >= 0, '缩略图列渲染商品图');
    ok(aenv.els.prodTable.innerHTML.indexOf('可口可乐') >= 0 && aenv.els.prodTable.innerHTML.indexOf('编辑') >= 0, '加图后商品行仍完整渲染');

    await actx.toggleOnSale('6901234567892');
    ok(Mall.getProduct('6901234567892').onSale === false, '点「下架」→ 商品转为下架');
    ok(aenv.els.prodTable.innerHTML.indexOf('已下架') >= 0, '表格标出「已下架」badge');
    ok(aenv.els.prodTable.innerHTML.indexOf('>上架</button>') >= 0, '按钮切换为「上架」');
    await actx.toggleOnSale('6901234567892');
    ok(Mall.getProduct('6901234567892').onSale === true, '再点一次 → 重新上架');

    // 分类改名（合并到已有分类）
    actx.bulkClear();
    const renamed = await actx.renameCat('饮料');
    ok(Mall.loadCatalog().filter(p => p.category === '饮料').length === 0, '分类改名：饮料下的商品全部挪走');
    ok(Mall.loadCatalog().filter(p => p.category === '酒水').length >= 2, '分类改名：合并到「酒水」');

    // 批量上下架：勾选当前筛选 → 下架 → 再上架
    actx.bulkClear();
    actx.bulkSelectAll();
    aenv.els.bulkOnSale = fakeEl('bulkOnSale');
    aenv.els.bulkOnSale.value = '0';
    await actx.applyBulkOnSale();
    ok(Mall.loadCatalog().every(p => p.onSale === false), '批量下架：当前筛选内商品全部下架');
    ok(aenv.els.bulkResult.innerHTML.indexOf('下架') >= 0, '批量结果区给出回执：' + aenv.els.bulkResult.innerHTML.replace(/<[^>]+>/g, '').slice(0, 30));
    aenv.els.bulkOnSale.value = '1';
    await actx.applyBulkOnSale();
    ok(Mall.loadCatalog().every(p => p.onSale !== false), '批量上架：全部恢复在售');
  }

  /* ---------- 任务池⑦：批发价与顾客等级（D24） ---------- */
  section('⑪ 批发价与顾客等级（任务池⑦ / D24）');
  {
    // 顾客端（离线演示）：批发等级 → 看到批发价，原零售价划线；按钮标出身份
    const env = await bootPage('index.html', { fetch: offline.fetch, prompt: () => '13800001111' });
    const ctx = env.ctx;
    ok(!!env.els.btnMyPrice, '顾客端有「我的价格」入口');
    ok(env.els.btnMyPrice.textContent.indexOf('我的价格') >= 0, '默认未填手机号 → 「我的价格」');
    Mall.updateProduct('6901234567892', { wholesalePrice: 2.2 });
    Mall.setMyPhone('13800001111');
    Mall._save('mall_customers', { '13800001111': { tier: 'wholesale' } });
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('2.20') >= 0, '批发等级顾客看到批发价 2.20');
    ok(env.els.grid.innerHTML.indexOf('class="oldp"') >= 0, '原零售价划线显示');
    ctx.renderMyPrice();
    ok(env.els.btnMyPrice.textContent.indexOf('批发') >= 0, '「我的价格」按钮标出批发身份：' + env.els.btnMyPrice.textContent);
    Mall.addToCart('6901234567892', 2);
    ctx.renderCart();
    ok(env.els.cartLines.innerHTML.indexOf('批发价') >= 0, '购物车行标「批发价」');
    ok(env.els.cartSubtotal.textContent.indexOf('4.40') >= 0, '购物车小计按有效价（2.20×2）');
    // 点「我的价格」输入手机号 → 本地演示也能按等级显示
    await ctx.openMyPrice();
    ok(env.els.btnMyPrice.textContent.indexOf('批发') >= 0 && env.els.btnMyPrice.title.indexOf('13800001111') >= 0, '输入手机号后按钮显示我的等级与手机号');
    ok(env.els.toast.textContent.indexOf('批发价') >= 0 || env.els.toast.textContent.indexOf('批发') >= 0, '给出价格口径提示：' + env.els.toast.textContent.slice(0, 40));
    Mall.setMyPhone('');
    ctx.renderGrid();
    ok(env.els.grid.innerHTML.indexOf('class="oldp"') < 0, '切回零售价后不再划线');

    // 管理端：批发价字段 + 顾客等级登记 / 改等级
    const aenv = await bootPage('admin.html', { fetch: offline.fetch, prompt: () => null });
    const actx = aenv.ctx;
    actx.openProductDlg('6901234567892');
    ok(!!aenv.els.pfWholesale, '建档表单有「批发价」字段');
    aenv.els.pfWholesale.value = ' 2.2 ';
    await actx.submitProduct();
    ok(Mall.getProduct('6901234567892').wholesalePrice === 2.2, '表单保存批发价（自动去空格转数字）');
    actx.renderProducts();
    ok(aenv.els.prodTable.innerHTML.indexOf('批 ¥2.20') >= 0, '商品表标出批发价');
    // 批发价高于零售价 → 拦住（不静默改价）
    actx.openProductDlg('6901234567892');
    aenv.els.pfWholesale.value = '99';
    await actx.submitProduct();
    ok(Mall.getProduct('6901234567892').wholesalePrice === 2.2, '批发价高于零售价被拦住，原值不变');
    ok(aenv.els.toast.textContent.indexOf('批发价') >= 0, '给出拦截文案：' + aenv.els.toast.textContent.slice(0, 40));

    // 顾客页：登记一个没下过单的批发客户 → 卡片带「批发价」徽标
    aenv.els.newCustPhone = fakeEl('newCustPhone');
    aenv.els.newCustName = fakeEl('newCustName');
    aenv.els.newCustTier = fakeEl('newCustTier');
    aenv.els.newCustPhone.value = '13800001111';
    aenv.els.newCustName.value = '王老板';
    aenv.els.newCustTier.value = 'wholesale';
    await actx.addCustomer();
    const cust = Admin.getCustomers().find(c => c.phone === '13800001111');
    ok(!!cust && cust.tier === 'wholesale', '登记未下单的顾客也能设等级');
    ok(aenv.els.custList.innerHTML.indexOf('批发价') >= 0 && aenv.els.custList.innerHTML.indexOf('王老板') >= 0, '顾客卡片显示「批发价」徽标与姓名');
    ok(aenv.els.newCustPhone.value === '', '登记后清空输入框');
    // 改等级 → vip（价格只影响之后的单）
    aenv.els['tier_13800001111'] = fakeEl('tier_13800001111');
    aenv.els['tier_13800001111'].value = 'vip';
    await actx.saveTier('13800001111');
    ok(Admin.getCustomers().find(c => c.phone === '13800001111').tier === 'vip', '改等级为白名单生效');
    ok(aenv.els.custList.innerHTML.indexOf('白名单价') >= 0, '卡片徽标跟着变成「白名单价」');
    ok(aenv.els.toast.textContent.indexOf('白名单') >= 0, '提示「下次下单按新等级算价」：' + aenv.els.toast.textContent.slice(0, 40));
  }

  /* ---------- 管理端：库存审计 / 配送员 / 门店抬头（D25） ---------- */
  section('⑫ 库存审计 / 配送员 / 门店抬头（任务池⑧ / D25）');
  {
    const calls = [];
    const fixedAt = 1760000000000;
    const fetch25 = async (url, opts) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      const method = (opts && opts.method) || 'GET';
      let body = null;
      if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = opts.body; } }
      calls.push({ method: method, path: p, body: body });
      const replies = {
        'GET /healthz': { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true },
        'GET /api/products': { total: 1, items: [
          { code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', category: '饮料', salePrice: 2.5, wholesalePrice: 2.2, price: 2.5, costPrice: 1.8, refPrice: 3, unit: '罐', stock: 10, syncStatus: 'synced' }] },
        'GET /api/orders': { total: 0, items: [] },
        'GET /api/customers': { total: 0, items: [] },
        'GET /api/stocklog?limit=30': { total: 1, items: [
          { id: 41, at: fixedAt, ts: '2026-10-12T09:00:00+08:00', kind: 'stock_in', code: '6901234567892',
            name: '可口可乐', unit: '罐', delta: 30, before: 10, after: 40, reason: '整箱到货', by: '老板' }] },
        'GET /api/couriers': { total: 4, items: [{ name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' }] },
        'GET /api/settings': { name: '家庭超市', phone: '0771-1234567', address: '水东洋路 1 号', footer: '谢谢惠顾，欢迎再来！' }
      };
      let hit = replies[method + ' ' + p];
      if (hit === undefined) {
        if (p === '/api/stock/change' && method === 'POST') {
          hit = { ok: true, stock: 40, entry: { id: 42, at: fixedAt, ts: '2026-10-12T09:05:00+08:00', kind: body.kind,
            code: body.code, name: '可口可乐', unit: '罐', delta: body.qty, before: 10, after: 40,
            reason: body.reason, by: body.by } };
        } else if (p === '/api/couriers' && method === 'POST') {
          hit = body.remove
            ? { ok: true, total: 4, items: [{ name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' }] }
            : { ok: true, total: 5, items: [{ name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' }, { name: body.name, phone: body.phone }] };
        } else if (p === '/api/settings' && method === 'POST') {
          hit = { name: body.name, phone: body.phone, address: body.address, footer: body.footer || '谢谢惠顾，欢迎再来！' };
        } else if (p === '/api/customers/note' && method === 'POST') {
          hit = { phone: body.phone, name: body.name, tier: 'retail', tags: body.tags, note: body.note };
        }
      }
      if (hit === undefined) return { ok: false, status: 404, text: async () => JSON.stringify({ error: 'no route ' + p }) };
      return { ok: true, status: 200, text: async () => JSON.stringify(hit) };
    };
    const aenv = await bootPage('admin.html', { base: 'http://127.0.0.1:8093', fetch: fetch25, wait: 250 });
    const actx = aenv.ctx;
    const posted = (path) => calls.filter(c => c.method === 'POST' && c.path === path);

    // 开机从后端拉镜像：配送员名单 / 门店抬头 / 库存流水
    ok(aenv.els.couriers.value.indexOf('老张') >= 0 && aenv.els.couriers.value.indexOf('小美') >= 0, '开机把后端配送员名单填进输入框');
    ok(aenv.els.stName.value === '家庭超市' && aenv.els.stFooter.value.indexOf('谢谢惠顾') >= 0, '开机把后端门店抬头填进表单');
    ok(aenv.els.stockLog.innerHTML.indexOf('整箱到货') >= 0 && aenv.els.stockLog.innerHTML.indexOf('10 → ') >= 0, '库存流水页渲染后端审计流水');
    ok(aenv.els.stockLogCount.textContent.indexOf('后端审计') >= 0, '流水标题标出「后端审计」：' + aenv.els.stockLogCount.textContent);

    // 入库：走服务端唯一入口，服务端流水镜像回本地
    aenv.els['si_6901234567892'] = fakeEl('si_6901234567892'); aenv.els['si_6901234567892'].value = '30';
    aenv.els['sr_6901234567892'] = fakeEl('sr_6901234567892'); aenv.els['sr_6901234567892'].value = '整箱到货';
    await actx.doStockIn('6901234567892');
    const p1 = posted('/api/stock/change')[0];
    ok(!!p1 && p1.body.kind === 'stock_in' && p1.body.qty === 30 && p1.body.reason === '整箱到货', '在线入库 → POST /api/stock/change（kind=stock_in）');
    ok(aenv.els.toast.textContent.indexOf('已入库') >= 0 && aenv.els.toast.textContent.indexOf('10 → 40') >= 0, '回执用服务端前后值：' + aenv.els.toast.textContent.slice(0, 24));
    ok(Mall.getProduct('6901234567892').stock === 40, '本地库存镜像对齐服务端（40）');

    // 盘点：实盘数与账面一致就别打扰后端
    aenv.els['st_6901234567892'] = fakeEl('st_6901234567892'); aenv.els['st_6901234567892'].value = '40';
    await actx.doTake('6901234567892');
    ok(posted('/api/stock/change').length === 1, '实盘数 == 账面数 → 不发请求');
    ok(aenv.els.toast.textContent.indexOf('无需校准') >= 0, '提示无需校准：' + aenv.els.toast.textContent.slice(0, 20));

    // 改数：走服务端
    aenv.els['ad_6901234567892'] = fakeEl('ad_6901234567892'); aenv.els['ad_6901234567892'].value = '-5';
    aenv.els['ar_6901234567892'] = fakeEl('ar_6901234567892'); aenv.els['ar_6901234567892'].value = '整箱到货';
    await actx.doAdjust('6901234567892');
    const p2 = posted('/api/stock/change')[1];
    ok(!!p2 && p2.body.kind === 'adjust' && p2.body.qty === -5, '在线改数 → POST /api/stock/change（kind=adjust, qty=-5）');

    // 配送员：按差集同步到后端
    aenv.els.couriers.value = '老张，小李，阿强，小美，阿明';
    await actx.saveCouriers();
    const cp = posted('/api/couriers')[0];
    ok(!!cp && cp.body.name === '阿明' && cp.body.remove === false, '新增配送员 → POST /api/couriers');
    ok(aenv.els.toast.textContent.indexOf('已保存到后端') >= 0, '配送员保存回执来自后端：' + aenv.els.toast.textContent.slice(0, 26));
    aenv.els.couriers.value = '   ';
    await actx.saveCouriers();
    ok(aenv.els.toast.textContent.indexOf('不能为空') >= 0, '空名单直接拦下（后端至少要留一位）');

    // 门店抬头：在线写后端并把返回值当本地镜像
    aenv.els.stName.value = '水东洋便利店'; aenv.els.stPhone.value = ''; aenv.els.stAddr.value = '水东洋路 2 号'; aenv.els.stFooter.value = '';
    await actx.saveStore();
    const sp = posted('/api/settings')[0];
    ok(!!sp && sp.body.name === '水东洋便利店' && sp.body.footer === '', '门店抬头 → POST /api/settings');
    ok(Admin.getStoreInfo().name === '水东洋便利店' && Admin.getStoreInfo().footer.indexOf('谢谢惠顾') >= 0, '本地镜像用后端返回值（页脚留空回默认）');

    // 顾客备注：写后端（Node 里 Admin 层跳过后端调用，页面回执仍走通）
    aenv.els.tag_13800001111 = fakeEl('tag_13800001111'); aenv.els.tag_13800001111.value = '熟客';
    aenv.els.note_13800001111 = fakeEl('note_13800001111'); aenv.els.note_13800001111.value = '常买整箱水';
    await actx.saveNote('13800001111');
    ok(aenv.els.toast.textContent.indexOf('顾客档案已保存') >= 0, '备注保存回执：' + aenv.els.toast.textContent.slice(0, 20));
  }

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

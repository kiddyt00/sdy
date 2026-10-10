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
  SdyApi.configure({ fetchImpl: fetchImpl, mall: Mall, timeoutMs: 300, base: (opts && opts.base) || '' });

  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, AbortController: AbortController,
    document: { getElementById: id => (els[id] || (els[id] = fakeEl(id))), querySelectorAll: () => [] },
    localStorage: localStorage, window: window, fetch: fetchImpl,
    confirm: () => true, alert: () => {},
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
    ok(env.els.modeBadge.textContent.indexOf('本地演示') >= 0, '顶部状态：' + env.els.modeBadge.textContent);
    ok(env.els.grid.innerHTML.indexOf('可口可乐') >= 0, '商品网格已渲染（含种子商品）');
    ok(env.els.cats.innerHTML.indexOf('全部') >= 0, '分类栏已渲染');
    ok(env.els.cartDot.innerHTML !== undefined, '购物车角标元素存在');
    ok(env.els.filters.innerHTML.indexOf('待备货') >= 0, '订单筛选栏已渲染');
  }

  /* ---------- 顾客端：在线 ---------- */
  section('② index.html · 后端可用（拉镜像）');
  {
    const env = await bootPage('index.html', online);
    ok(env.els.modeBadge.textContent.indexOf('已连接') >= 0, '顶部状态：' + env.els.modeBadge.textContent);
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
    env.els.stName.value = '小邻里超市';
    env.els.stPhone.value = '0571-88888888';
    env.els.stAddr.value = '幸福路 1 号';
    env.els.stFooter.value = '欢迎再来';
    ctx.saveStore();
    ok(Admin.getStoreInfo().name === '小邻里超市', '抬头保存进本地设置');
    ctx.printOrder(o.id);
    ok(env.els.printRoot.innerHTML.indexOf('小邻里超市') >= 0 && env.els.printRoot.innerHTML.indexOf('0571-88888888') >= 0, '再打印时票头已更新');
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

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

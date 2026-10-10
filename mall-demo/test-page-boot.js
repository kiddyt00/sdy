/* =====================================================================
 * 页面启动冒烟测试（假 DOM，不起浏览器）
 *   把 mall.html / admin.html 里的内联脚本真的跑一遍，捕获启动期报错，
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
  console.log('页面启动冒烟：mall.html / admin.html（假 DOM，真跑内联脚本）');

  /* ---------- 顾客端：离线 ---------- */
  section('① mall.html · 后端不可用（本地演示）');
  {
    const env = await bootPage('mall.html', offline);
    ok(env.els.modeBadge.textContent.indexOf('本地演示') >= 0, '顶部状态：' + env.els.modeBadge.textContent);
    ok(env.els.grid.innerHTML.indexOf('可口可乐') >= 0, '商品网格已渲染（含种子商品）');
    ok(env.els.cats.innerHTML.indexOf('全部') >= 0, '分类栏已渲染');
    ok(env.els.cartDot.innerHTML !== undefined, '购物车角标元素存在');
    ok(env.els.filters.innerHTML.indexOf('待备货') >= 0, '订单筛选栏已渲染');
  }

  /* ---------- 顾客端：在线 ---------- */
  section('② mall.html · 后端可用（拉镜像）');
  {
    const env = await bootPage('mall.html', online);
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

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

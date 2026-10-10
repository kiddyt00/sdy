/* =====================================================================
 * barcode-demo/test-page-boot.js —— 扫码台页面启动冒烟（假 DOM，不起浏览器）
 *
 * 真的把 bd-api.js + app.js 放进同一个沙箱跑一遍（等同浏览器 <script> 顺序），
 * 覆盖两条路径：① 后端不可用 → 本地演示链路照常  ② 后端可用 → 镜像 + 服务端解析/建档
 * 运行：node barcode-demo/test-page-boot.js
 * ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ❌ ' + msg); }
}
function eq(got, want, msg) { ok(got === want, msg + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）'); }
function section(t) { console.log('\n▶ ' + t); }

const HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function fakeEl(id) {
  const el = {
    id: id || '', innerHTML: '', textContent: '', value: '', className: '', title: '',
    style: {}, checked: false, dataset: {}, onclick: null, onchange: null,
    _kids: [],
    classList: { toggle: function () {}, add: function () {}, remove: function () {} },
    appendChild: function (c) { this._kids.push(c); return c; },
    remove: function () {},
    focus: function () {}, select: function () {}, scrollIntoView: function () {},
    addEventListener: function () {}, removeEventListener: function () {}, dispatchEvent: function () {},
    querySelector: function (sel) { return fakeEl(sel); }
  };
  return el;
}

function makeEnv(opts) {
  const els = {};
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); }
  };
  const listeners = {};
  const window = {
    addEventListener: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); },
    SDY_API_BASE: (opts && opts.base) || undefined
  };
  const fetchImpl = (opts && opts.fetch) || (async () => { throw new Error('offline'); });

  const q = {};
  q['.tab'] = [...HTML.matchAll(/data-tab="([^"]+)"/g)].map(m => { const e = fakeEl(''); e.dataset.tab = m[1]; return e; });
  q['.chip'] = [...HTML.matchAll(/data-code="([^"]+)"/g)].map(m => { const e = fakeEl(''); e.dataset.code = m[1]; return e; });
  q['.pane'] = [...HTML.matchAll(/id="(pane-[^"]+)"/g)].map(m => fakeEl(m[1]));

  const sandbox = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout, setInterval: setInterval,
    clearInterval: clearInterval, AbortController: AbortController,
    JSON: JSON, Math: Math, Date: Date, Promise: Promise, Number: Number, String: String,
    localStorage: localStorage, window: window, fetch: fetchImpl,
    document: {
      getElementById: id => (els[id] || (els[id] = fakeEl(id))),
      querySelector: sel => (sel.charAt(0) === '#' ? (els[sel.slice(1)] || (els[sel.slice(1)] = fakeEl(sel.slice(1)))) : fakeEl(sel)),
      querySelectorAll: sel => q[sel] || [],
      createElement: () => fakeEl(''),
      body: fakeEl('body'),
      addEventListener: () => {}
    },
    confirm: () => true, alert: () => {},
    module: { exports: {} }
  };
  sandbox.globalThis = sandbox;
  return { sandbox: sandbox, els: els, listeners: listeners, fetchImpl: fetchImpl };
}

function boot(opts) {
  const env = makeEnv(opts);
  const ctx = vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'bd-api.js'), 'utf8'), ctx, { filename: 'bd-api.js' });
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });
  (env.listeners['DOMContentLoaded'] || []).forEach(fn => fn());   // 模拟页面加载完成
  return env;
}

// 后端假响应：healthz / 商品 / 字典 / 解析 / 建档
function serverFetch(log) {
  const products = [
    { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', unit: '罐', costPrice: 2.2, salePrice: 2.5, stock: 118, syncStatus: 'synced', createdAt: '2026-10-10T10:00:00+08:00' },
    { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', unit: '瓶', costPrice: 1.5, salePrice: 1.8, stock: 200, syncStatus: 'pending', createdAt: '2026-10-10T10:00:00+08:00' }
  ];
  const lib = [
    { code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', source: 'product', status: 'found', hits: 9 },
    { code: '6902083884567', name: '东方树叶 乌龙茶', spec: '500ml', source: 'cloud', status: 'found', hits: 2 },
    { code: '6900000000000', source: 'cloud', status: 'not_found', hits: 1, expiresAt: new Date(Date.now() + 88 * 86400000).toISOString() }
  ];
  return async function (url, init) {
    const method = (init && init.method) || 'GET';
    log.push(method + ' ' + url);
    const json = (status, body) => ({ ok: status < 400, status: status, json: async () => body });
    if (url.indexOf('/healthz') >= 0) return json(200, { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true });
    if (url.indexOf('/api/barcode/resolve') >= 0) {
      const code = url.split('code=')[1];
      if (code === '6902083884567') return json(200, { code: code, found: true, name: '东方树叶 乌龙茶', spec: '500ml', source: 'lib' });
      return json(200, { code: code, found: true, name: '可口可乐', spec: '330ml 罐装', source: 'product' });
    }
    if (url.indexOf('/api/barcode/lib') >= 0) return json(200, { items: lib, total: lib.length });
    if (url.indexOf('/api/products?keyword=') >= 0) {
      const code = decodeURIComponent(url.split('keyword=')[1]);
      return json(200, { items: products.filter(p => p.code === code), total: 1 });
    }
    if (url.indexOf('/api/products') >= 0 && method === 'POST') {
      return json(200, Object.assign({ code: '6990000000001', name: '新商品', salePrice: 6, stock: 5, unit: '瓶', syncStatus: 'pending' }, JSON.parse(init.body)));
    }
    if (url.indexOf('/api/products') >= 0) return json(200, { items: products, total: products.length });
    return json(404, { error: 'no route' });
  };
}

(async function main() {
  console.log('=== 扫码台页面启动冒烟（bd-api.js + app.js 同沙箱） ===');

  /* ---------------- 1. 后端不在 → 本地演示 ---------------- */
  section('1. 后端不可用：本地演示链路照常可用');
  let env = boot({});
  let App = env.sandbox.module.exports;
  ok(!!App && typeof App.resolve === 'function', 'app.js 正常加载并导出 DemoApp');
  let badge = env.els['modeBadge'];
  ok(!!badge, '页面上有后端状态胶囊 #modeBadge');
  ok(badge.textContent.indexOf('本地演示') >= 0, '离线胶囊文案＝本地演示，实际 ' + badge.textContent);
  eq(env.els['cloudStats'].style.display, 'flex', '离线时本地配额看板可见');
  ok((env.els['apiNote'].innerHTML || '').indexOf('未连接后端') >= 0, '设置页提示未连接后端');
  let r = await App.resolve('6901234567892');
  eq(r.source, 'product', '离线时走本地档案层');
  eq(r.product.salePrice, 2.5, '离线数据来自演示种子');
  const localNew = App.createProduct({ code: '6900000000009', name: '本地建档测试', salePrice: 3 });
  eq(localNew.code, '6900000000009', '离线可本地建档');
  eq(App.deleteProduct('6900000000009'), true, '离线可用演示用删除');

  /* ---------------- 2. 后端在线 → 服务端链路 ---------------- */
  section('2. 后端可用：镜像 + 解析/建档交给服务端');
  const log = [];
  env = boot({ base: 'http://127.0.0.1:8097', fetch: serverFetch(log) });
  App = env.sandbox.module.exports;
  await new Promise(res => setTimeout(res, 200));      // 等 initApi 探测 + 拉镜像
  badge = env.els['modeBadge'];
  ok(badge.textContent.indexOf('后端已连接') >= 0, '在线胶囊文案＝后端已连接，实际 ' + badge.textContent);
  eq(env.els['cloudStats'].style.display, 'none', '在线时隐藏本地配额看板（配额在服务端）');
  ok((env.els['apiNote'].innerHTML || '').indexOf('APPCODE 只在服务端') >= 0, '设置页点明 APPCODE 只在服务端');
  ok(log.some(l => l.indexOf('/healthz') >= 0), '启动时探测过后端');
  eq(App._state.products.length, 2, '商品库镜像为服务端数据');
  ok(App._state.products.every(p => p.server === true), '镜像项标记 server=true');
  eq(App._state.products[0].syncStatus, '已同步', 'syncStatus 映射正常');
  eq(App._state.lib.length, 3, '条码字典镜像为服务端数据（能看到库里数据了）');
  eq(App._state.lib[0].hits, 9, '字典命中次数透传');

  r = await App.resolve('6902083884567');
  eq(r.source, 'lib', '在线时解析走服务端（字典命中）');
  eq(r.server, true, '结果标记来自服务端');
  ok(App._state.log[0].detail.indexOf('服务端解析') >= 0, '日志注明服务端解析：' + App._state.log[0].detail);

  r = await App.resolve('6901234567892');
  eq(r.source, 'product', '在线时档案层命中');
  eq(r.product.stock, 118, '价格/库存取自服务端档案（不是云端）');

  const saved = await App.saveProduct({ code: '6990000000001', name: '新商品', salePrice: 6, stock: 5, unit: '瓶' });
  eq(saved.code, '6990000000001', '在线建档写入服务端');
  ok(log.some(l => l.indexOf('POST ') === 0 && l.indexOf('/api/products') >= 0), '建档发出 POST /api/products（实际请求：' + log.filter(l => l.indexOf('POST') === 0).join(' | ') + '）');
  ok(App._state.log[0].detail.indexOf('服务端') >= 0, '建档日志注明服务端');

  eq(App.deleteProduct('6901234567892'), false, '在线时禁止演示删除（护对账口径）');
  eq(App._state.products.length, 2, '禁止删除后商品数不变');

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILED') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('冒烟异常：', e); process.exit(1); });

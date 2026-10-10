/* =====================================================================
 * 前端接后端（sdy-api.js）测试 —— 用假 fetch 覆盖两种模式
 *   ① 本地降级：探测失败 → 全部动作走 localStorage/Mall
 *   ② 后端优先：探测成功 → 读写都走后端，localStorage 只当镜像
 * 运行：node test-sdy-api.js
 * ===================================================================== */
'use strict';
const Mall = require('./mall.js');
const SdyApi = require('./sdy-api.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ ' + msg); }
}
function section(t) { console.log('\n■ ' + t); }

/* ---------------- 假 fetch ---------------- */
function mkFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    let body = null;
    if (opts && opts.body) { try { body = JSON.parse(opts.body); } catch (e) { body = opts.body; } }
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    calls.push({ method: method, path: path, url: String(url), body: body });
    for (const r of routes) {
      if (r.method === method && (r.path === path || (r.re && r.re.test(path)))) {
        if (r.throw) throw new Error(r.throw);
        const status = r.status || 200;
        const payload = (typeof r.body === 'function') ? r.body({ method: method, path: path, body: body }) : r.body;
        return { ok: status < 400, status: status, text: async () => JSON.stringify(payload === undefined ? {} : payload) };
      }
    }
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: '无此路由: ' + path }) };
  };
  f.calls = calls;
  return f;
}

const SERVER_PRODUCTS = [
  { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', salePrice: 2.5, costPrice: 1.8, refPrice: 3, unit: '罐', stock: 118, syncStatus: 'synced', createdAt: '2026-10-10T08:00:00Z' },
  { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', category: '饮料', salePrice: 1.8, costPrice: 1.1, unit: '瓶', stock: 200, syncStatus: 'pending', createdAt: '2026-10-10T08:00:00Z' }
];
const SERVER_ORDERS = [
  { id: 'M1791619813104136149', customerName: '张三', phone: '13800000000', address: '1 号楼 101', deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }], createdAt: '2026-10-10T08:05:00Z' }
];

function serverRoutes(extra) {
  return [
    { method: 'GET', path: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } },
    { method: 'GET', path: '/api/products', body: { items: SERVER_PRODUCTS, total: 2 } },
    { method: 'GET', path: '/api/orders', body: { items: SERVER_ORDERS, total: 1 } }
  ].concat(extra || []);
}

function fresh() { Mall._resetForTest(); SdyApi._resetForTest(); Mall.loadCatalog(); }

(async function main() {

  /* ============ ① 本地降级 ============ */
  section('① 探测失败 → 退回本地演示');
  fresh();
  {
    const f = mkFetch([{ method: 'GET', path: '/healthz', throw: 'connection refused' }]);
    const st = await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    ok(st.mode === 'local' && st.online === false, 'mode=local');
    ok(st.label.indexOf('本地演示') >= 0, '状态文案：' + st.label);
    ok(st.error.indexOf('无法连接后端') === 0, '错误被记录：' + st.error.slice(0, 24) + '…');
    Mall.addToCart('6901234567892', 2);
    const o = await SdyApi.createOrder({ deliveryType: 'pickup', customer: { name: '李四', phone: '139' } });
    ok(o.id.indexOf('M') === 0 && o.total === 5, '本地下单成功 total=5');
    ok(f.calls.length === 1, '本地模式只发生了 1 次探测请求，未调用后端下单');
    ok(Mall.getOrders().length === 1, '订单写入本地存储');
    await SdyApi.setStock('6901234567892', 66);
    ok(Mall.getProduct('6901234567892').stock === 66, '本地改库存生效');
    ok(Mall.getProduct('6901234567892').syncStatus === '待同步', '本地改库存标记待同步');
  }

  /* ============ ② 探测成功 → 镜像 ============ */
  section('② 探测成功 → 用后端数据覆盖本地镜像');
  fresh();
  {
    const f = mkFetch(serverRoutes());
    const st = await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    ok(st.online === true && st.mode === 'server', 'mode=server');
    ok(st.label.indexOf('已连接') >= 0, '状态文案：' + st.label);
    ok(SdyApi.health().cloudConfigured === true, 'healthz 暴露 cloudConfigured');
    const cat = Mall.loadCatalog();
    ok(cat.length === 2, '商品镜像 2 条（不再是 6 条本地种子）');
    const coke = Mall.getProduct('6901234567892');
    ok(coke.stock === 118 && coke.salePrice === 2.5 && coke.refPrice === 3, '字段映射：stock/salePrice/refPrice');
    ok(coke.syncStatus === '已同步', 'syncStatus 英文 → 中文');
    ok(coke.createdAt > 0, 'ISO 时间 → 时间戳');
    ok(Mall.getProduct('6902083881234').syncStatus === '待同步', 'pending → 待同步');
    const orders = Mall.getOrders();
    ok(orders.length === 1, '订单镜像 1 条');
    ok(orders[0].customer.name === '张三' && orders[0].customer.phone === '13800000000', '顾客字段映射 customer.name/phone');
    ok(orders[0].items[0].spec === '330ml 罐装' && orders[0].items[0].unit === '罐', '订单行从商品档案补齐 spec/unit');
    ok(Mall.orderView(orders[0]).statusLabel === '待备货', '状态标签可直接渲染');
  }

  /* ============ ③ 后端优先写操作 ============ */
  section('③ 写操作打到后端');
  fresh();
  {
    // 后端状态：下单后 GET /api/orders 能看到新订单（模拟真实服务端落库）
    let orders = SERVER_ORDERS.slice();
    const f = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } },
      { method: 'GET', path: '/api/products', body: { items: SERVER_PRODUCTS, total: 2 } },
      { method: 'GET', path: '/api/orders', body: () => ({ items: orders, total: orders.length }) },
      { method: 'POST', path: '/api/orders', status: 201, body: (c) => {
          const o = { id: 'M999', customerName: c.body.customerName, phone: c.body.phone, address: c.body.address || '', deliveryType: c.body.deliveryType, subtotal: 4.3, deliveryFee: 3, total: 7.3, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 1 }, { code: '6902083881234', name: '农夫山泉', price: 1.8, qty: 1 }], createdAt: '2026-10-10T09:00:00Z' };
          orders = [o].concat(orders);
          return o;
        } },
      { method: 'POST', re: /^\/api\/orders\/[^/]+\/advance$/, body: (c) => {
          const id = c.path.split('/')[3];
          const to = c.body.to;
          orders = orders.map(o => o.id === id ? Object.assign({}, o, { status: to }) : o);
          return orders.find(o => o.id === id) || {};
        } },
      { method: 'POST', path: '/api/products/stock', body: { code: '6901234567892', stock: 90 } },
      { method: 'POST', path: '/api/products', body: { code: '6901234567892', name: '可口可乐', salePrice: 2.5, refPrice: 2.9, unit: '罐', stock: 90 } },
      { method: 'GET', re: /^\/api\/barcode\/resolve/, body: { code: '6901234567892', found: true, source: 'product', name: '可口可乐' } },
      { method: 'GET', path: '/api/pricing/check', body: { total: 2, over: 0, violations: [] } }
    ]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    Mall.addToCart('6901234567892', 1);
    Mall.addToCart('6902083881234', 1);

    const o = await SdyApi.createOrder({ deliveryType: 'delivery', customer: { name: '王五', phone: '137' } });
    const post = f.calls.find(c => c.method === 'POST' && c.path === '/api/orders');
    ok(!!post, '下单请求已发出');
    ok(post.body.customerName === '王五' && post.body.phone === '137' && post.body.deliveryType === 'delivery', '请求体字段名与后端一致（customerName/phone/deliveryType）');
    ok(post.body.items.length === 2 && post.body.items[0].code === '6901234567892' && post.body.items[0].qty === 1, 'items 只传 code/qty（价格由服务端定）');
    ok(o.id === 'M999' && o.total === 7.3, '返回后端订单（含运费 3 元）');
    ok(Mall.cartSummary().count === 0, '下单后购物车清空');
    ok(Mall.getOrders().some(x => x.id === 'M999'), '镜像里能查到新订单');

    await SdyApi.advanceOrder('M999', 'delivering');
    const adv = f.calls.find(c => c.method === 'POST' && /advance$/.test(c.path));
    ok(adv && adv.body.to === 'delivering', '状态流转 POST /advance {to}');

    const cancelCalls0 = f.calls.filter(c => c.method === 'POST' && /advance$/.test(c.path)).length;
    await SdyApi.cancelOrder('M999');
    const cancelCalls = f.calls.filter(c => c.method === 'POST' && /advance$/.test(c.path));
    ok(cancelCalls.length === cancelCalls0 + 1 && cancelCalls[cancelCalls.length - 1].body.to === 'cancelled', '取消订单 = 流转到 cancelled（服务端负责回补库存）');

    await SdyApi.setStock('6901234567892', 90);
    const stk = f.calls.find(c => c.path === '/api/products/stock');
    ok(stk && stk.body.stock === 90, '改库存 POST /api/products/stock');

    await SdyApi.updateProduct('6901234567892', { refPrice: 2.9 });
    const up = f.calls.filter(c => c.method === 'POST' && c.path === '/api/products').pop();
    ok(up && up.body.refPrice === 2.9 && up.body.name === '可口可乐' && up.body.unit === '罐', '改参考价带上完整商品字段（避免覆盖丢失）');

    const bc = await SdyApi.resolveBarcode('6901234567892');
    ok(bc.source === 'product', '条码解析走后端（只读）');
    const pchk = await SdyApi.pricingCheck();
    ok(pchk.over === 0 && pchk.total === 2, '比价巡检由服务端规则计算');
  }

  /* ============ ④ 后端报错不静默降级 ============ */
  section('④ 后端报错 → 抛出服务端原文，不偷偷写本地');
  fresh();
  {
    const f = mkFetch(serverRoutes([
      { method: 'POST', path: '/api/orders', status: 409, body: { error: '库存不足：「可口可乐」仅剩 1 罐' } }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    Mall.addToCart('6901234567892', 2);
    let msg = '';
    try { await SdyApi.createOrder({ deliveryType: 'pickup', customer: { name: '赵六', phone: '136' } }); }
    catch (e) { msg = e.message; }
    ok(msg.indexOf('库存不足') >= 0, '错误原文透出：' + msg);
    ok(Mall.cartSummary().count === 2, '下单失败，购物车保留');
    ok(!Mall.getOrders().some(o => o.id && o.id.indexOf('M1') === 0 && o.total === 5 && o.customer.name === '赵六'), '没有生成幽灵订单');
  }

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

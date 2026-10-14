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
  { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', salePrice: 2.5, wholesalePrice: 2.2, price: 2.5, costPrice: 1.8, refPrice: 3, unit: '罐', stock: 118, syncStatus: 'synced', createdAt: '2026-10-10T08:00:00Z' },
  { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', category: '饮料', salePrice: 1.8, wholesalePrice: 0, price: 1.8, costPrice: 1.1, unit: '瓶', stock: 200, syncStatus: 'pending', createdAt: '2026-10-10T08:00:00Z' }
];
const SERVER_ORDERS = [
  { id: 'M1791619813104136149', customerName: '张三', phone: '13800000000', address: '1 号楼 101', deliveryType: 'pickup', subtotal: 5, deliveryFee: 0, total: 5, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 2 }], createdAt: '2026-10-10T08:05:00Z' }
];

function serverRoutes(extra) {
  // 自定义路由放在最前：mkFetch 取第一个匹配，通用兜底只负责「没被覆盖的部分」。
  return (extra || []).concat([
    { method: 'GET', path: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } },
    // 运营参数（第 27 轮起 sync 会拉一次）：服务端是真源，页面的本地默认值只兜底
    { method: 'GET', re: /^\/api\/settings(\?|$)/, body: { name: '家庭超市', phone: '', address: '', footer: '', lowStock: 5, minOrder: 0, deliveryFee: 3, minFree: 30 } },
    // 商品：带 ?phone= 时服务端会按顾客等级算好 price（D24），这里统一用正则匹配
    { method: 'GET', re: /^\/api\/products(\?|$)/, body: { items: SERVER_PRODUCTS, total: 2, tier: 'retail' } },
    // 订单：第 27 轮起顾客必须带 ?phone=，服务端只回他自己的单
    { method: 'GET', re: /^\/api\/orders(\?|$)/, body: { items: SERVER_ORDERS, total: 1 } }
  ]);
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
    // 第 27 轮身份收敛：顾客页没有手机号就不会去问订单接口，这一节要订单镜像，先记住手机号。
    Mall.setMyPhone('13800000000');
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
      { method: 'GET', re: /^\/api\/products(\?|$)/, body: { items: SERVER_PRODUCTS, total: 2, tier: 'retail' } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, body: () => ({ items: orders, total: orders.length }) },
      { method: 'POST', path: '/api/orders', status: 201, body: (c) => {
          const o = { id: 'M999', customerName: c.body.customerName, phone: c.body.phone, address: c.body.address || '', deliveryType: c.body.deliveryType, subtotal: 4.3, deliveryFee: 3, total: 7.3, status: 'pending', items: [{ code: '6901234567892', name: '可口可乐', price: 2.5, qty: 1 }, { code: '6902083881234', name: '农夫山泉', price: 1.8, qty: 1 }], createdAt: '2026-10-10T09:00:00Z' };
          orders = [o].concat(orders);
          return o;
        } },
      { method: 'POST', re: /^\/api\/orders\/[^/]+\/advance(\?|$)/, body: (c) => {
          const id = c.path.split('/')[3];
          const to = c.body.to;
          orders = orders.map(o => o.id === id ? Object.assign({}, o, { status: to }) : o);
          return orders.find(o => o.id === id) || {};
        } },
      // 第 27 轮：取消走独立端点（服务端按归属校验 + 事务内回补库存 + 写回补流水）
      { method: 'POST', re: /^\/api\/orders\/[^/]+\/cancel(\?|$)/, body: (c) => {
          const id = c.path.split('/')[3];
          orders = orders.map(o => o.id === id ? Object.assign({}, o, { status: 'cancelled' }) : o);
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
    ok(typeof post.body.clientToken === 'string' && post.body.clientToken.length > 8, '下单带幂等键 clientToken（超时重试不会重复落单）');
    ok(o.id === 'M999' && o.total === 7.3, '返回后端订单（含运费 3 元）');
    ok(Mall.cartSummary().count === 0, '下单后购物车清空');
    ok(Mall.getOrders().some(x => x.id === 'M999'), '镜像里能查到新订单');

    await SdyApi.advanceOrder('M999', 'delivering');
    const adv = f.calls.find(c => c.method === 'POST' && /advance/.test(c.path));
    ok(adv && adv.body.to === 'delivering', '状态流转 POST /advance {to}');
    ok(adv && /\?phone=137/.test(adv.path), 'advance 带归属手机号（服务端才能判断这单是不是我的）');

    const cancelCalls = f.calls.filter(c => c.method === 'POST' && /cancel/.test(c.path));
    await SdyApi.cancelOrder('M999');
    const cancelCalls2 = f.calls.filter(c => c.method === 'POST' && /cancel/.test(c.path));
    ok(cancelCalls2.length === cancelCalls.length + 1, '取消订单打的是独立端点 /cancel（不再借道 advance）');
    ok(/^\/api\/orders\/M999\/cancel\?phone=137$/.test(cancelCalls2[cancelCalls2.length - 1].path), '取消请求 = POST /api/orders/{id}/cancel?phone=（服务端负责回补库存与流水）');
    ok(cancelCalls2[cancelCalls2.length - 1].body.to === 'cancelled', '取消请求体仍是 {to:"cancelled"}（兼容服务端状态机）');

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

  /* ============ ⑤ 删除商品：离线改镜像 / 在线打后端 ============ */
  section('⑤ 删除商品档案');
  fresh();
  {
    const r = await SdyApi.deleteProduct('6902083881234');
    ok(r.ok === true && !Mall.getProduct('6902083881234'), '离线：删本地镜像并返回 {ok:true}');
    let msg = '';
    try { await SdyApi.deleteProduct('9999999999999'); } catch (e) { msg = e.message; }
    ok(msg.indexOf('商品不存在') >= 0, '离线：镜像里没有该商品 → 抛错（' + msg + '）');
  }
  fresh();
  {
    const f = mkFetch(serverRoutes([
      { method: 'DELETE', re: /^\/api\/products\//, body: { ok: true, code: '6901234567892' } }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    const r = await SdyApi.deleteProduct('6901234567892');
    const call = f.calls.find(c => c.method === 'DELETE');
    ok(call && call.path === '/api/products/6901234567892', '在线：DELETE /api/products/{code}');
    ok(r && r.ok === true && r.code === '6901234567892', '在线：透出后端返回的 {ok:true, code}');
  }
  {
    const f = mkFetch(serverRoutes([
      { method: 'DELETE', re: /^\/api\/products\//, status: 409, body: { error: '库存为 12 罐，请先盘点为 0 再删除' } }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    let msg = '';
    try { await SdyApi.deleteProduct('6901234567892'); } catch (e) { msg = e.message; }
    ok(msg.indexOf('盘点为 0') >= 0, '在线：后端 409 原文透出（' + msg + '）');
    ok(!!Mall.getProduct('6901234567892'), '在线：删除失败后本地镜像仍在（不做幽灵删除）');
  }

  /* ---------- 收货地址簿（D18） ---------- */
  section('⑥ 收货地址簿：离线走本地 / 在线走后端并回镜像');
  {
    fresh();
    const a = await SdyApi.saveAddress({ phone: '13800000001', contact: '王阿姨', address: '幸福路1号 3单元 501' });
    ok(a.id > 0 && a.isDefault === true, '离线：保存第一条 → 本地自动默认');
    const l1 = await SdyApi.listAddresses('13800000001');
    ok(l1.length === 1 && l1[0].contact === '王阿姨', '离线：listAddresses 读本地地址簿');
    const d = await SdyApi.defaultAddress('13800000001');
    ok(d && d.id === a.id, '离线：defaultAddress 返回默认地址');
    await SdyApi.deleteAddress('13800000001', a.id);
    ok((await SdyApi.listAddresses('13800000001')).length === 0, '离线：deleteAddress 走本地');
    let msg = '';
    try { await SdyApi.saveAddress({ phone: '13800000001', contact: '', address: '乙' }); } catch (e) { msg = e.message; }
    ok(msg === '收货人不能为空', '离线：本地校验文案与后端一致（' + msg + '）');
  }
  {
    // 第 27 轮：地址簿有钥匙（key）——只凭手机号就能读写别人的收货地址是越权，
    // 服务端首次发一把钥匙，客户端存本机（sdy_addr_key）并在后续读写时带上。
    const ADDR_KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
    const f = mkFetch(serverRoutes([
      { method: 'GET', re: /^\/api\/addresses(\?|$)/, body: { total: 1, key: ADDR_KEY, items: [
        { id: 11, phone: '13800000001', contact: '王阿姨', address: '幸福路1号 3单元 501', isDefault: true, createdAt: '2026-10-11T02:00:00Z', updatedAt: '2026-10-11T02:00:00Z' }
      ] } },
      { method: 'POST', re: /^\/api\/addresses(\?|$)/, body: function (c) {
        return { id: 12, key: ADDR_KEY, phone: c.body.phone, contact: c.body.contact, address: c.body.address, isDefault: false, createdAt: '2026-10-11T03:00:00Z', updatedAt: '2026-10-11T03:00:00Z' };
      } },
      { method: 'DELETE', re: /^\/api\/addresses\/11(\?|$)/, body: { ok: true, id: 11 } }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    const items = await SdyApi.listAddresses('13800000001');
    ok(items.length === 1 && items[0].isDefault === true, '在线：GET /api/addresses 取后端地址');
    ok(Mall.listAddresses('13800000001')[0].contact === '王阿姨', '在线：整册镜像回本地（离线仍能一键带出）');
    ok(Mall.listAddresses('13800000001')[0].phone === '13800000001', '在线：镜像条目回填 phone');
    const gets0 = f.calls.filter(c => c.method === 'GET' && /^\/api\/addresses/.test(c.path));
    ok(gets0.length === 1 && !/key=/.test(gets0[0].path), '首次按手机号取册子不带钥匙（服务端此时才发钥匙）');
    const saved = await SdyApi.saveAddress({ phone: '13800000001', contact: '王叔叔', address: '幸福路2号 1单元 101' });
    ok(saved && saved.id === 12, '在线：POST /api/addresses 透出后端返回');
    const post = f.calls.filter(c => c.method === 'POST' && /^\/api\/addresses/.test(c.path))[0];
    ok(!!post && post.body.id === 0 && post.body.isDefault === false, '在线：POST body 只送 id/phone/contact/address/isDefault');
    ok(!!post && post.body.phone === '13800000001' && post.body.address === '幸福路2号 1单元 101', '在线：POST body 带手机号与地址');
    ok(!!post && post.path.indexOf('?key=' + ADDR_KEY) === '/api/addresses'.length, '在线：拿到钥匙后写入带上 ?key=（没有钥匙就动不了别人的地址簿）');
    const gets = f.calls.filter(c => c.method === 'GET' && /^\/api\/addresses/.test(c.path));
    ok(gets.length === 2, '在线：写成功后自动重拉一次镜像');
    ok(/[?&]key=/.test(gets[1].path), '在线：重拉镜像也带上钥匙（&key=）');
    await SdyApi.deleteAddress('13800000001', 11);
    const del = f.calls.filter(c => c.method === 'DELETE')[0];
    ok(!!del && del.path === '/api/addresses/11?phone=13800000001&key=' + ADDR_KEY, '在线：DELETE /api/addresses/{id}?phone=&key=');
  }
  {
    const f = mkFetch(serverRoutes([
      { method: 'POST', re: /^\/api\/addresses(\?|$)/, status: 400, body: { error: '送货地址不能为空' } }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    let msg = '';
    try { await SdyApi.saveAddress({ phone: '13800000001', contact: '甲', address: '乙' }); } catch (e) { msg = e.message; }
    ok(msg.indexOf('送货地址不能为空') >= 0, '在线：后端 400 原文透出（' + msg + '）');
    ok(f.calls.filter(c => c.method === 'GET' && /^\/api\/addresses/.test(c.path)).length === 0, '在线：写入失败不再重拉镜像');
  }
  /* ============ ⑦ 批量上下架（D23） ============ */
  section('⑦ 批量上下架 setOnSale（任务池⑥ / D23）');
  {
    // 离线：直接改镜像，语义与后端一致（重复设置同一状态 = 零变化）
    fresh();
    const f0 = mkFetch([]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f0, mall: Mall, timeoutMs: 50 });
    ok(SdyApi.mode() === 'local', '探测失败 → 离线模式');
    const r1 = await SdyApi.setOnSale(['6901234567892'], false);
    ok(r1.count === 1 && r1.changed[0] === '6901234567892', '离线：下架 1 件并返回 changed');
    ok(Mall.getProduct('6901234567892').onSale === false, '离线：镜像 onSale 置 false');
    const r2 = await SdyApi.setOnSale([' 6901234567892 '], false);
    ok(r2.count === 0, '离线：重复下架零变化（顺带验证条码去空格）');
    let msg = '';
    try { await SdyApi.setOnSale(['no-such-code'], false); } catch (e) { msg = e.message; }
    ok(msg.indexOf('资源不存在') >= 0, '离线：未知条码报错（' + msg + '）');
    msg = '';
    try { await SdyApi.setOnSale([], false); } catch (e) { msg = e.message; }
    ok(msg.indexOf('请至少选择一个商品') >= 0, '离线：空清单报错（' + msg + '）');
  }
  {
    // 在线：POST /api/products/onsale，成功后重拉商品镜像
    fresh();
    let items = SERVER_PRODUCTS.map(p => Object.assign({ onSale: true }, p));
    const f = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } },
      { method: 'GET', path: '/api/products', body: () => ({ items: items, total: items.length }) },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, body: { items: [], total: 0 } },
      { method: 'POST', path: '/api/products/onsale', body: (c) => {
          const hit = p => c.body.codes.indexOf(p.code) >= 0;
          const changed = items.filter(p => hit(p) && p.onSale !== c.body.onSale).map(p => p.code);
          items = items.map(p => hit(p) ? Object.assign({}, p, { onSale: c.body.onSale }) : p);
          return { ok: true, onSale: c.body.onSale, changed: changed, count: changed.length };
        } }
    ]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    ok(Mall.getProduct('6901234567892').onSale === true, '在线：同步把 onSale 带进镜像');
    const r = await SdyApi.setOnSale(['6901234567892'], false);
    const post = f.calls.filter(c => c.method === 'POST' && c.path === '/api/products/onsale')[0];
    ok(!!post && post.body.codes.length === 1 && post.body.onSale === false, '在线：POST /api/products/onsale 请求体正确');
    ok(r.count === 1 && r.onSale === false, '在线：后端返回 count=1 / onSale=false');
    ok(Mall.getProduct('6901234567892').onSale === false, '在线：操作后镜像已刷新为下架');
    ok(f.calls.filter(c => c.path === '/api/products').length >= 2, '在线：写成功后自动重拉一次商品镜像');
    const back = await SdyApi.setOnSale(['6901234567892'], true);
    ok(back.count === 1 && Mall.getProduct('6901234567892').onSale === true, '在线：重新上架生效');
  }
  /* ============ ⑧ 批发价与顾客等级（D24） ============ */
  section('⑧ 我的价格 / 顾客等级（任务池⑦ / D24）');
  {
    // 纯函数口径（与后端 Go pricing.EffectivePrice 一致）
    ok(Mall.priceOf({ salePrice: 60, wholesalePrice: 52 }) === 60, '零售等级 → 售价');
    Mall.setMyPhone('13800001111');
    ok(Mall.getMyPhone() === '13800001111' && Mall.getMyTier() === 'retail', '记住手机号，默认零售');
    ok(Mall.priceOf({ salePrice: 60, wholesalePrice: 52 }) === 60, '有手机号但等级还是零售 → 售价');
    Mall._save('mall_customers', { '13800001111': { tier: 'wholesale' } });
    ok(Mall.getMyTier() === 'wholesale', '离线演示：本地顾客档案里的等级生效');
    ok(Mall.priceOf({ salePrice: 60, wholesalePrice: 52 }) === 52, '批发等级 + 有批发价 → 批发价');
    ok(Mall.priceOf({ salePrice: 60, wholesalePrice: 0 }) === 60, '批发等级但没填批发价 → 售价（回落）');
    ok(Mall.priceOf({ salePrice: 60, wholesalePrice: 52, price: 45 }) === 45, '服务端下发的 price 优先（价格真源在服务端）');
    ok(Mall.isWholesalePrice({ salePrice: 60, wholesalePrice: 52 }) === true, '批发价低于零售价 → 标批发价');
    ok(Mall.isWholesalePrice({ salePrice: 60, wholesalePrice: 0 }) === false, '没便宜 → 不标批发价');
    // 购物车小计与下单都按有效价（离线演示：本地商品档案没有服务端 price 字段）
    Mall._save(Mall.KEYS.products, [
      { code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', category: '饮料', salePrice: 2.5, wholesalePrice: 2.2, unit: '罐', stock: 10, onSale: true },
      { code: '6902083881234', name: '农夫山泉', spec: '550ml', category: '饮料', salePrice: 1.8, wholesalePrice: 0, unit: '瓶', stock: 10, onSale: true }
    ]);
    Mall.clearCart();
    Mall.addToCart('6901234567892', 2);
    Mall.addToCart('6902083881234', 1);
    const s = Mall.cartSummary();
    ok(s.subtotal === 6.2, '购物车小计按有效价（2.2×2 + 1.8，离线按本地批发价）');
    const line = s.lines.find(l => l.code === '6901234567892');
    ok(line.price === 2.2 && line.listPrice === 2.5 && line.wholesale === true, '购物车行带 price/listPrice/wholesale');
    Mall.setMyPhone('');
    ok(Mall.getMyPhone() === '' && Mall.getMyTier() === 'retail', '清空手机号 → 回零售');
  }
  {
    // 离线：管理端设等级只写本地；在线才打后端
    fresh();
    const f0 = mkFetch([]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f0, mall: Mall, timeoutMs: 50 });
    const r = await SdyApi.setMyPhone('13800002222');
    ok(SdyApi.mode() === 'local' && r.offline === true && r.tier === 'retail', '离线设手机号：返回 offline/retail');
    ok(await SdyApi.listCustomers() === null, '离线：listCustomers 返回 null（管理端读本地档案）');
    ok(await SdyApi.setCustomerTier('13800002222', '甲', 'vip') === null, '离线：setCustomerTier 返回 null');
  }
  {
    // 在线：带手机号重新取价，服务端按等级下发 price；顾客档案走后端
    fresh();
    let items = SERVER_PRODUCTS.map(p => Object.assign({}, p));
    // 注意：自定义 /api/products 路由必须排在通用路由之前（mkFetch 取第一个匹配），
    // 否则 serverRoutes 里的通用商品路由会先命中，tier 永远是 retail。
    const f = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } },
      { method: 'GET', re: /^\/api\/products(\?|$)/, body: (c) => {
          const whole = /phone=13800001111/.test(c.path);
          const list = items.map(p => Object.assign({}, p, {
            price: whole ? (p.wholesalePrice > 0 ? p.wholesalePrice : p.salePrice) : p.salePrice,
            tier: whole ? 'wholesale' : 'retail'
          }));
          return { items: list, total: list.length, tier: whole ? 'wholesale' : 'retail' };
        } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, body: { items: [], total: 0 } },
      { method: 'GET', path: '/api/customers', body: { total: 1, items: [
        { phone: '13800001111', name: '王老板', tier: 'wholesale', tags: '', note: '' }
      ] } },
      { method: 'POST', path: '/api/customers/tier', body: (c) => ({ phone: c.body.phone, name: c.body.name, tier: c.body.tier, tags: '', note: '' }) },
      { method: 'POST', path: '/api/orders', status: 201, body: (c) => ({
          id: 'M888', customerName: c.body.customerName, phone: c.body.phone, address: c.body.address || '',
          deliveryType: c.body.deliveryType, subtotal: 2.2, deliveryFee: 0, total: 2.2, status: 'pending',
          items: [{ code: '6901234567892', name: '可口可乐', price: 2.2, qty: 1 }], createdAt: '2026-10-12T09:00:00Z'
        }) }
    ]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, timeoutMs: 50 });
    ok(Mall.getProduct('6901234567892').price === 2.5, '不带手机号：服务端下发零售价 2.5');
    const r = await SdyApi.setMyPhone('13800001111');
    ok(r.tier === 'wholesale' && r.phone === '13800001111', '在线设手机号 → 服务端回 tier=wholesale');
    const last = f.calls.filter(c => /^\/api\/products/.test(c.path)).pop();
    ok(last.path === '/api/products?phone=13800001111', '在线：带手机号重新拉商品（?phone=）');
    ok(Mall.getProduct('6901234567892').price === 2.2, '在线：镜像里的价格按批发等级刷新为 2.2');
    ok(Mall.getProduct('6902083881234').price === 1.8, '在线：没填批发价的商品仍是零售价 1.8');
    ok(Mall.getMyTier() === 'wholesale' && Mall.getMyPhone() === '13800001111', '等级与手机号记住到本地');
    const cs = await SdyApi.listCustomers();
    ok(cs.length === 1 && cs[0].phone === '13800001111' && cs[0].tier === 'wholesale', '在线：GET /api/customers 拿到顾客档案与等级');
    const saved = await SdyApi.setCustomerTier('13800001111', '王老板', 'vip');
    const post = f.calls.filter(c => c.method === 'POST' && c.path === '/api/customers/tier')[0];
    ok(!!post && post.body.phone === '13800001111' && post.body.tier === 'vip' && post.body.name === '王老板', '在线：POST /api/customers/tier 请求体正确');
    ok(saved && saved.tier === 'vip', '在线：透出后端保存结果');
    // 下单后自动记住手机号（下次进来就按我的等级显示价格）
    Mall.setMyPhone('');
    Mall.addToCart('6901234567892', 1);
    const o = await SdyApi.createOrder({ deliveryType: 'pickup', customer: { name: '王老板', phone: '13800001111' } });
    ok(!!o, '在线下单成功');
    ok(Mall.getMyPhone() === '13800001111', '下单后记住手机号（下次自动按等级取价）');
  }

  section('⑨ 库存审计 / 配送员 / 门店抬头 / 顾客备注（任务池⑧ / D25）');
  {
    // 离线：这六类写操作一律返回 null，管理端自己走本地档案
    fresh();
    const f0 = mkFetch([]);
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f0, mall: Mall, timeoutMs: 50 });
    ok(await SdyApi.changeStock('6901234567892', 'stock_in', 30, '整箱到货', '老板') === null, '离线：changeStock 返回 null');
    ok(await SdyApi.listStockLog(30) === null, '离线：listStockLog 返回 null');
    ok(await SdyApi.listCouriers() === null, '离线：listCouriers 返回 null');
    ok(await SdyApi.saveCourier('阿明', '', false) === null, '离线：saveCourier 返回 null');
    ok(await SdyApi.getSettings() === null, '离线：getSettings 返回 null');
    ok(await SdyApi.saveSettings({ name: '家庭超市' }) === null, '离线：saveSettings 返回 null');
    ok(await SdyApi.setCustomerNote('13800001111', '王老板', '熟客', '常买整箱水') === null, '离线：setCustomerNote 返回 null');
  }
  {
    // 在线：库存变更走服务端唯一入口（一个事务里改库存 + 写流水），流水自动镜像回本地
    fresh();
    const mirrored = [];
    const AdminStub = { recordStockEntry: (e) => mirrored.push(e) };
    const f = mkFetch(serverRoutes([
      { method: 'POST', path: '/api/stock/change', body: (c) => ({ ok: true, stock: 140, entry: {
          id: 41, at: 1760000000000, ts: '2026-10-12T09:00:00+08:00', kind: c.body.kind, code: c.body.code,
          name: '可口可乐', unit: '罐', delta: c.body.qty, before: 110, after: 140,
          reason: c.body.reason, by: c.body.by } }) },
      { method: 'GET', path: '/api/stocklog?limit=30', body: { total: 1, items: [
          { id: 41, at: 1760000000000, ts: '2026-10-12T09:00:00+08:00', kind: 'stock_in', code: '6901234567892',
            name: '可口可乐', unit: '罐', delta: 30, before: 110, after: 140, reason: '整箱到货', by: '老板' }] } },
      { method: 'GET', path: '/api/couriers', body: { total: 4, items: [
          { name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' }] } },
      { method: 'POST', path: '/api/couriers', body: (c) => (c.body.remove
          ? { ok: true, total: 4, items: [{ name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' }] }
          : { ok: true, total: 5, items: [{ name: '老张' }, { name: '小李' }, { name: '阿强' }, { name: '小美' },
                                          { name: c.body.name, phone: c.body.phone }] }) },
      { method: 'GET', path: '/api/settings', body: { name: '家庭超市', phone: '', address: '', footer: '谢谢惠顾，欢迎再来！' } },
      { method: 'POST', path: '/api/settings', body: (c) => ({ name: c.body.name, phone: c.body.phone,
          address: c.body.address, footer: c.body.footer || '谢谢惠顾，欢迎再来！' }) },
      { method: 'POST', path: '/api/customers/note', body: (c) => ({ phone: c.body.phone, name: c.body.name,
          tier: 'retail', tags: c.body.tags, note: c.body.note }) }
    ]));
    await SdyApi.boot({ base: 'http://127.0.0.1:8093', fetchImpl: f, mall: Mall, admin: AdminStub, timeoutMs: 50 });
    ok(SdyApi.mode() === 'server', '在线探测成功（这些接口要有后端才生效）');
    const r = await SdyApi.changeStock('6901234567892', 'stock_in', 30, '整箱到货', '老板');
    const post = f.calls.filter(c => c.method === 'POST' && c.path === '/api/stock/change')[0];
    ok(!!post && post.body.kind === 'stock_in' && post.body.qty === 30 &&
       post.body.reason === '整箱到货' && post.body.by === '老板', 'POST /api/stock/change 带 kind/qty/reason/by');
    ok(r && r.stock === 140 && r.entry.after === 140, '透出服务端结果（库存 140）');
    ok(mirrored.length === 1 && mirrored[0].id === 41 && mirrored[0].after === 140, '服务端流水自动镜像回本地（库存对齐 after）');
    // 浏览器里 admin.html 调的是无参 SdyApi.boot()，cfg.admin 是空的 → 必须能退回 window.Admin
    const viaWindow = [];
    const savedWin = global.window;
    global.window = { Admin: { recordStockEntry: function (e) { viaWindow.push(e); } } };
    SdyApi.configure({ admin: null });
    await SdyApi.changeStock('6901234567892', 'stock_in', 30, '整箱到货', '老板');
    ok(viaWindow.length === 1 && viaWindow[0].after === 140, '没注入 cfg.admin 时退回 window.Admin 做本地镜像');
    SdyApi.configure({ admin: AdminStub });
    global.window = savedWin;
    const log = await SdyApi.listStockLog(30);
    ok(log.length === 1 && log[0].kind === 'stock_in' && log[0].after === 140, 'GET /api/stocklog 拿到后端审计流水');
    ok((await SdyApi.listStockLog()).length === 1, 'limit 省略 → 默认取 30 条');
    const cs = await SdyApi.listCouriers();
    ok(cs.length === 4 && cs[0].name === '老张', 'GET /api/couriers 拿到后端名单');
    const after = await SdyApi.saveCourier('阿明', '13900009999');
    const cp = f.calls.filter(c => c.method === 'POST' && c.path === '/api/couriers')[0];
    ok(!!cp && cp.body.name === '阿明' && cp.body.remove === false, 'POST /api/couriers 新增（remove=false）');
    ok(after.length === 5, 'saveCourier 返回最新名单（5 人）');
    await SdyApi.saveCourier('阿明', '', true);
    const cp2 = f.calls.filter(c => c.method === 'POST' && c.path === '/api/couriers')[1];
    ok(!!cp2 && cp2.body.remove === true, '删除配送员传 remove=true');
    const st = await SdyApi.getSettings();
    ok(st.name === '家庭超市' && st.footer.indexOf('谢谢惠顾') >= 0, 'GET /api/settings 拿到门店抬头');
    const savedSt = await SdyApi.saveSettings({ name: '水东洋便利店', phone: '', address: '', footer: '' });
    const sp = f.calls.filter(c => c.method === 'POST' && c.path === '/api/settings')[0];
    ok(!!sp && sp.body.name === '水东洋便利店' && Object.keys(sp.body).length === 4, 'POST /api/settings 只传 name/phone/address/footer');
    ok(savedSt.footer.indexOf('谢谢惠顾') >= 0, '页脚留空 → 后端回默认那句');
    const cn = await SdyApi.setCustomerNote('13800001111', '王老板', '熟客', '常买整箱水');
    const np = f.calls.filter(c => c.method === 'POST' && c.path === '/api/customers/note')[0];
    ok(!!np && np.body.tags === '熟客' && np.body.note === '常买整箱水', 'POST /api/customers/note 请求体正确');
    ok(cn && cn.tags === '熟客' && cn.tier === 'retail', '透出后端保存的顾客档案（等级不受影响）');
  }

  section('■ 第 27 轮 P0-4：连上后端后空商品库绝不重播种');
  {
    // 在线 + 空库：必须如实返回 0 件。以前 setServerConnected 只有定义没有调用点，
    // Mall 永远以为「没连上后端」，于是空库会被 6 条演示商品顶上（顾客照着假货下单）。
    Mall._resetForTest();
    global.fetch = mkFetch([{ method: 'GET', path: '/healthz', body: { ok: true } }]);
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    await SdyApi.probe();
    ok(SdyApi.on() === true, '探测成功 → 在线模式');
    ok(Mall.isServerConnected() === true, 'probe 会把「已连上后端」告诉 Mall（这道闸门以前从没合上）');
    ok(Mall.loadCatalog().length === 0, '连上后端且店里一件商品都没有 → 如实 0 件，不拿演示商品顶替');

    // 离线：仍然允许本地演示商品（门店断网时 Web 商城还能演示）
    Mall._resetForTest();
    global.fetch = mkFetch([{ method: 'GET', path: '/healthz', throw: 'Failed to fetch' }]);
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    await SdyApi.probe();
    ok(SdyApi.on() === false, '探测失败 → 离线降级');
    ok(Mall.isServerConnected() === false, '离线时把闸门交回 Mall');
    ok(Mall.loadCatalog().length === 6, '从没连上过后端 → 6 条本地演示商品兜底（离线可用）');
  }

  section('■ 第 27 轮：同步契约（服务端运营参数 + 订单按身份过滤）');
  {
    // ① sync 要把服务端下发的配送费/门槛/低库存阈值应用到本地规则（否则页面按旧默认值算钱）。
    //    用与本地默认不同的值，才能证明「确实是服务端说了算」。
    Mall._resetForTest();
    // 注意：自定义 /api/settings 路由必须排在 serverRoutes 之前（mkFetch 取第一个匹配），
    // 否则通用路由先命中，测的还是默认值。
    const f = mkFetch([
      { method: 'GET', re: /^\/api\/settings(\?|$)/, body: { name: '啥都有快送', phone: '', address: '', footer: '', lowStock: 7, minOrder: 8, deliveryFee: 4.5, minFree: 39 } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, body: { items: [], total: 0 } }
    ].concat(serverRoutes()));
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    global.fetch = f;
    await SdyApi.probe();
    SdyApi.setMyPhone('13800138000');
    await SdyApi.sync();
    ok(Mall.lowStock() === 7, 'sync 应用服务端 lowStock（不是前端写死的 5）');
    ok(Mall.minOrder() === 8, 'sync 应用服务端 minOrder（起送价）');
    ok(Mall.calcDeliveryFee('delivery', 10) === 4.5, 'sync 应用端 deliveryFee（10 元不满 39 → 4.5 元）');
    ok(Mall.calcDeliveryFee('delivery', 39) === 0, 'sync 应用服务端 minFree（满 39 免运费）');
    const oGet = f.calls.filter(c => c.method === 'GET' && /^\/api\/orders/.test(c.path))[0];
    ok(!!oGet && oGet.path === '/api/orders?phone=13800138000', 'sync 拉订单必须带手机号（服务端据此只回我的单）');

    // ② 没有身份时服务端 400「缺少身份」：这不是错误，是「本来就看不到订单」，
    //     sync 必须安静地把订单镜像清空并给出 needIdentity，而不是把页面炸成错误态。
    const f2 = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true } },
      { method: 'GET', re: /^\/api\/products(\?|$)/, body: { items: SERVER_PRODUCTS, total: 2, tier: 'retail' } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, status: 400, body: { error: '缺少身份：顾客请带 openid/phone，员工请带 X-Staff-Token' } }
    ]);
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    global.fetch = f2;
    await SdyApi.probe();
    let threw = '';
    let res = null;
    try { res = await SdyApi.sync(''); } catch (e) { threw = e.message || String(e); }
    ok(threw === '', '缺身份不是错误：sync 不抛（' + (threw || '没抛') + '）');
    ok(!!res && res.needIdentity === true, 'sync 返回 needIdentity=true 供页面给引导文案');
    ok(Mall.getOrders().length === 0, '缺身份时订单镜像清空（不残留上次登录的旧单）');
    ok(f2.calls.filter(c => /^\/api\/orders/.test(c.path)).length === 0,
      '顾客页没有手机号时干脆不问订单接口（灰度模式下问了会被服务端当管理员，回全店订单）');

    // ②b 管理端（all:true）照旧拉全店订单：这条保护不能误伤老板的后台。
    const f2b = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true } },
      { method: 'GET', re: /^\/api\/products(\?|$)/, body: { items: SERVER_PRODUCTS, total: 2, tier: 'retail' } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, body: { items: SERVER_ORDERS, total: 1 } }
    ]);
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    global.fetch = f2b;
    await SdyApi.probe();
    const resAll = await SdyApi.sync(null, { all: true });
    const oAll = f2b.calls.filter(c => /^\/api\/orders/.test(c.path))[0];
    ok(!!oAll && oAll.path === '/api/orders' && !!resAll && resAll.orders.length === SERVER_ORDERS.length,
      '管理端 sync(null,{all:true}) 仍然拉全店订单');

    // ③ 真异常（断网 / 500）仍然要抛出来给页面显示错误态，别吞掉。
    const f3 = mkFetch([
      { method: 'GET', path: '/healthz', body: { ok: true } },
      { method: 'GET', re: /^\/api\/products(\?|$)/, body: { items: SERVER_PRODUCTS, total: 2, tier: 'retail' } },
      { method: 'GET', re: /^\/api\/orders(\?|$)/, status: 500, body: { error: '数据库开小差了' } }
    ]);
    SdyApi._resetForTest();
    SdyApi.configure({ base: 'http://api.test', mall: Mall });
    global.fetch = f3;
    await SdyApi.probe();
    let msg3 = '';
    try { await SdyApi.sync('13800138000'); } catch (e) { msg3 = e.message || String(e); }
    ok(msg3.indexOf('数据库开小差了') >= 0, '真错误照抛（页面要能显示错误态）：' + msg3);
  }

  console.log('\n========================================');
  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

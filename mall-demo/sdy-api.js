/* =====================================================================
 * 页面 ↔ Go 后端 数据通道（M4 前端接后端）
 *
 * 设计原则：
 *   1) 后端为真源，localStorage 只做「镜像 / 离线降级」——后端在就用后端，
 *      后端不在（或直接双击打开 HTML）就退回纯本地演示，页面照常能用。
 *   2) 页面代码只换调用入口：Mall.xxx → SdyApi.xxx，规则仍在服务端，
 *      前端改价/改库存都会被后端拒绝（价格防线、库存校验）。
 *   3) 探测一次（GET /healthz），结果缓存在内存，不做轮询。
 *
 * 同源优先：页面由 Go 服务托管时 base 为空（走 /api/...）；
 *          页面用 python/http.server 打开时，可设
 *          window.SDY_API_BASE='http://127.0.0.1:8093' 或
 *          localStorage['sdy_api_base']='http://127.0.0.1:8093'
 * ===================================================================== */
'use strict';

const SdyApi = (() => {

  const LS_BASE_KEY = 'sdy_api_base';
  const DEFAULTS = { timeoutMs: 2000, base: '', fetchImpl: null, mall: null };

  let cfg = Object.assign({}, DEFAULTS);
  let mode_ = 'local';          // 'server' | 'local'
  let lastError = '';
  let health_ = null;

  // ---------------- 依赖注入（Node 测试用） ----------------
  function configure(opts) {
    cfg = Object.assign({}, cfg, opts || {});
    return cfg;
  }
  function resolveMall() {
    if (cfg.mall) return cfg.mall;
    if (typeof Mall !== 'undefined') return Mall;
    if (typeof module !== 'undefined' && module.exports) {
      try { return require('./mall.js'); } catch (e) { /* 忽略 */ }
    }
    return null;
  }
  function M() {
    const m = resolveMall();
    if (!m) throw new Error('SdyApi 找不到 Mall 模块（请先引入 mall.js）');
    return m;
  }
  function fetchImpl() {
    if (cfg.fetchImpl) return cfg.fetchImpl;
    if (typeof fetch !== 'undefined') return fetch;
    return null;
  }

  // ---------------- 连接配置 ----------------
  function base() {
    if (cfg.base) return String(cfg.base).replace(/\/+$/, '');
    if (typeof window !== 'undefined' && window.SDY_API_BASE) return String(window.SDY_API_BASE).replace(/\/+$/, '');
    if (typeof localStorage !== 'undefined') {
      try {
        const v = localStorage.getItem(LS_BASE_KEY);
        if (v) return String(v).replace(/\/+$/, '');
      } catch (e) { /* 忽略 */ }
    }
    return '';  // 同源
  }
  function url(path) { return base() + path; }

  // ---------------- HTTP ----------------
  async function req(method, path, body) {
    const f = fetchImpl();
    if (!f) throw new Error('当前环境不支持 fetch');
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : null;
    let res;
    try {
      res = await f(url(path), {
        method: method,
        headers: body == null ? undefined : { 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      throw new Error('无法连接后端（' + (base() || '同源') + '）：' + (e && e.message ? e.message : e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let text = '';
    try { text = await res.text(); } catch (e) { text = ''; }
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
    if (!res.ok) {
      const msg = (data && (data.error || data.msg)) || ('HTTP ' + res.status);
      throw new Error(msg);
    }
    return data;
  }

  // ---------------- 探测与状态 ----------------
  async function probe() {
    try {
      health_ = await req('GET', '/healthz');
      mode_ = 'server';
      lastError = '';
    } catch (e) {
      health_ = null;
      mode_ = 'local';
      lastError = e && e.message ? e.message : String(e);
    }
    return health_;
  }

  // 页面启动：探测 → 连上就拉一次全量镜像
  async function boot(opts) {
    if (opts) configure(opts);
    await probe();
    if (mode_ === 'server') {
      try { await sync(); } catch (e) { lastError = e.message; }
    }
    return status();
  }

  function mode() { return mode_; }
  function on() { return mode_ === 'server'; }
  function health() { return health_; }
  function status() {
    return {
      mode: mode_,
      online: mode_ === 'server',
      base: base() || '(同源)',
      error: lastError,
      label: mode_ === 'server' ? '🟢 后端已连接' : '🟡 本地演示（离线可用）',
      detail: mode_ === 'server'
        ? '数据来自 Go 后端 ' + (base() || '同源')
        : (lastError || '未探测到后端')
    };
  }

  // ---------------- 数据映射（服务端 → 页面模型） ----------------
  function ts(v) {
    if (typeof v === 'number') return v;
    if (!v) return 0;
    const t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  function fromServerProduct(p) {
    return {
      code: p.code,
      name: p.name,
      brand: p.brand || '',
      spec: p.spec || '',
      category: p.category || '未分类',
      img: p.img || '',
      costPrice: p.costPrice || 0,
      salePrice: p.salePrice || 0,
      refPrice: p.refPrice || 0,
      unit: p.unit || '件',
      stock: p.stock || 0,
      isWholesale: !!p.isWholesale,
      syncStatus: p.syncStatus === 'pending' ? '待同步' : '已同步',
      createdAt: ts(p.createdAt),
      updatedAt: ts(p.updatedAt)
    };
  }
  function fromServerOrder(o, catalog) {
    const items = (o.items || []).map(it => {
      const p = (catalog || []).find(x => x.code === it.code) || {};
      return {
        code: it.code,
        name: it.name || p.name || '未知商品',
        spec: p.spec || '',
        unit: p.unit || '件',
        price: it.price,
        qty: it.qty
      };
    });
    return {
      id: o.id,
      createdAt: ts(o.createdAt),
      items: items,
      subtotal: o.subtotal,
      deliveryType: o.deliveryType,
      deliveryFee: o.deliveryFee,
      total: o.total,
      customer: { name: o.customerName, phone: o.phone, address: o.address || '' },
      status: o.status
    };
  }

  // ---------------- 镜像：后端 → localStorage（页面原有渲染无需改动） ----------------
  async function sync() {
    if (mode_ !== 'server') return null;
    const m = M();
    const pr = await req('GET', '/api/products');
    const products = (pr && pr.items ? pr.items : []).map(fromServerProduct);
    m.saveCatalog(products);
    const or = await req('GET', '/api/orders');
    const orders = (or && or.items ? or.items : []).map(o => fromServerOrder(o, products));
    m._save(m.KEYS.orders, orders);
    return { products: products, orders: orders };
  }

  function mirroredOrder(id) {
    try { return M().getOrders().find(o => o.id === id) || null; } catch (e) { return null; }
  }

  // ---------------- 业务动作（后端优先，本地降级） ----------------
  async function createOrder(opts) {
    if (mode_ !== 'server') return M().createOrder(opts);
    const m = M();
    const sum = m.cartSummary();
    if (!sum.count) throw new Error('购物车是空的');
    const c = (opts && opts.customer) || {};
    const o = await req('POST', '/api/orders', {
      customerName: c.name,
      phone: c.phone,
      address: c.address || '',
      deliveryType: opts && opts.deliveryType,
      items: sum.lines.map(l => ({ code: l.code, qty: l.qty }))
    });
    await sync();
    m.clearCart();
    return o && o.id ? (mirroredOrder(o.id) || o) : o;
  }

  async function advanceOrder(id, to) {
    if (mode_ !== 'server') return M().advanceOrder(id, to);
    const o = await req('POST', '/api/orders/' + encodeURIComponent(id) + '/advance', { to: to });
    await sync();
    return o && o.id ? (mirroredOrder(o.id) || o) : o;
  }

  // 取消：服务端会把库存回补（状态机只允许「待备货」取消）
  async function cancelOrder(id) {
    if (mode_ !== 'server') return M().cancelOrder(id);
    return advanceOrder(id, 'cancelled');
  }

  async function setStock(code, stock) {
    if (mode_ !== 'server') {
      const list = M().loadCatalog();
      const p = list.find(x => x.code === code);
      if (!p) throw new Error('商品不存在：' + code);
      p.stock = stock;
      p.syncStatus = '待同步';
      M().saveCatalog(list);
      return p;
    }
    const p = await req('POST', '/api/products/stock', { code: code, stock: stock });
    await sync();
    return p;
  }

  async function upsertProduct(p) {
    if (mode_ !== 'server') {
      const m = M();
      const list = m.loadCatalog();
      const i = list.findIndex(x => x.code === p.code);
      const next = Object.assign({}, list[i] || {}, p);
      if (i >= 0) list[i] = next; else list.push(next);
      m.saveCatalog(list);
      return next;
    }
    const saved = await req('POST', '/api/products', p);
    await sync();
    return saved;
  }

  // 局部改字段（管理端改价 / 参考价）：先并进现有商品再整条提交
  async function updateProduct(code, patch) {
    if (mode_ !== 'server') return M().updateProduct(code, patch);
    const cur = M().loadCatalog().find(x => x.code === code) || { code: code };
    const next = Object.assign({}, cur, patch, { code: code });
    return upsertProduct(next);
  }

  // 条码解析（扫码只读，不改库存——D8）
  async function resolveBarcode(code) {
    return req('GET', '/api/barcode/resolve?code=' + encodeURIComponent(code));
  }

  // 价格防线巡检（服务端规则：售价 ≤ 参考价 × 0.95）
  async function pricingCheck() {
    return req('GET', '/api/pricing/check');
  }

  function _resetForTest() {
    cfg = Object.assign({}, DEFAULTS);
    mode_ = 'local';
    lastError = '';
    health_ = null;
  }

  return {
    configure: configure,
    boot: boot,
    probe: probe,
    sync: sync,
    mode: mode,
    on: on,
    health: health,
    status: status,
    base: base,
    req: req,
    createOrder: createOrder,
    advanceOrder: advanceOrder,
    cancelOrder: cancelOrder,
    setStock: setStock,
    upsertProduct: upsertProduct,
    updateProduct: updateProduct,
    resolveBarcode: resolveBarcode,
    pricingCheck: pricingCheck,
    fromServerProduct: fromServerProduct,
    fromServerOrder: fromServerOrder,
    _resetForTest: _resetForTest
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SdyApi;

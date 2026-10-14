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
  const LS_ADDR_KEY = 'sdy_addr_key';   // 地址簿身份钥匙：首次保存地址时服务端下发 32 位 hex，存本地
  const DEFAULTS = { timeoutMs: 5000, base: '', fetchImpl: null, mall: null, admin: null };

  let cfg = Object.assign({}, DEFAULTS);
  let mode_ = 'local';      // 'server' | 'local'
  let ordersAll = false;    // 订单镜像口径：false=只拉自己的（顾客页）/ true=全店（管理后台）
  let lastError = '';
  let health_ = null;

  // Node 测试没有 localStorage：key/镜像这类小数据用内存兜底（与 mall.js 同法）
  const mem = {};
  function lsGet(k) {
    if (typeof localStorage !== 'undefined') { try { const v = localStorage.getItem(k); if (v != null) return v; } catch (e) { /* 忽略 */ } }
    return (k in mem) ? mem[k] : null;
  }
  function lsSet(k, v) {
    const s = String(v);
    mem[k] = s;
    if (typeof localStorage !== 'undefined') { try { localStorage.setItem(k, s); } catch (e) { /* 忽略 */ } }
  }
  function lsDel(k) {
    delete mem[k];
    if (typeof localStorage !== 'undefined') { try { localStorage.removeItem(k); } catch (e) { /* 忽略 */ } }
  }
  // 地址簿钥匙（第 27 轮契约）：没有钥匙就当成「还没存过地址」，不发请求、不报错。
  function addrKey() { return lsGet(LS_ADDR_KEY) || ''; }
  function setAddrKey(k) { if (k) lsSet(LS_ADDR_KEY, k); return addrKey(); }

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
  // 第 27 轮 P0-4：把「连没连上后端」同步给 Mall。
  // Mall.loadCatalog 只在「从没连上过后端」时才允许用本地演示商品顶替；
  // 之前 setServerConnected 只有定义、没有任何调用点，等于这道闸门从没合上过。
  function notifyMallMode() {
    try {
      const m = resolveMall();
      if (m && typeof m.setServerConnected === 'function') m.setServerConnected(mode_ === 'server');
    } catch (e) { /* 测试环境下没有 Mall 时忽略 */ }
  }
  // resolveAdmin：库存流水的本地镜像由管理端模块负责（Node 测试可用 cfg.admin 注入桩）。
  function resolveAdmin() {
    if (cfg.admin && typeof cfg.admin.recordStockEntry === 'function') return cfg.admin;
    // 浏览器里 Admin 是 classic script 的顶层 const，不在 window 上，只能靠全局词法查找（与 resolveMall 同法）
    try {
      if (typeof Admin !== 'undefined' && Admin && typeof Admin.recordStockEntry === 'function') return Admin;
    } catch (e) { /* 尚未初始化（TDZ）时忽略 */ }
    if (typeof window !== 'undefined' && window.Admin && typeof window.Admin.recordStockEntry === 'function') return window.Admin;
    return null;
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

  // 请求头：管理端（ordersAll=true）额外声明 X-Admin: 1（服务端 identity.go adminMarked）。
  // 这一条不是安全边界，Cookie 才是；它只用来把管理后台和顾客页在同一个浏览器里分开。
  function reqHeaders(body) {
    const h = {};
    if (body != null) h['Content-Type'] = 'application/json';
    if (ordersAll) h['X-Admin'] = '1';
    return (h['Content-Type'] || h['X-Admin']) ? h : undefined;
  }

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
        // 第 27 轮管理端鉴权通道：管理后台靠 Cookie 认人（sdy_admin），同源部署下必须带上它。
        credentials: 'same-origin',
        // 管理后台要显式声明身份（第 27 轮 identity.go adminMarked）：管理员 Cookie 与顾客页
        // 共用同一个浏览器，服务端不能「带了 Cookie 就当管理员」，否则老板逛顾客页会看到全店订单。
        headers: reqHeaders(body),
        body: body == null ? undefined : JSON.stringify(body),
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      // 人话在前、技术原因在后：顾客只看懂前半句，排查的人看后半句
      const why = (e && e.name === 'AbortError') ? '请求超时' : ((e && e.message) ? e.message : String(e));
      throw new Error('无法连接后端（' + (base() || '同源') + '）：连不上店里，请检查网络后重试 [技术原因：' + why + ']');
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
    notifyMallMode();
    return health_;
  }

  // 页面启动：探测 → 连上就拉一次全量镜像
  async function boot(opts) {
    if (opts) configure(opts);
    await probe();
    if (mode_ === 'server') {
      try { await sync(null, opts); } catch (e) { lastError = e.message; }
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
      wholesalePrice: p.wholesalePrice || 0,   // 批发价（任务池⑦ / D24）：0＝未设
      price: (typeof p.price === 'number' && isFinite(p.price)) ? p.price : (p.salePrice || 0), // 服务端算好的有效价（真源）
      refPrice: p.refPrice || 0,
      unit: p.unit || '件',
      stock: p.stock || 0,
      isWholesale: !!p.isWholesale,
      onSale: p.onSale !== false,   // D23：字段缺失视为上架，只有明确 false 才是下架
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
  // phone 缺省时用本地记住的「我的手机号」——带上它，服务端才会按顾客等级下发有效价（D24）。
  //
  // opts.all=true 表示「这是管理后台，我就是要全店订单」。**顾客页面绝不能传它**：
  // 第 27 轮身份收敛后，服务端只在完全没有身份时才把请求当管理员放行（灰度默认），
  // 顾客页若不带手机号去要订单列表，就会在灰度模式下拿回全店订单（含别人姓名地址）。
  async function sync(phone, opts) {
    if (mode_ !== 'server') return null;
    // 订单可见范围只在显式传 opts 时改变：传过一次 {all:true}（管理后台）之后，内部
    // 那些「写操作后顺手刷镜像」的 sync() 也沿用 all，免得后台改完商品就把订单清空。
    if (opts && typeof opts.all === 'boolean') ordersAll = opts.all;
    const all = ordersAll;
    const m = M();
    const raw = (phone == null) ? (m.getMyPhone ? m.getMyPhone() : '') : String(phone || '').trim();
    // 管理端（all）请求订单时**不能**带手机号：带了服务端就按手机号过滤，老板只看得到一个顾客的单。
    // 同源 localStorage 是共享的，老板自己也在顾客页下过单，所以这个「残留手机号」是真会发生的。
    const p = all ? '' : raw;
    // 运营参数（配送费 / 免运费门槛 / 低库存阈值 / 起送价）：服务端是真源。
    // 第 27 轮以前前端只用自己那份默认值，Go 与页面在 29.995 这种边界上会算出不同的钱。
    try {
      const cfgS = await req('GET', '/api/settings');
      if (cfgS && m.setSettings) m.setSettings(cfgS);
    } catch (e) { /* 设置拉不到不影响商品与订单 */ }
    const pr = await req('GET', '/api/products' + (raw ? '?phone=' + encodeURIComponent(raw) : ''));
    const products = (pr && pr.items ? pr.items : []).map(fromServerProduct);
    m.saveCatalog(products);
    if (raw && m.setMyPhone) m.setMyPhone(raw, (pr && pr.tier) || '');
    // 订单列表（第 27 轮身份收敛）：顾客必须带手机号，服务端只回他自己的单；
    // 管理后台（opts.all）没有手机号也照拉，靠管理员放行拿全店单。
    let orders = [];
    if (!p && !all) {
      // 顾客页 + 不知道自己的手机号 = 没有任何身份，干脆不问（灰度模式下问 = 拿回全店订单）
      m._save(m.KEYS.orders, []);
      return { products: products, orders: [], tier: (pr && pr.tier) || '', needIdentity: true };
    }
    try {
      const or = await req('GET', '/api/orders' + (p ? '?phone=' + encodeURIComponent(p) : ''));
      orders = (or && or.items ? or.items : []).map(o => fromServerOrder(o, products));
      m._save(m.KEYS.orders, orders);
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg.indexOf('缺少身份') < 0) throw e;   // 真异常（断网 / 500）交给页面显示错误态
      m._save(m.KEYS.orders, []);                // 「没身份」= 本来就不该看到任何订单，不是错误
      return { products: products, orders: [], tier: (pr && pr.tier) || '', needIdentity: true };
    }
    return { products: products, orders: orders, tier: (pr && pr.tier) || '', needIdentity: false };
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
      items: sum.lines.map(l => ({ code: l.code, qty: l.qty })),
      // 幂等键（第 27 轮）：超时重试 / 用户连点同一个结算只落一张单，库存只扣一次。
      // 必须由发起方生成：服务端拿它去重，自己再造一个就失去意义。
      clientToken: (opts && opts.clientToken) || ('W' + Date.now() + Math.floor(Math.random() * 1000))
    });
    if (c.phone && m.setMyPhone) m.setMyPhone(c.phone);   // 记住手机号：下次同步就按我的等级取价（D24）
    // 订单已经落库了：镜像刷新失败（断网）不该让顾客看到「下单失败」而重复下单
    try { await sync(); } catch (e) { /* 忽略：以服务端返回的单号为准 */ }
    m.clearCart();
    return o && o.id ? (mirroredOrder(o.id) || o) : o;
  }

  async function advanceOrder(id, to) {
    if (mode_ !== 'server') return M().advanceOrder(id, to);
    const m = M();
    // 第 27 轮 advance 收敛为「员工推进」；顾客只保留「确认收货」（to=done）靠手机号证明归属
    const p = m.getMyPhone ? m.getMyPhone() : '';
    const o = await req('POST', '/api/orders/' + encodeURIComponent(id) + '/advance' + (p ? '?phone=' + encodeURIComponent(p) : ''), { to: to });
    try { await sync(); } catch (e) { /* 同上：状态已改，镜像慢一拍不算失败 */ }
    return o && o.id ? (mirroredOrder(o.id) || o) : o;
  }

  // 取消：第 27 轮起走独立的 /cancel —— 服务端按归属校验（不是我的单给 404），
  // 并在事务里回补库存、写 stock_log 回补流水；以前复用 /advance 是借道，语义与审计都不对。
  async function cancelOrder(id) {
    if (mode_ !== 'server') return M().cancelOrder(id);
    const m = M();
    const p = m.getMyPhone ? m.getMyPhone() : '';
    const res = await req('POST', '/api/orders/' + encodeURIComponent(id) + '/cancel' + (p ? '?phone=' + encodeURIComponent(p) : ''), { to: 'cancelled' });
    try { await sync(); } catch (e) { /* 同上 */ }
    return res;
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
    try { await sync(); } catch (e) { /* 改库存已成功，镜像刷新失败不该报错 */ }
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
    try { await sync(); } catch (e) { /* 保存已成功，镜像刷新失败不该报错 */ }
    return saved;
  }

  // 局部改字段（管理端改价 / 参考价）：先并进现有商品再整条提交
  async function updateProduct(code, patch) {
    if (mode_ !== 'server') return M().updateProduct(code, patch);
    const cur = M().loadCatalog().find(x => x.code === code) || { code: code };
    const next = Object.assign({}, cur, patch, { code: code });
    return upsertProduct(next);
  }

  // 删除商品档案：后端会校验「库存已盘点为 0 + 无进行中订单」，
  // 本地降级路径只改镜像，规则提示统一由 Admin.assertDeletable 提供。
  async function deleteProduct(code) {
    if (mode_ !== 'server') {
      const m = M();
      const list = m.loadCatalog();
      const i = list.findIndex(x => x.code === code);
      if (i < 0) throw new Error('商品不存在：' + code);
      list.splice(i, 1);
      m.saveCatalog(list);
      return { ok: true, code: code };
    }
    const res = await req('DELETE', '/api/products/' + encodeURIComponent(code));
    await sync();
    return res;
  }

  // 批量上下架（任务池⑥ / D23）：后端只动 on_sale，返回真正变化的条码。
  // 离线降级时直接改镜像，语义保持一致（重复设置同一状态不产生变化）。
  async function setOnSale(codes, onSale) {
    const list = (codes || []).map(c => String(c).trim()).filter(Boolean);
    if (!list.length) throw new Error('参数不合法: 请至少选择一个商品');
    if (mode_ !== 'server') {
      const m = M();
      const all = m.loadCatalog();
      const changed = [];
      list.forEach(code => {
        const p = all.find(x => x.code === code);
        if (!p) throw new Error('资源不存在: 商品 ' + code);
        if ((p.onSale !== false) === !!onSale) return;
        p.onSale = !!onSale;
        changed.push(code);
      });
      m.saveCatalog(all);
      return { ok: true, onSale: !!onSale, changed: changed, count: changed.length };
    }
    const res = await req('POST', '/api/products/onsale', { codes: list, onSale: !!onSale });
    await sync();
    return res;
  }

  // ---------------- 我的价格 / 顾客等级（任务池⑦ / D24） ----------------
  // 顾客端没有账号体系：手机号就是身份。带上手机号重新同步一次，服务端按等级算好
  // price 下发；页面只读 price，本地不算价（价格口径的真源在服务端——同 D12）。
  async function setMyPhone(phone) {
    const m = M();
    const p = String(phone == null ? '' : phone).trim();
    m.setMyPhone(p);
    if (mode_ !== 'server') return { phone: p, tier: m.getMyTier(), offline: true };
    const res = await sync(p);
    return { phone: p, tier: (res && res.tier) || 'retail' };
  }
  function getMyPhone() { return M().getMyPhone ? M().getMyPhone() : ''; }
  function getMyTier() { return M().getMyTier ? M().getMyTier() : 'retail'; }

  // 顾客档案（管理端用）：列顾客与设等级；离线时管理端直接读写本地档案，这里返回 null。
  async function listCustomers() {
    if (mode_ !== 'server') return null;
    const res = await req('GET', '/api/customers');
    return (res && res.items ? res.items : []);
  }
  async function setCustomerTier(phone, name, tier) {
    if (mode_ !== 'server') return null;
    return req('POST', '/api/customers/tier', { phone: phone, name: name || '', tier: tier });
  }
  async function setCustomerNote(phone, name, tags, note) {
    if (mode_ !== 'server') return null;
    return req('POST', '/api/customers/note', { phone: phone, name: name || '', tags: tags || '', note: note || '' });
  }

  // ---------------- 库存流水 / 配送员 / 门店抬头（任务池⑧ / D25） ----------------
  // 这四样原来只存在浏览器 localStorage，换台设备 / 清缓存就丢；现在真源都在后端。
  // changeStock：入库 / 改数 / 盘点唯一入口，服务端一个事务里改库存 + 写审计流水。
  async function changeStock(code, kind, qty, reason, by) {
    if (mode_ !== 'server') return null;
    const res = await req('POST', '/api/stock/change', {
      code: code, kind: kind, qty: Number(qty), reason: reason || '', by: by || ''
    });
    const a = resolveAdmin();
    if (res && res.entry && a) a.recordStockEntry(res.entry);   // 本地镜像对齐（库存 + 流水，按 id 幂等）
    return res;
  }
  async function listStockLog(limit) {
    if (mode_ !== 'server') return null;
    const res = await req('GET', '/api/stocklog?limit=' + (Number(limit) > 0 ? Number(limit) : 30));
    return (res && res.items ? res.items : []);
  }
  async function listCouriers() {
    if (mode_ !== 'server') return null;
    const res = await req('GET', '/api/couriers');
    return (res && res.items ? res.items : []);
  }
  async function saveCourier(name, phone, remove) {
    if (mode_ !== 'server') return null;
    const res = await req('POST', '/api/couriers', { name: name, phone: phone || '', remove: !!remove });
    return (res && res.items ? res.items : []);
  }
  async function getSettings() {
    if (mode_ !== 'server') return null;
    return req('GET', '/api/settings');
  }
  async function saveSettings(s) {
    if (mode_ !== 'server') return null;
    const x = s || {};
    return req('POST', '/api/settings', {
      name: x.name || '', phone: x.phone || '', address: x.address || '', footer: x.footer || ''
    });
  }

  // ---------------- 收货地址簿（D18） ----------------
  // 在线时以后端为准，每次操作后把整册镜像回 localStorage（离线仍能一键带出默认地址）；
  // 离线时直接用 Mall 的本地地址簿（同一套默认地址语义），页面代码无需分叉。
  async function listAddresses(phone) {
    const m = M();
    if (mode_ !== 'server') return m.listAddresses(phone);
    // 第 27 轮起地址簿有了钥匙（key）：只凭手机号就能读写别人的地址是越权。
    // 拿到册子时顺手把这把钥匙记在本机，后续的增删查都带上它。
    const k = addrKey();
    const res = await req('GET', '/api/addresses?phone=' + encodeURIComponent(phone) + (k ? '&key=' + encodeURIComponent(k) : ''));
    const items = (res && res.items ? res.items : []);
    if (res && res.key) setAddrKey(res.key);
    try { m._saveAddresses(phone, items); } catch (e) {}
    return items;
  }

  async function defaultAddress(phone) {
    const list = await listAddresses(phone).catch(() => []);
    return list.find(a => a.isDefault) || list[0] || null;
  }

  async function saveAddress(a) {
    const m = M();
    if (mode_ !== 'server') return m.saveAddress(a);
    const k = addrKey();
    const saved = await req('POST', '/api/addresses' + (k ? '?key=' + encodeURIComponent(k) : ''), {
      id: Number(a.id) || 0, phone: a.phone, contact: a.contact,
      address: a.address, isDefault: !!a.isDefault
    });
    if (saved && saved.key) setAddrKey(saved.key);    // 服务端首次为这个手机号发钥匙
    await listAddresses(a.phone).catch(() => null);   // 重新拉一遍，镜像与后端一致
    return saved;
  }

  async function deleteAddress(phone, id) {
    const m = M();
    if (mode_ !== 'server') return m.deleteAddress(phone, id);
    const k = addrKey();
    const res = await req('DELETE', '/api/addresses/' + encodeURIComponent(id) + '?phone=' + encodeURIComponent(phone) + (k ? '&key=' + encodeURIComponent(k) : ''));
    await listAddresses(phone).catch(() => null);
    return res;
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
    notifyMallMode();
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
    deleteProduct: deleteProduct,
    setOnSale: setOnSale,
    setMyPhone: setMyPhone,
    getMyPhone: getMyPhone,
    getMyTier: getMyTier,
    listCustomers: listCustomers,
    setCustomerTier: setCustomerTier,
    setCustomerNote: setCustomerNote,
    changeStock: changeStock,
    listStockLog: listStockLog,
    listCouriers: listCouriers,
    saveCourier: saveCourier,
    getSettings: getSettings,
    saveSettings: saveSettings,
    listAddresses: listAddresses,
    defaultAddress: defaultAddress,
    saveAddress: saveAddress,
    deleteAddress: deleteAddress,
    resolveBarcode: resolveBarcode,
    pricingCheck: pricingCheck,
    fromServerProduct: fromServerProduct,
    fromServerOrder: fromServerOrder,
    _resetForTest: _resetForTest
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SdyApi;

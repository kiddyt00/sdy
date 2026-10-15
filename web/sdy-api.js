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
  // doc / createObjectURL / revokeObjectURL：只在 Node 测试里注入（浏览器留空即用全局 document/URL）
  const DEFAULTS = {
    timeoutMs: 5000, base: '', fetchImpl: null, mall: null, admin: null,
    doc: null, createObjectURL: null, revokeObjectURL: null
  };

  let cfg = Object.assign({}, DEFAULTS);
  let mode_ = 'local';      // 'server' | 'local'
  let ordersAll = false;    // 订单镜像口径：false=只拉自己的（顾客页）/ true=全店（管理后台）
  // 支付轮（payEnabled）：/api/settings 的派生字段（微信支付是否配好）。**默认 false = 未开通**：
  // 字段缺失 / 请求失败 / 不是布尔，全按未开通算——这正是服务端还没上这个字段时的线上真实状态。
  let payEnabled_ = false;
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
      status: o.status,
      // 支付轮（支付）：服务端新增的支付/退款字段必须原样透到镜像里——
      // 管理端「支付」列、退款可见性、待备货队列全靠它们，少一个就会静默当「未付款」。
      // 老服务端没有这些字段时按下线兜底（paid=0 / 时间 0 / 单号空），页面口径不受影响。
      paid: o.paid === true || o.paid === 1 || o.paid === '1',
      paidAt: ts(o.paidAt),
      transactionId: o.transactionId || '',
      payExpireAt: Number(o.payExpireAt) || 0,
      refundId: o.refundId || '',
      refundState: o.refundState || ''
    };
  }

  // ---------------- 商品列表 / 热销 / 缺货替代（第 28 轮 7.2–7.4、7.8） ----------------
  // 排序取值三端逐字相同（7.8）：default|hot|price_asc|price_desc|stock_desc。
  // 未知值不在这里改写成 default：原样发给服务端，由服务端按契约回 400「排序方式不支持：<值>」，
  // 免得前端「悄悄改成综合」把问题藏起来。
  const SORTS = ['default', 'hot', 'price_asc', 'price_desc', 'stock_desc'];
  const PRODUCT_QUERY_ORDER = ['keyword', 'category', 'onSale', 'phone', 'sort', 'limit', 'offset'];
  // 支付轮（支付）：订单筛选多一个 paid=0|1。放在 type 之后，保持老参数顺序不变。
  const ORDER_QUERY_ORDER = ['phone', 'q', 'status', 'date', 'from', 'to', 'type', 'paid'];  // 7.5：新名字，绝不复用 phone 做筛选
  const HOT_QUERY_ORDER = ['limit', 'phone'];
  const ALT_QUERY_ORDER = ['code', 'limit'];

  // 查询串拼装（纯函数，Node 可逐字断言）：空值不拼、顺序固定。
  function queryString(order, params) {
    const p = params || {};
    const parts = [];
    order.forEach(k => {
      const v = p[k];
      if (k === 'onSale') {                       // 契约只认 onSale=1；0/'' 等于不过滤
        if (v === 1 || v === '1' || v === true) parts.push('onSale=1');
        return;
      }
      if (v == null) return;
      if (typeof v === 'string' && v.trim() === '') return;
      parts.push(k + '=' + encodeURIComponent(String(v)));
    });
    return parts.length ? '?' + parts.join('&') : '';
  }
  function productQuery(params) { return queryString(PRODUCT_QUERY_ORDER, params); }
  // 订单筛选串只含 filter 的 8 个字段；phone 由身份通道单独拼，filter 里的 phone 会被无视。
  // 支付轮（支付）：paid 逐字进 query；''/'all'/null 视为不带（= 全部支付状态）。
  // sync() 里逐字段取值时也复用它，保证「筛选串」与「真请求」两条管子口径完全一致。
  function paidParam(v) {
    if (v === '' || v === 'all' || v == null) return undefined;
    return v;
  }
  function orderFilterQuery(filter) {
    const f = Object.assign({}, filter || {});
    f.paid = paidParam(f.paid);
    return queryString(ORDER_QUERY_ORDER.slice(1), f);
  }

  function num(v, dflt, max) {
    const n = Number(v);
    if (!isFinite(n) || n < 0) return dflt;
    return (max && n > max) ? max : n;
  }

  // 离线兜底：与后端同口径的本地筛选/排序/分页（mall.js 提供纯函数，页面零分叉）
  function localList(params) {
    const m = M();
    const lp = (typeof m.listPage === 'function')
      ? m.listPage(params || {})
      : { items: [], total: 0, limit: 0, offset: 0, hasMore: false };
    return {
      items: (lp.items || []).map(x => Object.assign({}, x)),
      total: lp.total || 0,
      limit: lp.limit || 0,
      offset: lp.offset || 0,
      hasMore: !!lp.hasMore,
      tier: (m.getMyTier ? m.getMyTier() : 'retail')
    };
  }

  // 商品列表（7.2）。有手机号就带上，才能拿到批发有效价（D24）。
  async function listProducts(params) {
    const p = Object.assign({}, params || {});
    if (p.phone == null) {
      const mp = M().getMyPhone ? M().getMyPhone() : '';
      if (mp) p.phone = mp;
    }
    if (mode_ !== 'server') return localList(p);
    const res = await req('GET', '/api/products' + productQuery(p));
    const items = ((res && res.items) || []).map(fromServerProduct);
    const total = (res && typeof res.total === 'number') ? res.total : items.length;
    const limit = (res && typeof res.limit === 'number') ? res.limit : num(p.limit, 0, 200);
    const offset = (res && typeof res.offset === 'number') ? res.offset : num(p.offset, 0);
    return {
      items: items,
      total: total,
      limit: limit,
      offset: offset,
      // 老服务端没回 hasMore 时按 total 推断（与小程序端同一套兜底）
      hasMore: (res && typeof res.hasMore === 'boolean') ? res.hasMore : (offset + items.length < total),
      tier: (res && res.tier) || (M().getMyTier ? M().getMyTier() : 'retail')
    };
  }

  // 热销（7.3）：默认 8 件、最多 20 件；首页热销与「无结果推荐」共用。
  async function hotProducts(limit) {
    const n = num(limit, 8, 20) || 8;
    const q = { limit: n };
    const mp = M().getMyPhone ? M().getMyPhone() : '';
    if (mp) q.phone = mp;
    if (mode_ !== 'server') {
      const lp = localList({ sort: 'hot', onSale: 1, limit: n, offset: 0 });
      return { items: lp.items, total: lp.total };
    }
    const res = await req('GET', '/api/products/hot' + queryString(HOT_QUERY_ORDER, q));
    const items = ((res && res.items) || []).map(fromServerProduct);
    return { items: items, total: (res && typeof res.total === 'number') ? res.total : items.length };
  }

  // 缺货替代（7.4）：code 缺失就地安静降级成空列表，不发请求、不报错。
  async function alternatives(code, limit) {
    const c = String(code == null ? '' : code).trim();
    const n = num(limit, 5, 20) || 5;
    if (!c) return { items: [], total: 0 };
    if (mode_ !== 'server') {
      const m = M();
      if (typeof m.alternatives !== 'function') return { items: [], total: 0 };
      const r = m.alternatives(c, n);
      return { items: r.items || [], total: (r.total == null ? (r.items || []).length : r.total) };
    }
    const res = await req('GET', '/api/products/alternatives' + queryString(ALT_QUERY_ORDER, { code: c, limit: n }));
    const items = ((res && res.items) || []).map(fromServerProduct);
    return { items: items, total: (res && typeof res.total === 'number') ? res.total : items.length };
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
    // 第 28 轮（7.5）：筛选参数只做筛选、不参与身份判定。这里**逐字段显式取值**而不是
    // Object.assign(filter, …)：filter 里就算混进 phone，也绝不可能顶掉身份通道的 phone。
    const filt = (opts && opts.filter) || {};
    const oq = queryString(ORDER_QUERY_ORDER, {
      phone: p, q: filt.q, status: filt.status, date: filt.date, from: filt.from, to: filt.to, type: filt.type,
      paid: paidParam(filt.paid)
    });
    // 运营参数（配送费 / 免运费门槛 / 低库存阈值 / 起送价）：服务端是真源。
    // 第 27 轮以前前端只用自己那份默认值，Go 与页面在 29.995 这种边界上会算出不同的钱。
    try {
      const cfgS = await req('GET', '/api/settings');
      // 严格认布尔真值：服务端下发 JSON bool，缺字段 / 字符串 'true' / 1 都按未开通。
      payEnabled_ = (cfgS && cfgS.payEnabled === true);
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
      return { products: products, orders: [], tier: (pr && pr.tier) || '', needIdentity: true, total: 0 };
    }
    try {
      const or = await req('GET', '/api/orders' + oq);
      orders = (or && or.items ? or.items : []).map(o => fromServerOrder(o, products));
      m._save(m.KEYS.orders, orders);
      return {
        products: products, orders: orders, tier: (pr && pr.tier) || '', needIdentity: false,
        // 第 28 轮（7.5）：total 是「过滤后的真实总数」（服务端 COUNT(*)），不是当前页条数
        total: (or && typeof or.total === 'number') ? or.total : orders.length
      };
    } catch (e) {
      const msg = (e && e.message) || String(e);
      if (msg.indexOf('缺少身份') < 0) throw e;   // 真异常（断网 / 500）交给页面显示错误态
      m._save(m.KEYS.orders, []);                // 「没身份」= 本来就不该看到任何订单，不是错误
      return { products: products, orders: [], tier: (pr && pr.tier) || '', needIdentity: true, total: 0 };
    }
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

  /* ---------------- 支付 / 退款 / 对账（支付轮契约，docs/支付与配送-方案与验收.md §1.5） ----------------
   * 契约已冻结但服务端可能还没实现完：这四个动作全部沿用 req()（credentials:'same-origin' +
   * 管理员/员工时带 X-Admin），请求形状按契约写死，不做本地假成功——后端没实现就会拿到 404/503，
   * 页面照原样红字报出来，绝不能让老板以为收款成功了。
   */

  // 线下收款兜底（现金 / 未开通微信支付）：POST /api/orders/{id}/mark-paid，body 可带 {"note":"现金"}。
  // 管理员/员工接口（adminGate）→ 必须带 X-Admin，靠 opts.all=true 打开。
  async function markPaid(orderId, note) {
    if (mode_ !== 'server') throw new Error('线下收款需要连上后端（本地演示不落库）');
    ordersAll = true;   // 该接口是管理员/员工通道，不带上身份会 404/403
    const body = {};
    if (note != null && String(note).trim() !== '') body.note = String(note).trim();
    const o = await req('POST', '/api/orders/' + encodeURIComponent(orderId) + '/mark-paid', body);
    try { await sync(null, { all: true }); } catch (e) { /* 收款已成功，镜像慢一拍不算失败 */ }
    return o && o.id ? (mirroredOrder(o.id) || o) : o;
  }

  // 微信下单（小程序收银台用）：POST /api/pay/prepay，body {"orderId":"M…"}。
  // 200 → {outTradeNo, amountFen, payParams, expireAt}；未配置支付 → 503（原样抛给调用方）。
  async function prepayOrder(orderId) {
    if (mode_ !== 'server') throw new Error('线上支付需要连上后端（未配置微信支付时会回 503）');
    return await req('POST', '/api/pay/prepay', { orderId: orderId });
  }

  // 支付状态查询（兜底查单）：GET /api/pay/status?orderId=M…，顾客侧按归属校验。
  async function payStatus(orderId) {
    if (mode_ !== 'server') {
      const o = M().getOrders().find(x => x.id === orderId);
      return { paid: !!(o && o.paid), status: (o && o.status) || '', transactionId: (o && o.transactionId) || '', refundState: (o && o.refundState) || '', expireAt: (o && o.payExpireAt) || 0 };
    }
    return await req('GET', '/api/pay/status?orderId=' + encodeURIComponent(orderId));
  }

  // 发起退款：**服务端目前没有独立的退款接口**（契约 §1.7：取消已付款订单时服务端自动发起退款，
  // 退款结果由 /api/pay/refund-notify 回调更新）。所以这里如实调 POST /api/orders/{id}/cancel——
  // 对已付款单它会顺带把 refundState 置为 processing；reason 服务端取「取消原因」，此处一并带上。
  async function refundOrder(orderId, reason) {
    if (mode_ !== 'server') throw new Error('退款需要连上后端（本地演示不落库）');
    ordersAll = true;   // 后台柜台动作，走管理员通道
    const body = { to: 'cancelled' };
    if (reason != null && String(reason).trim() !== '') body.reason = String(reason).trim();
    const res = await req('POST', '/api/orders/' + encodeURIComponent(orderId) + '/cancel', body);
    try { await sync(null, { all: true }); } catch (e) { /* 退款已发起，镜像慢一拍不算失败 */ }
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
    const s = await req('GET', '/api/settings');
    payEnabled_ = (s && s.payEnabled === true);   // 顺手刷新支付开通状态缓存
    return s;
  }
  // 在线支付是否已开通。真源是 /api/settings 的 payEnabled：sync / getSettings 拉到后同时写进
  // Mall（显示口径真源）与这里的缓存。Mall 在时以 Mall 为准，免得两处缓存各说各话。
  function payEnabled() {
    const m = resolveMall();
    if (m && typeof m.payEnabled === 'function') return m.payEnabled() === true;
    return payEnabled_ === true;
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

  // ---------------- 订单导出 CSV（第 28 轮 7.6，后台用） ----------------
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function csvFilename(d) {
    // 文件名用**本地时间**：老板看到的「今天」和自己电脑一致（orders-YYYYMMDD-HHMM.csv）
    const x = (d == null) ? new Date() : new Date(d);
    return 'orders-' + x.getFullYear() + pad2(x.getMonth() + 1) + pad2(x.getDate()) +
      '-' + pad2(x.getHours()) + pad2(x.getMinutes()) + '.csv';
  }
  // 导出地址（纯函数，可逐字断言）：筛选参数与列表同一套；phone 永远不参与筛选。
  function ordersCsvURL(filter) { return '/api/orders/export.csv' + orderFilterQuery(filter); }

  // 浏览器里：fetch 拿 blob → <a download> 触发下载。失败一律 throw（后台 catch 会红 toast 报错）。
  // Node / 无 DOM：按契约返回可断言的形状，**不抛未捕获异常**（页面侧另有明确提示，不静默）。
  async function downloadOrdersCSV(filter) {
    const path = ordersCsvURL(filter);
    const filename = csvFilename();
    const doc = cfg.doc || ((typeof document !== 'undefined') ? document : null);
    const mkURL = cfg.createObjectURL ||
      ((typeof URL !== 'undefined' && URL && typeof URL.createObjectURL === 'function') ? URL.createObjectURL.bind(URL) : null);
    if (!doc) {
      // 纯 Node（测试 / 脚本）环境：按可断言的形状返回，绝不抛未捕获异常
      return { ok: false, reason: '无浏览器环境', path: path, filename: filename };
    }
    if (!mkURL) {
      // 真浏览器但缺 API：必须 throw，后台的 catch 会红 toast 报错——不能返回 ok:false 让页面假报成功
      throw new Error('这个浏览器不支持 blob 下载（URL.createObjectURL 缺失），请换新一点的浏览器再导出');
    }
    const f = fetchImpl();
    if (!f) throw new Error('当前环境不支持 fetch');
    // 导出是管理端动作：显式带 X-Admin: 1（与 reqHeaders 同一条通道），同源 Cookie 自动携带
    const h = reqHeaders(null) || {};
    h['X-Admin'] = '1';
    let res;
    try {
      res = await f(url(path), { method: 'GET', credentials: 'same-origin', headers: h });
    } catch (e) {
      const why = (e && e.message) ? e.message : String(e);
      throw new Error('无法连接后端（' + (base() || '同源') + '）：导出失败，请检查网络后重试 [技术原因：' + why + ']');
    }
    if (!res.ok) {
      let text = '';
      try { text = await res.text(); } catch (e) { text = ''; }
      let data = null;
      if (text) { try { data = JSON.parse(text); } catch (e) { data = null; } }
      throw new Error((data && (data.error || data.msg)) || ('导出失败：HTTP ' + res.status));
    }
    const blob = (typeof res.blob === 'function') ? await res.blob() : null;
    if (!blob) throw new Error('导出失败：后端没有返回文件内容');
    const cd = (res.headers && typeof res.headers.get === 'function') ? String(res.headers.get('Content-Disposition') || '') : '';
    const mfn = /filename="?([^";]+)"?/.exec(cd);
    const name = (mfn && mfn[1]) || filename;
    const href = mkURL(blob);
    const a = doc.createElement('a');
    a.href = href;
    a.download = name;
    if (doc.body && typeof doc.body.appendChild === 'function') doc.body.appendChild(a);
    a.click();
    if (a.parentNode && typeof a.parentNode.removeChild === 'function') a.parentNode.removeChild(a);
    // 释放 blob URL 必须**延迟**：Firefox / Safari 里紧跟 click() 同步 revoke 会把刚发起的下载
    // 取消掉（Chrome 多数情况没事，但老板对账导出不能靠运气）。没有 setTimeout 时同步兜底。
    const rv = cfg.revokeObjectURL || ((typeof URL !== 'undefined' && URL && URL.revokeObjectURL) ? URL.revokeObjectURL.bind(URL) : null);
    if (rv) {
      if (typeof setTimeout === 'function') {
        setTimeout(() => { try { rv(href); } catch (e) { /* 释放失败不影响已经触发的下载 */ } }, 0);
      } else {
        rv(href);
      }
    }
    return { ok: true, filename: name, path: path };
  }

  function _resetForTest() {
    cfg = Object.assign({}, DEFAULTS);
    mode_ = 'local';
    lastError = '';
    health_ = null;
    payEnabled_ = false;   // 复位即「未开通」，与「取不到 = 未开通」同一口径
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
    // 支付轮（支付）：线下收款 / 微信下单 / 查单 / 发起退款
    markPaid: markPaid,
    prepayOrder: prepayOrder,
    payStatus: payStatus,
    refundOrder: refundOrder,
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
    // 支付轮（payEnabled）：在线支付是否开通（false = 未开通，全站退回「待备货」语义）
    payEnabled: payEnabled,
    listAddresses: listAddresses,
    defaultAddress: defaultAddress,
    saveAddress: saveAddress,
    deleteAddress: deleteAddress,
    resolveBarcode: resolveBarcode,
    pricingCheck: pricingCheck,
    // 第 28 轮（7.2–7.6、7.8）：列表/热销/替代/导出。管理后台照这些签名调用。
    SORTS: SORTS,
    listProducts: listProducts,
    hotProducts: hotProducts,
    alternatives: alternatives,
    downloadOrdersCSV: downloadOrdersCSV,
    ordersCsvURL: ordersCsvURL,
    csvFilename: csvFilename,
    productQuery: productQuery,
    orderFilterQuery: orderFilterQuery,
    fromServerProduct: fromServerProduct,
    fromServerOrder: fromServerOrder,
    _resetForTest: _resetForTest
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SdyApi;

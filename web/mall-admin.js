/* =====================================================================
 * 管理端 Demo —— 核心逻辑（无 DOM，可在 Node 中直接测试）
 * 对应《开发计划》M1.2：订单管理（状态操作 + 4 人配送雏形）、
 * 库存管理（入库单/盘点/直接改数，D8 手动）、顾客管理（私域雏形）、
 * 商品档案（建档 / 编辑 / 删除，任务池①）。
 * 数据约定：与顾客端共用 mall_orders；库存沿用 bd_products；
 *           管理端自有 mall_couriers / mall_stockLog / mall_customers。
 * 不变量：
 *   - 一切库存变更必须走本模块并留流水（审计），扫码不改库存（D8）；
 *   - 商品编辑表单**不改库存**（库存只从库存页的入库/改数/盘点进出）；
 *   - 删除商品要求库存已盘点为 0、且没有进行中的订单引用（与后端同规则）。
 * ===================================================================== */
'use strict';

// 浏览器：mall.js / pricing.js 已定义全局 Mall / Pricing；Node：require
// 注意：浏览器里 mall.js 已声明全局 const Mall / pricing.js 已声明 const Pricing，
//       这里一律用 *Core 别名，避免 classic script 顶层重名（曾整文件静默失效）。
const MallCore = (typeof module !== 'undefined' && module.exports)
  ? require('./mall.js')
  : (typeof Mall !== 'undefined' ? Mall : window.Mall);
const PricingCore = (typeof module !== 'undefined' && module.exports)
  ? require('./pricing.js')
  : (typeof Pricing !== 'undefined' ? Pricing : window.Pricing);

const Admin = (() => {

  const KEYS = {
    couriers: 'mall_couriers',
    stockLog: 'mall_stockLog',
    customerNotes: 'mall_customers',
    store: 'mall_store'
  };
  const DEFAULT_COURIERS = ['老张', '小李', '阿强', '小美']; // 4 人配送雏形

  // ---------------- 配送员 ----------------
  function getCouriers() {
    const c = MallCore._load(KEYS.couriers, null);
    if (!Array.isArray(c) || !c.length) { MallCore._save(KEYS.couriers, DEFAULT_COURIERS); return DEFAULT_COURIERS.slice(); }
    return c.slice();
  }
  function setCouriers(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('配送员名单不能为空');
    MallCore._save(KEYS.couriers, list);
    return list;
  }
  // 新增 / 删除配送员（任务池⑧ / D25）：在线模式真源在服务端；
  // 离线模式只能维护姓名清单（手机号要有后端才存得住），规则与服务端保持一致。
  function saveCourier(name, phone, remove) {
    const n = String(name == null ? '' : name).trim();
    if (!n) throw new Error('配送员姓名不能为空');
    if (n.length > 12) throw new Error('配送员姓名不能超过 12 字');
    const list = getCouriers();
    if (remove) {
      if (list.length <= 1) throw new Error('至少要保留一位配送员');
      const i = list.indexOf(n);
      if (i < 0) throw new Error('配送员不存在：' + n);
      list.splice(i, 1);
      return setCouriers(list);
    }
    if (list.indexOf(n) < 0) list.push(n);
    return setCouriers(list);
  }

  // ---------------- 库存流水 ----------------
  // 字段与服务端对齐（D25）：服务端用 kind / at，本地历史数据用 type / ts，
  // 这里两个都写（值相同），页面只读 kind / at，老流水也不会读不出来。
  function getStockLog(limit) {
    const l = MallCore._load(KEYS.stockLog, []);
    const arr = Array.isArray(l) ? l : [];
    const n = Number(limit);
    return n > 0 ? arr.slice(0, n) : arr;
  }
  function logStock(entry) {
    const l = getStockLog();
    const e = Object.assign({ ts: Date.now() }, entry);
    e.kind = e.kind || e.type || 'adjust';
    e.type = e.kind;
    if (e.at == null) e.at = e.ts;
    l.unshift(e);
    if (l.length > 500) l.length = 500;
    MallCore._save(KEYS.stockLog, l);
    return l[0];
  }
  // 把服务端返回的流水镜像到本地（在线模式库存真源在服务端，本地只做显示镜像）。
  // 幂等：同一条（有 id）不重复记；顺带把商品库存对齐成服务端的 after。
  function recordStockEntry(entry) {
    const e = entry || {};
    if (!e.code) throw new Error('流水缺少商品编码');
    if (e.after != null) {
      const list = MallCore.loadCatalog();
      const p = list.find(x => x.code === e.code);
      if (p) { p.stock = e.after; MallCore.saveCatalog(list); }
    }
    const l = getStockLog();
    if (e.id != null && l.some(x => x.id === e.id)) return l[0];
    const at = e.at || Date.now();
    return logStock(Object.assign({}, e, { at: at, ts: e.ts != null ? e.ts : at }));
  }

  // 改库存的公共步骤：校验 → 写 bd_products → 记流水
  function applyStockChange(code, delta, type, reason, by) {
    if (!delta || isNaN(delta)) throw new Error('变更数量无效');
    const products = MallCore.loadCatalog();
    const p = products.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    const before = p.stock;
    const after = before + delta;
    if (after < 0) throw new Error('库存不能为负（当前 ' + before + ' ' + p.unit + '）');
    p.stock = after;
    MallCore.saveCatalog(products);
    return logStock({ type: type, code: code, name: p.name, unit: p.unit, delta: delta, before: before, after: after, reason: reason || '', by: by || '店主' });
  }

  // 直接改数（D8：手动调整，可正可负）
  function adjustStock(code, delta, reason, by) {
    return applyStockChange(code, delta, 'adjust', reason, by);
  }
  // 入库单（增加库存；reason 记入库单号/供应商）
  function stockIn(code, qty, reason, by) {
    if (qty <= 0) throw new Error('入库数量必须为正数');
    return applyStockChange(code, qty, 'stock_in', reason, by);
  }
  // 盘点（以实盘数为准，差异自动入流水）
  function stockTake(code, counted, by) {
    if (isNaN(counted) || counted < 0) throw new Error('实盘数量无效');
    const products = MallCore.loadCatalog();
    const p = products.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    const delta = counted - p.stock;
    if (delta === 0) return logStock({ type: 'stock_take', code: code, name: p.name, unit: p.unit, delta: 0, before: p.stock, after: p.stock, reason: '盘点一致', by: by || '店主' });
    p.stock = counted;
    MallCore.saveCatalog(products);
    return logStock({ type: 'stock_take', code: code, name: p.name, unit: p.unit, delta: delta, before: p.stock - delta, after: p.stock, reason: '盘点调整', by: by || '店主' });
  }

  // ---------------- 订单管理（4 人配送雏形） ----------------
  // 给配送订单分配配送员：pending → delivering 并挂 courier；已配送/待自提可改派
  function setCourier(orderId, courier) {
    const roster = getCouriers();
    if (!roster.includes(courier)) throw new Error('配送员不在名单中：' + courier);
    let o = MallCore.getOrders().find(x => x.id === orderId);
    if (!o) throw new Error('订单不存在');
    if (o.deliveryType !== 'delivery') throw new Error('自提订单无需配送员');
    if (o.status === 'pending') MallCore.advanceOrder(orderId, 'delivering');
    const list = MallCore.getOrders();
    const o2 = list.find(x => x.id === orderId);
    o2.courier = courier;
    o2.deliveredAt = o2.deliveredAt || 0;
    MallCore._save(MallCore.KEYS.orders, list);
    return o2;
  }

  // ---------------- 顾客管理（私域雏形） ----------------
  // 由订单聚合：同手机号合并；叠加备注/标签/等级。
  // 等级（任务池⑦ / D24）＝顾客维度定价口径：retail 零售（默认）/ wholesale 批发 / vip 白名单。
  // 手机号就是身份（延续 D18，不做账号体系）；在线时等级真源在后端 customer.tier，
  // 这里把它同步进本地档案（mall_customers[phone].tier），页面渲染两条路都不变。
  const TIERS = [
    { v: 'retail', label: '零售' },
    { v: 'wholesale', label: '批发' },
    { v: 'vip', label: '白名单' }
  ];
  function tierLabel(tier) {
    const hit = TIERS.find(x => x.v === tier);
    return hit ? hit.label : '零售';
  }
  function validTier(tier) { return TIERS.some(x => x.v === tier); }

  function getCustomers() {
    const orders = MallCore.getOrders();
    const map = {};
    orders.forEach(o => {
      const key = (o.customer && o.customer.phone) || ('n:' + (o.customer && o.customer.name || ''));
      if (!map[key]) {
        map[key] = {
          name: (o.customer && o.customer.name) || '',
          phone: (o.customer && o.customer.phone) || '',
          address: (o.customer && o.customer.address) || '',
          orderCount: 0, totalSpent: 0, firstOrderAt: o.createdAt, lastOrderAt: o.createdAt
        };
      }
      const c = map[key];
      if (o.status !== 'cancelled') { c.orderCount++; c.totalSpent = Math.round((c.totalSpent + o.total) * 100) / 100; }
      c.firstOrderAt = Math.min(c.firstOrderAt, o.createdAt);
      c.lastOrderAt = Math.max(c.lastOrderAt, o.createdAt);
    });
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    const noteOf = n => ({ note: n.note || '', tag: n.tag || n.tags || '', tags: n.tags || n.tag || '', tier: n.tier || 'retail' });
    const list = Object.keys(map).map(k => {
      const c = map[k];
      const n = notes[c.phone] || {};
      return Object.assign({}, c, noteOf(n));
    });
    // 只登记过（等级 / 标签 / 备注）、还没下过单的顾客也要出现在档案里
    // （批发客户、熟客常是先登记手机号再拿货）
    Object.keys(notes).forEach(ph => {
      if (!ph || map[ph]) return;
      const n = notes[ph] || {};
      if ((!n.tier || n.tier === 'retail') && !n.tag && !n.tags && !n.note) return;
      list.push(Object.assign({
        name: n.name || '', phone: ph, address: '', orderCount: 0, totalSpent: 0,
        firstOrderAt: 0, lastOrderAt: 0
      }, noteOf(n)));
    });
    list.sort((a, b) => b.lastOrderAt - a.lastOrderAt);
    return list;
  }
  // 在线：把后端顾客档案（等级 / 姓名 / 标签 / 备注）拉回本地镜像（页面照旧读本地）
  async function refreshCustomers() {
    if (typeof SdyApi === 'undefined' || !SdyApi.on()) return getCustomers();
    const items = await SdyApi.listCustomers();
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    (items || []).forEach(c => {
      const ph = String(c.phone || '').trim();
      if (!ph) return;
      if (!notes[ph]) notes[ph] = {};
      notes[ph].tier = validTier(c.tier) ? c.tier : 'retail';
      if (c.name) notes[ph].name = String(c.name).trim();
      if (c.tags != null) { notes[ph].tags = String(c.tags); notes[ph].tag = String(c.tags); }
      if (c.note != null) notes[ph].note = String(c.note);
    });
    MallCore._save(KEYS.customerNotes, notes);
    return getCustomers();
  }
  // 设等级：在线走后端（真源），成功后同步本地；离线只改本地
  async function setTier(phone, name, tier) {
    const ph = String(phone == null ? '' : phone).trim();
    if (!ph) throw new Error('手机号不能为空');
    const t = String(tier || '').trim() || 'retail';
    if (!validTier(t)) throw new Error('顾客等级只能是 retail / wholesale / vip');
    if (typeof SdyApi !== 'undefined' && SdyApi.on()) await SdyApi.setCustomerTier(ph, name || '', t);
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    if (!notes[ph]) notes[ph] = {};
    notes[ph].tier = t;
    if (name) notes[ph].name = String(name).trim();
    MallCore._save(KEYS.customerNotes, notes);
    return notes[ph];
  }
  function setCustomerNote(phone, note, tag) {
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    if (!notes[phone]) notes[phone] = {};
    if (note !== undefined) notes[phone].note = note;
    if (tag !== undefined) { notes[phone].tag = tag; notes[phone].tags = tag; }
    MallCore._save(KEYS.customerNotes, notes);
    return notes[phone];
  }
  // 备注 / 标签（任务池⑧ / D25）：在线走后端（真源，换台设备也查得到），成功后同步本地；离线只改本地。
  async function saveCustomerNote(phone, name, tags, note) {
    const ph = String(phone == null ? '' : phone).trim();
    if (!ph) throw new Error('手机号不能为空');
    const t = String(tags == null ? '' : tags).trim();
    const nt = String(note == null ? '' : note).trim();
    if (t.length > 60) throw new Error('标签不能超过 60 字');
    if (nt.length > 200) throw new Error('备注不能超过 200 字');
    if (typeof SdyApi !== 'undefined' && SdyApi.on()) await SdyApi.setCustomerNote(ph, name || '', t, nt);
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    if (!notes[ph]) notes[ph] = {};
    notes[ph].tag = t; notes[ph].tags = t; notes[ph].note = nt;
    if (name) notes[ph].name = String(name).trim();
    MallCore._save(KEYS.customerNotes, notes);
    return notes[ph];
  }

  /* ---------------- 微信用户角色（任务池⑫ / D32） ----------------
   * 小程序登录会把每个微信号沉淀成一条用户记录（openid 是唯一身份，手机号可能没有）。
   * 老板在这里把某个微信号改成「员工」——员工登录小程序就能进工作台（管理端同权限）；
   * 改回「顾客」时服务端顺手清掉员工令牌（人撤了，那台手机上的工作台立刻进不去）。
   * 角色只有两种：customer 顾客（默认）/ staff 员工；未知取值一律按顾客显示。
   */
  const WX_ROLES = [
    { v: 'customer', label: '顾客' },
    { v: 'staff', label: '员工' }
  ];
  function validWxRole(role) { return WX_ROLES.some(x => x.v === role); }
  function roleLabel(role) {
    const hit = WX_ROLES.find(x => x.v === role);
    return hit ? hit.label : '顾客';                  // 未知角色按顾客显示
  }
  // 服务端字段 → 页面模型：缺字段给空串/默认值，渲染层永远不崩（纯函数，可单测）
  function normalizeWxUser(u) {
    const x = u || {};
    return {
      openid: String(x.openid == null ? '' : x.openid),
      unionid: String(x.unionid == null ? '' : x.unionid),
      phone: String(x.phone == null ? '' : x.phone),
      nickname: String(x.nickname == null ? '' : x.nickname),
      avatar: String(x.avatar == null ? '' : x.avatar),
      role: validWxRole(x.role) ? x.role : 'customer',
      createdAt: x.createdAt || '',
      updatedAt: x.updatedAt || '',
      lastLogin: x.lastLogin || ''
    };
  }
  // openid 有 28 位左右，列表里截断显示（全量放 title），后 4 位用于人工核对
  function shortOpenid(openid) {
    const s = String(openid == null ? '' : openid);
    return s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s;
  }
  function escHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }
  // 微信用户只存在服务端（本地演示没有），离线统一抛一句中文，由页面渲染成空状态
  async function listWxUsers(limit) {
    if (typeof SdyApi === 'undefined' || !SdyApi.on()) throw new Error('未连接后端，微信用户列表要连上服务器才能看');
    const n = Number(limit) > 0 ? Number(limit) : 200;
    const res = await SdyApi.req('GET', '/api/wx/users?limit=' + n);
    return ((res && res.items) || []).map(normalizeWxUser);
  }
  // 设角色（POST /api/wx/role）：customer ↔ staff。真源在服务端，改完必须重新拉列表
  async function setWxRole(openid, role) {
    const id = String(openid == null ? '' : openid).trim();
    if (!id) throw new Error('缺少 openid（让对方先用小程序登录一次）');
    const r = String(role == null ? '' : role).trim() || 'customer';
    if (!validWxRole(r)) throw new Error('角色只能是 customer / staff');
    if (typeof SdyApi === 'undefined' || !SdyApi.on()) throw new Error('未连接后端，无法修改角色');
    const res = await SdyApi.req('POST', '/api/wx/role', { openid: id, role: r });
    return res || { ok: true, openid: id, role: r };
  }
  // 头像：有 avatar 才渲染 <img>（加载失败自动 remove，露出下面的首字占位）
  function wxAvatarHTML(u) {
    const x = u || {};
    if (x.avatar) return '<img class="wxavatar" src="' + escHtml(x.avatar) + '" alt="" loading="lazy" onerror="this.remove()">';
    const ch = String(x.nickname || '').trim().slice(0, 1) || '👤';
    return '<span class="wxavatar wxavatar-ph">' + escHtml(ch) + '</span>';
  }
  // 用户列表（纯函数，返回 HTML 串；页面只负责塞进 #wxUserList）
  function renderWxUsers(users) {
    const list = Array.isArray(users) ? users : [];
    if (!list.length) return '<div class="empty"><span class="big">👥</span>还没有微信用户：让对方先用小程序登录一次，这里就会出现</div>';
    const rows = list.map(u => {
      const role = validWxRole(u.role) ? u.role : 'customer';
      const to = role === 'staff' ? 'customer' : 'staff';       // 按钮指向的相反角色
      const badge = role === 'staff'
        ? '<span class="badge st-done">员工</span>'
        : '<span class="badge">顾客</span>';
      const openid = String(u.openid || '');
      return '<tr>' +
        '<td><div class="pcell">' + wxAvatarHTML(u) + '</div></td>' +
        '<td><b>' + escHtml(u.nickname || '（未留昵称）') + '</b>' +
          '<div class="muted mono" style="font-size:11.5px" title="' + escHtml(openid) + '">' + escHtml(shortOpenid(openid)) + '</div></td>' +
        '<td>' + escHtml(u.phone || '—') + '</td>' +
        '<td>' + badge + '</td>' +
        '<td class="muted" style="font-size:12px">' + escHtml(u.lastLogin || '—') + '</td>' +
        '<td><button class="btn btn-xs' + (to === 'staff' ? ' btn-primary' : '') + '"' +
          ' onclick="wxToggleRole(\'' + escHtml(openid) + '\',\'' + to + '\')">' +
          (to === 'staff' ? '设为员工' : '设为顾客') + '</button></td>' +
        '</tr>';
    }).join('');
    return '<table class="table"><thead><tr>' +
      '<th style="width:52px">头像</th><th>昵称 / 微信号</th><th>手机号</th>' +
      '<th style="width:76px">角色</th><th>最后登录</th><th style="width:96px">操作</th>' +
      '</tr></thead><tbody>' + rows + '</tbody></table>';
  }

  // ---------------- 商品档案（建档 / 编辑 / 删除 · 任务池①） ----------------
  // 不变量：① 编辑表单不改库存（库存只走库存页）；② 删除要求库存为 0 且无进行中订单。
  const DEFAULT_UNIT = '件';
  const DEFAULT_CATEGORY = '未分类';
  const LOW_STOCK = 5;                                  // 低库存阈值（与总览口径一致）
  const CODE_RE = /^[0-9A-Za-z._-]{1,32}$/;
  const PRODUCT_EVENT = { new: 'product_new', edit: 'product_edit', del: 'product_del' };

  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

  // 表单 → 规范商品对象（纯函数；不合法直接抛错，错误文案可直接展示给店主）
  function normalizeProduct(input) {
    const src = input || {};
    const code = String(src.code == null ? '' : src.code).trim();
    if (!code) throw new Error('条码 / 货号不能为空');
    if (!CODE_RE.test(code)) throw new Error('条码 / 货号只能是 1–32 位数字、字母或 . _ -');
    const name = String(src.name == null ? '' : src.name).trim();
    if (!name) throw new Error('商品名称不能为空');
    if (name.length > 40) throw new Error('商品名称不要超过 40 个字');

    function num(v, label) {
      if (v === '' || v == null) return 0;
      const n = Number(v);
      if (isNaN(n) || !isFinite(n)) throw new Error(label + '必须是数字');
      if (n < 0) throw new Error(label + '不能为负数');
      return round2(n);
    }
    const salePrice = num(src.salePrice, '售价');
    if (salePrice <= 0) throw new Error('售价必须大于 0');
    const costPrice = num(src.costPrice, '进价');
    const refPrice = num(src.refPrice, '牵牛花参考价');
    // 批发价（任务池⑦ / D24）：0＝未设（批发客户也按零售价）；填了就不能高于零售价
    const wholesalePrice = num(src.wholesalePrice, '批发价');
    if (wholesalePrice > 0 && wholesalePrice > salePrice) {
      throw new Error('批发价 ' + wholesalePrice + ' 不能高于零售价 ' + salePrice);
    }
    const stock = num(src.stock, '初始库存');
    if (Math.abs(stock - Math.round(stock)) > 1e-9) throw new Error('初始库存要填整数（散装按最小单位计）');

    const product = {
      code: code, name: name,
      brand: String(src.brand || '').trim(),
      spec: String(src.spec || '').trim(),
      category: String(src.category || '').trim() || DEFAULT_CATEGORY,
      img: String(src.img || '').trim(),
      unit: String(src.unit || '').trim() || DEFAULT_UNIT,
      costPrice: costPrice, salePrice: salePrice, refPrice: refPrice,
      wholesalePrice: wholesalePrice,
      stock: Math.round(stock),
      isWholesale: !!(src.isWholesale || src.wholesale)
    };
    // 价格防线：复用 pricing.js（与后端 Go pricing.CheckRetailPrice 同一份规则）
    // 防线只管零售价；批发价是给特定顾客等级的价，不参与比价（D24 ⑤）
    const chk = PricingCore.checkRetailPrice(product);
    if (!chk.ok) throw new Error(chk.msg);
    return product;
  }

  // 不抛错版本，供表单即时校验：{ok, msg, product}
  function validateProduct(input) {
    try { return { ok: true, msg: '', product: normalizeProduct(input) }; }
    catch (e) { return { ok: false, msg: e.message, product: null }; }
  }

  // 商品档案事件流水（在线模式下页面写后端成功后也调用本函数，审计同口径）
  function logProductEvent(kind, product, opts) {
    const o = opts || {};
    const stock = o.stock != null ? o.stock : (product.stock || 0);
    const reason = o.reason || { new: '建档', edit: '编辑档案', del: '删除档案' }[kind] || '';
    return logStock({
      type: PRODUCT_EVENT[kind] || 'product_edit',
      code: product.code, name: product.name, unit: product.unit || DEFAULT_UNIT,
      delta: 0, before: stock, after: stock, reason: reason, by: o.by || '店主'
    });
  }

  // 建档 / 编辑（本地镜像路径）：先校验 → 写商品库 → 记流水；新建带初始库存时走入库流水
  function saveProduct(input, opts) {
    const o = opts || {};
    const product = normalizeProduct(input);
    const list = MallCore.loadCatalog();
    const idx = list.findIndex(x => x.code === product.code);
    const before = idx >= 0 ? list[idx] : null;
    if (before && o.requireNew) throw new Error('条码 ' + product.code + ' 已存在：' + before.name);

    if (before) {
      const saved = Object.assign({}, before, product, {
        stock: before.stock,                        // 编辑不改库存
        onSale: before.onSale !== false,            // 编辑不改上下架状态（D23）
        createdAt: before.createdAt || Date.now(),
        updatedAt: Date.now(),
        syncStatus: '待同步'
      });
      list[idx] = saved;
      MallCore.saveCatalog(list);
      logProductEvent('edit', saved, o);
    } else {
      // 注意 stock 必须放在最后：product 自身带 stock（初始库存），
      // 先落 0 再由 applyStockChange 走入库流水，避免「初始库存」被记两次。
      const saved = Object.assign({ createdAt: Date.now(), updatedAt: Date.now(), syncStatus: '待同步' }, product, { stock: 0 });
      list.push(saved);
      MallCore.saveCatalog(list);
      logProductEvent('new', saved, o);
      if (product.stock > 0) applyStockChange(product.code, product.stock, 'stock_in', '建档初始库存', o.by);
    }
    return MallCore.getProduct(product.code);
  }

  // 删除前置校验（离线与在线共用同一套提示，与后端 DELETE /api/products/{code} 同规则）
  function assertDeletable(code) {
    const list = MallCore.loadCatalog();
    const p = list.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    if (p.stock !== 0) {
      throw new Error('库存为 ' + p.stock + ' ' + (p.unit || DEFAULT_UNIT) + '，请先把库存盘点为 0 再删除');
    }
    const busy = MallCore.getOrders().filter(x =>
      x.status !== 'done' && x.status !== 'cancelled' &&
      (x.items || []).some(i => i.code === code));
    if (busy.length) throw new Error('有 ' + busy.length + ' 个进行中的订单包含该商品，不能删除');
    return p;
  }

  // 删除商品（本地镜像路径）
  function deleteProduct(code, by) {
    const p = assertDeletable(code);
    const list = MallCore.loadCatalog();
    list.splice(list.findIndex(x => x.code === code), 1);
    MallCore.saveCatalog(list);
    logProductEvent('del', p, { by: by, reason: '删除商品档案' });
    return p;
  }

  // 商品列表（关键词 / 分类 / 只看低库存）
  function listProducts(filter) {
    const f = filter || {};
    const kw = String(f.keyword || '').trim().toLowerCase();
    let list = MallCore.loadCatalog().slice();
    if (f.category) list = list.filter(p => (p.category || DEFAULT_CATEGORY) === f.category);
    if (kw) {
      list = list.filter(p => (p.name + ' ' + p.code + ' ' + (p.brand || '') + ' ' + (p.spec || '')).toLowerCase().indexOf(kw) >= 0);
    }
    if (f.lowOnly) list = list.filter(p => p.stock <= LOW_STOCK);
    list.sort((a, b) => ((a.category || '') + a.code).localeCompare((b.category || '') + b.code));
    return list;
  }
  function categories() {
    const seen = {};
    MallCore.loadCatalog().forEach(p => { seen[p.category || DEFAULT_CATEGORY] = 1; });
    return Object.keys(seen).sort();
  }
  function productStats() {
    const list = MallCore.loadCatalog();
    return {
      total: list.length,
      low: list.filter(p => p.stock <= LOW_STOCK).length,
      noRef: list.filter(p => !p.refPrice).length,
      pending: list.filter(p => p.syncStatus !== '已同步' && p.syncStatus !== 'synced').length
    };
  }
  // 编辑表单初值：商品对象 → 表单字段（表单不含库存）
  // 批发价必须原样带出来（E-P0-4）：弹窗读 d.wholesalePrice 回填，漏了这个字段
  // 编辑框永远空白，一保存就把批发价写成 0，批发客户直接按零售价买。
  function draftFrom(p) {
    const x = p || {};
    return {
      code: x.code || '', name: x.name || '', brand: x.brand || '', spec: x.spec || '',
      category: x.category || DEFAULT_CATEGORY, unit: x.unit || DEFAULT_UNIT, img: x.img || '',
      costPrice: x.costPrice || 0, salePrice: x.salePrice || 0, refPrice: x.refPrice || 0,
      wholesalePrice: x.wholesalePrice || 0,
      isWholesale: !!(x.isWholesale || x.wholesale)
    };
  }

  /* ---------------- 批量改价 / 批量操作（任务池第 5 项，决策 D20） ----------------
   * 约定：批量改价 = 对选中的商品逐款套用同一条规则，**必须过比价防线**
   *      （与单款建档共用 `pricing.checkRetailPrice`，批发商品按配置豁免）；
   *      超线不静默写入：标红并给出「防线顶格价」（参考价 × 0.95），店主可一键采用；
   *      每一款改动都写一条商品事件流水（product_edit，reason 记下规则原文），可追溯到人与时间；
   *      批量只改售价 / 分类 / 批发标记，**绝不动库存**（与 D16「编辑不改库存」同源）。
   */
  const BULK_MODES = [['pct', '按比例 %'], ['delta', '按金额 ±元'], ['set', '统一设为元']];
  const BULK_ROUNDS = [[0.01, '不取整（到分）'], [0.1, '到 1 角'], [0.5, '到 5 角'], [1, '到 1 元']];
  const BULK_FIELDS = { category: '分类', isWholesale: '批发标记' };

  // 四舍五入到步长（step = 0.01 即到分）
  function roundStep(n, step) {
    const s = Number(step) || 0.01;
    return round2(Math.round((Number(n) || 0) / s) * s);
  }

  // 单款新售价（纯函数）：rule = {mode:'pct'|'delta'|'set', value, step}
  function bulkNewPrice(p, rule) {
    const r = rule || {};
    const base = Number(p && p.salePrice) || 0;
    const v = Number(r.value) || 0;
    let n;
    if (r.mode === 'pct') n = base * (1 + v / 100);
    else if (r.mode === 'delta') n = base + v;
    else if (r.mode === 'set') n = v;
    else throw new Error('未知的调整方式：' + r.mode);
    return roundStep(n, r.step);
  }

  // 规则的人话描述（写进流水 reason，日后能查出「哪次批量改的」）
  function ruleLabel(rule) {
    const r = rule || {};
    if (r.mode !== 'pct' && r.mode !== 'delta' && r.mode !== 'set') return '批量改价';
    const v = Number(r.value) || 0;
    const step = Number(r.step) || 0.01;
    const tail = step > 0.01 ? ('，取整到 ' + step + ' 元') : '';
    if (r.mode === 'pct') return '批量改价：' + (v >= 0 ? '+' : '') + v + '%' + tail;
    if (r.mode === 'delta') return '批量改价：' + (v >= 0 ? '+' : '') + v + ' 元' + tail;
    return '批量改价：统一 ' + v + ' 元' + tail;
  }

  // 预览（纯函数，不写数据）：逐款算新价并过防线
  // status：change 可改 / same 价格未变 / capped 超防线（给出顶格价）/ blocked 非法（如 ≤ 0）
  function bulkPlan(list, rule, opts) {
    const o = opts || {};
    const useCaps = o.useCaps || {};
    return (list || []).map(p => {
      const row = {
        code: p.code, name: p.name, unit: p.unit || DEFAULT_UNIT, isWholesale: !!(p.isWholesale || p.wholesale),
        oldPrice: round2(Number(p.salePrice) || 0), newPrice: 0, delta: 0,
        status: 'change', msg: '', cap: 0
      };
      try { row.newPrice = bulkNewPrice(p, rule); }
      catch (e) { row.status = 'blocked'; row.msg = e.message; return row; }

      if (!(row.newPrice > 0)) {
        row.status = 'blocked'; row.msg = '新售价必须大于 0';
      } else if (row.newPrice === row.oldPrice) {
        row.status = 'same'; row.msg = '价格未变';
      } else {
        const chk = PricingCore.checkRetailPrice(Object.assign({}, p, { salePrice: row.newPrice }));
        if (chk.ok) {
          row.msg = chk.skip ? (row.isWholesale ? '批发商品，跳过比价检查（+ 仍会记流水）' : '缺牵牛花参考价，跳过比价检查') : '合规';
        } else {
          row.cap = round2((Number(p.refPrice) || 0) * 0.95);
          if (row.cap > 0 && row.cap !== row.oldPrice && useCaps[p.code]) {
            row.newPrice = row.cap; row.msg = '已按防线顶格 ' + row.cap.toFixed(2);
          } else if (row.cap > 0 && row.cap !== row.oldPrice) {
            row.status = 'capped'; row.msg = chk.msg;
          } else {
            row.status = 'blocked'; row.newPrice = 0; row.msg = '超防线且没有可用的合规价（缺参考价或顶格价与现价相同）';
          }
        }
      }
      row.delta = round2(row.newPrice - row.oldPrice);
      return row;
    });
  }

  function bulkSummary(rows) {
    const s = { total: 0, change: 0, same: 0, capped: 0, blocked: 0, up: 0, down: 0 };
    (rows || []).forEach(r => {
      s.total++;
      s[r.status] = (s[r.status] || 0) + 1;
      if (r.status === 'change') { if (r.delta > 0) s.up++; else if (r.delta < 0) s.down++; }
    });
    return s;
  }

  // 落盘（本地镜像路径）：只写 status=change 的行，逐款 try/catch，不因一款失败中断整批。
  // 注意：写入时**重新读当前商品**（预览用的是快照），避免上一批写完后用旧对象把分类等字段覆盖回去；
  // 库存、分类、批发标记等未被批量规则涉及的字段一律保持原值（D16：编辑不改库存）。
  function applyBulkPlan(rows, opts) {
    const o = opts || {};
    const out = { changed: 0, skipped: 0, noop: 0, failed: [], rows: [] };
    const reason = o.reason || ruleLabel(o.rule);
    (rows || []).forEach(row => {
      if (row.status !== 'change') { out.skipped++; return; }
      let p = null;
      try { p = MallCore.getProduct(row.code); } catch (e) { p = null; }
      if (!p) { out.failed.push({ code: row.code, name: row.name, msg: '商品不存在' }); return; }
      const before = round2(Number(p.salePrice) || 0);
      if (before === round2(row.newPrice)) { out.skipped++; out.noop++; return; }  // 预览快照过期：现价已等于目标价，跳过不写流水
      try {
        saveProduct(Object.assign({}, p, { salePrice: row.newPrice }), { by: o.by, reason: reason });
        out.changed++;
        out.rows.push({ code: row.code, name: p.name, before: before, after: round2(row.newPrice) });
      } catch (e) {
        out.failed.push({ code: row.code, name: row.name, msg: e.message });
      }
    });
    return out;
  }

  // 批量改分类 / 批发标记（同样逐款重读 + 写流水；分类名做非空与长度校验）
  function applyBulkField(codes, field, value, opts) {
    if (!BULK_FIELDS[field]) throw new Error('不支持的批量字段：' + field);
    if (field === 'category') {
      const v = String(value == null ? '' : value).trim();
      if (!v) throw new Error('分类不能为空');
      if (v.length > 12) throw new Error('分类名不要超过 12 个字');
      value = v;
    } else {
      value = !!value;
    }
    const out = { changed: 0, failed: [] };
    (codes || []).forEach(code => {
      let p = null;
      try { p = MallCore.getProduct(code); } catch (e) { p = null; }
      if (!p) { out.failed.push({ code: code, msg: '商品不存在' }); return; }
      // 取消批发 = 把商品交回比价防线：售价已经超线的必须先改价，绝不静默改价
      if (field === 'isWholesale' && value === false) {
        const chk = PricingCore.checkRetailPrice(Object.assign({}, p, { isWholesale: false, wholesale: false }));
        if (!chk.ok) { out.failed.push({ code: code, name: p.name, msg: '取消批发后' + chk.msg }); return; }
      }
      try {
        const patch = {};
        patch[field] = value;
        saveProduct(Object.assign({}, p, patch), {
          by: (opts || {}).by,
          reason: '批量改' + BULK_FIELDS[field] + '：' + (field === 'isWholesale' ? (value ? '设为批发' : '取消批发') : value)
        });
        out.changed++;
      } catch (e) {
        out.failed.push({ code: code, name: p.name, msg: e.message });
      }
    });
    return out;
  }

  /* ---------------- 数据来源 / 示例商品 / 营业额口径 / 新订单（第 27 轮） ----------------
   * 这一组都是纯函数或纯状态，不碰 DOM，页面与 Node 测试共用同一套判断。
   * 背景（E-P0-1 / E-P0-3 / E-P0-7）：后台以前分不清「后端连上了但真的没有数据」
   * 与「压根没连过后端」，于是空响应被静默换成本地演示值；营业额也把没收到的钱算进来了。
   */

  // 示例（种子）商品识别：后端本轮若给商品加 is_demo / SEED_DEMO 标识，这里就能认出来。
  // 三种写法都兼容（布尔 / 1 / 字符串 '1'），字段缺失一律当正式商品，避免误标。
  function isDemoProduct(p) {
    const x = p || {};
    return !!(x.isDemo || x.is_demo || x.SEED_DEMO);
  }
  function demoCount(list) {
    return (Array.isArray(list) ? list : []).filter(isDemoProduct).length;
  }

  // 今日营业额口径（E-P0-7）：本业务没有在线支付，**下单 ≠ 收款**，
  // 所以「营业额」只算已完成（done）的实收；待备货 / 配送中 / 待自提另列「进行中金额」。
  // 已取消订单两边都不算（与报表页 doneAmount / openAmount 同口径）。
  function kpiOf(orders, now) {
    const d = now ? new Date(now) : new Date();
    const today = d.toDateString();
    const todays = (Array.isArray(orders) ? orders : []).filter(o => new Date(o.createdAt).toDateString() === today);
    const valid = todays.filter(o => o.status !== 'cancelled');
    const done = valid.filter(o => o.status === 'done');
    const open = valid.filter(o => o.status !== 'done');
    const sum = arr => round2(arr.reduce((s, o) => s + (Number(o.total) || 0), 0));
    return {
      today: todays.length,               // 今日下单总数（含取消，页面脚注会说明）
      valid: valid.length,                // 非取消单量
      done: done.length,                  // 已完成单量
      doneAmount: sum(done),              // 已完成金额 = 今日营业额（实收）
      open: open.length,                  // 进行中单量（待备货 / 配送中 / 待自提）
      openAmount: sum(open),              // 进行中金额（尚未收到）
      cancelled: todays.length - valid.length
    };
  }

  /* 新订单提醒（第 27 轮，轻量轮询用）：
   * 订单镜像按时间倒序，新单一定排在最前，所以「最新下单时间」就是最省事的签名。
   * 只比签名，命中后再按 id 找新单，避免整表 diff。                                */
  function orderSig(orders) {
    let max = 0;
    (Array.isArray(orders) ? orders : []).forEach(o => {
      const t = Number(o && o.createdAt) || 0;
      if (t > max) max = t;
    });
    return String(max);
  }
  function newOrdersSince(orders, since, prevSig) {
    const list = Array.isArray(orders) ? orders : [];
    const t = Number(since) || 0;
    const cut = prevSig == null ? '' : String(prevSig);
    return list.filter(o => (Number(o && o.createdAt) || 0) > t && String(o.id) !== cut);
  }

  /* ---------------- 小票 / 配送单（任务池第 2 项） ----------------
   * 约定：小票是订单的**只读投影** —— 只读订单与门店抬头，不改订单、不改库存、不改价格
   *      （与 D8「扫码只读」同源）；金额一律两位小数，件数按 qty 求和。
   */
  const DEFAULT_STORE = { name: '家庭超市', phone: '', address: '', footer: '谢谢惠顾，欢迎再来！' };

  function getStoreInfo() {
    const s = MallCore._load(KEYS.store, null);
    if (!s || typeof s !== 'object') return Object.assign({}, DEFAULT_STORE);
    return Object.assign({}, DEFAULT_STORE, s);
  }
  // 门店抬头（小票表头）：只允许改这四项
  function setStoreInfo(info) {
    const i = info || {};
    const name = String(i.name == null ? '' : i.name).trim();
    if (!name) throw new Error('请填写店名');
    if (name.length > 20) throw new Error('店名不能超过 20 字');
    const out = {
      name: name,
      phone: String(i.phone == null ? '' : i.phone).trim(),
      address: String(i.address == null ? '' : i.address).trim(),
      footer: String(i.footer == null ? '' : i.footer).trim() || DEFAULT_STORE.footer
    };
    MallCore._save(KEYS.store, out);
    return out;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function formatTime(ts) {
    const d = new Date(Number(ts) || 0);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
      ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }

  // 订单 → 小票模型（纯函数，可直接单测）；store 缺省用 DEFAULT_STORE
  function buildReceipt(order, opts) {
    const o = order || {};
    if (!o.id) throw new Error('订单不存在，无法打印小票');
    const store = Object.assign({}, DEFAULT_STORE, (opts && opts.store) || {});
    const items = (o.items || []).map(it => {
      const price = round2(it.price), qty = Number(it.qty) || 0;
      return { name: it.name || '', spec: it.spec || '', unit: it.unit || DEFAULT_UNIT, price: price, qty: qty, amount: round2(price * qty) };
    });
    const subtotal = round2(o.subtotal != null ? o.subtotal : items.reduce((s, i) => s + i.amount, 0));
    const deliveryFee = round2(o.deliveryFee || 0);
    const total = round2(o.total != null ? o.total : subtotal + deliveryFee);
    const view = MallCore.orderView ? MallCore.orderView(o) : { statusLabel: o.status || '' };
    const isPickup = o.deliveryType === 'pickup';
    const r = {
      storeName: store.name, storePhone: store.phone, storeAddress: store.address,
      title: isPickup ? '自提小票' : '配送小票',
      isPickup: isPickup, cancelled: o.status === 'cancelled',
      orderNo: String(o.id), time: formatTime(o.createdAt), statusLabel: view.statusLabel,
      courier: o.courier || '',
      customer: {
        name: (o.customer && o.customer.name) || '',
        phone: (o.customer && o.customer.phone) || '',
        address: (o.customer && o.customer.address) || ''
      },
      items: items, count: items.reduce((n, i) => n + i.qty, 0),
      subtotal: subtotal, deliveryFee: deliveryFee, total: total,
      footer: store.footer || DEFAULT_STORE.footer
    };
    r.text = receiptText(r);
    return r;
  }

  // 32 字宽纯文本小票（热敏打印机 / 复制粘贴给骑手用）
  function receiptText(r) {
    const line = '--------------------------------';
    const L = [r.storeName, '（' + r.title + '）'];
    if (r.storePhone) L.push('电话：' + r.storePhone);
    if (r.storeAddress) L.push('地址：' + r.storeAddress);
    L.push(line);
    L.push('单号：' + r.orderNo);
    L.push('时间：' + r.time);
    L.push('状态：' + r.statusLabel + (r.cancelled ? '（作废）' : ''));
    L.push('顾客：' + r.customer.name + ' ' + r.customer.phone);
    if (!r.isPickup && r.customer.address) L.push('地址：' + r.customer.address);
    L.push(r.isPickup ? '方式：到店自提' : '方式：配送到家' + (r.courier ? ' · ' + r.courier : ''));
    L.push(line);
    r.items.forEach(i => {
      L.push(i.name + (i.spec ? ' ' + i.spec : ''));
      L.push('  ¥' + i.price.toFixed(2) + ' × ' + i.qty + ' ' + i.unit + ' = ¥' + i.amount.toFixed(2));
    });
    L.push(line);
    L.push('合计 ' + r.count + ' 件');
    L.push('小计：¥' + r.subtotal.toFixed(2));
    if (r.deliveryFee) L.push('配送费：¥' + r.deliveryFee.toFixed(2));
    L.push('应收：¥' + r.total.toFixed(2));
    L.push(line);
    if (r.footer) L.push(r.footer);
    return L.join('\n');
  }

  /* ---------------- 销售报表 / 日报（D19） ----------------
   * 口径（D19）：只统计非取消订单；营业额按「下单口径」（含未完成），另拆已完成/进行中；
   * 商品金额取各单 subtotal（不含配送费）；客单价 = 营业额 / 单量；
   * 时间按本机时区的自然日切分，区间含首尾两天、零单日也占一格（图表横轴连续）；
   * 纯函数、数据源是订单镜像 —— 不新增后端接口、离线也能出报表。            */

  const REPORT_RANGES = [
    ['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'],
    ['30d', '近 30 天'], ['month', '本月'], ['all', '全部']
  ];

  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function shiftDay(d, n) { const x = startOfDay(d); x.setDate(x.getDate() + n); return x; }
  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function numOf(v) { const n = Number(v); return isNaN(n) ? 0 : n; }
  function sumOf(arr, f) { return round2(arr.reduce((s, o) => s + numOf(f(o)), 0)); }

  // 区间 → 连续自然日列表（「全部」以最早一单那天为起点，没有订单就是今天）
  function rangeOf(key, now, orders) {
    const today = startOfDay(now || new Date());
    let label = '今天', days = [];
    if (key === 'yesterday') { label = '昨天'; days = [shiftDay(today, -1)]; }
    else if (key === '7d') { label = '近 7 天'; for (let i = 6; i >= 0; i--) days.push(shiftDay(today, -i)); }
    else if (key === '30d') { label = '近 30 天'; for (let i = 29; i >= 0; i--) days.push(shiftDay(today, -i)); }
    else if (key === 'month') {
      label = '本月';
      for (let d = new Date(today.getFullYear(), today.getMonth(), 1); d <= today; d = shiftDay(d, 1)) days.push(d);
    } else if (key === 'all') {
      label = '全部';
      let min = today;
      (Array.isArray(orders) ? orders : []).forEach(o => {
        const d = startOfDay(o.createdAt);
        if (!isNaN(d.getTime()) && d < min) min = d;
      });
      for (let d = min; d <= today; d = shiftDay(d, 1)) days.push(d);
    } else { key = 'today'; days = [today]; }
    const keys = days.map(dayKey);
    return { key: key, label: label, days: keys, from: keys[0], to: keys[keys.length - 1], count: keys.length };
  }

  /* ---------------- 订单筛选：参数拼装 / 本地兜底（第 28 轮 7.5、7.8） ----------------
   * 纯函数，供后台筛选条与 CSV 导出共用**同一个** filter 对象：只要两处都走
   * orderFilterQuery()，就不可能出现「列表筛了、导出没筛」的口径分叉。
   * 约定（与 /api/orders、/api/orders/export.csv 逐字一致）：
   *   q 顾客名/手机号/订单号模糊 · status 逗号分隔多值或单个 · date 本地日 YYYY-MM-DD
   *   from/to 含端点的区间（date 优先于 from/to）· type pickup|delivery
   * **filter 里绝不出现 phone**：身份照第 27 轮规则（管理员 > 员工 > openid > phone > 400），
   * 筛选参数一律不参与身份判定；phone 由 sync() 的身份通道单独携带。
   */
  const ORDER_STATUSES = ['pending', 'delivering', 'ready', 'done', 'cancelled'];
  const ORDER_DATE_PRESETS = [['today', '今天'], ['7d', '近 7 天'], ['custom', '自定义']];

  function dayStart(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function dayEnd(d) { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; }
  // 日期入参一律当**本地日**解析（YYYY-MM-DD 直接 new Date() 会被当 UTC，东八区会差一天）
  function parseDay(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s == null ? '' : s).trim());
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return isNaN(d.getTime()) ? null : d;
  }
  function addDays(d, n) { const x = dayStart(d); x.setDate(x.getDate() + n); return x; }
  function dayStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  // 日期选择 → {date} 或 {from,to}；自定义填半截就只带半截（服务端按开区间处理）。
  // 'none'（全部时间）= 不带任何日期参数（默认不出现；只有老板显式选「全部时间」才有）。
  function orderDateRange(preset, from, to, now) {
    const base = now ? new Date(now) : new Date();
    if (preset === 'none') return {};
    if (preset === 'custom') {
      const o = {};
      const a = (from == null ? '' : String(from)).trim();
      const b = (to == null ? '' : String(to)).trim();
      if (a) o.from = a;
      if (b) o.to = b;
      return o;
    }
    if (preset === '7d') return { from: dayStr(addDays(base, -6)), to: dayStr(base) };
    return { date: dayStr(base) };   // today（默认）
  }

  // 下拉/输入 → 查询串。phone 在实现里根本没有出现的机会（第 28 条验收：phone 不被筛选覆盖）
  function orderFilterQuery(input) {
    const i = input || {};
    const out = {};
    const q = (i.q == null ? '' : String(i.q)).trim();
    if (q) out.q = q;
    const st = (i.status == null ? '' : String(i.status)).trim();
    if (st && st !== 'all') out.status = st;
    if (i.type && i.type !== 'all') out.type = i.type;
    const dr = orderDateRange(i.date, i.from, i.to, i.now);
    Object.keys(dr).forEach(k => { const v = dr[k]; if (v != null && v !== '') out[k] = v; });
    return out;
  }
  function hasOrderFilter(f) {
    const x = f || {};
    return !!(x.q || x.status || x.date || x.from || x.to || x.type);
  }
  // 本地兜底：后端筛选已生效时它是幂等重算；后端未就绪时页面照样能筛，绝不假装筛过
  function filterOrders(list, input) {
    const i = input || {};
    const q = (i.q == null ? '' : String(i.q)).trim().toLowerCase();
    const status = (i.status == null ? '' : String(i.status)).trim();
    const want = (status && status !== 'all') ? status.split(',').map(s => s.trim()).filter(Boolean) : null;
    const dstr = (i.date == null ? '' : String(i.date)).trim();
    const day0 = parseDay(dstr);
    const lo = day0 ? dayStart(day0) : (parseDay(i.from) ? dayStart(parseDay(i.from)) : null);
    const hiD = day0 || parseDay(i.to);
    const hi = hiD ? dayEnd(hiD) : null;
    const type = i.type && i.type !== 'all' ? i.type : null;
    return (Array.isArray(list) ? list : []).filter(o => {
      if (!o) return false;
      const c = o.customer || {};
      if (q) {
        const hay = ((c.name || '') + ' ' + (c.phone || '') + ' ' + (o.id || '')).toLowerCase();
        if (hay.indexOf(q) < 0) return false;
      }
      if (want && want.indexOf(o.status) < 0) return false;
      if (type && o.deliveryType !== type) return false;
      if (lo || hi) {
        const t = new Date(o.createdAt).getTime();
        if (isNaN(t)) return false;
        if (lo && t < lo.getTime()) return false;
        if (hi && t > hi.getTime()) return false;
      }
      return true;
    });
  }

  // ============ 第 28 轮 7.5 / 7.8：订单筛选同步 ============
  // 筛选请求统一走这里（页面不再自己拼 sync），关键约定：
  //   · 筛选结果**只用于本次渲染**，绝不写回订单镜像 —— 镜像始终是全店全量订单，
  //     否则 renderDash() 的「当前待处理（不限日期）」「今日营业额」会被日期筛选悄悄截断。
  //   · 后端 filter 未就绪时 sync 原样回全量，这里本地再筛一遍兜底（幂等，后端支持后无副作用）。
  //   · 导出必须与列表同口径，所以返回的就是列表此刻看到的那一批。
  function syncOrders(filter, api) {
    const f = filter || {};
    const call = api || (typeof SdyApi !== 'undefined' ? SdyApi : null);
    const before = MallCore.getOrders();
    if (!call || typeof call.sync !== 'function') {
      return Promise.resolve(hasOrderFilter(f) ? filterOrders(before, f) : before);
    }
    return Promise.resolve()
      .then(function () { return call.sync(null, { all: true, filter: f }); })
      .catch(function () { return null; })   // 拉不到：用现有全量镜像 + 本地筛选兜底
      .then(function () {
        const after = MallCore.getOrders();
        const backendFiltered = after.length !== before.length;
        if (backendFiltered) return after;               // 后端已经筛过
        return hasOrderFilter(f) ? filterOrders(after, f) : after;
      });
  }

  function aggregate(list, range) {
    const inSet = {};
    range.days.forEach(d => { inSet[d] = 1; });
    const inRange = list.filter(o => inSet[dayKey(o.createdAt)]);
    const valid = inRange.filter(o => o.status !== 'cancelled');

    const byStatus = { pending: 0, delivering: 0, ready: 0, done: 0, cancelled: 0 };
    inRange.forEach(o => { if (byStatus[o.status] != null) byStatus[o.status]++; });

    const revenue = sumOf(valid, o => o.total);
    const goods = sumOf(valid, o => o.subtotal);
    const deliveryFee = sumOf(valid, o => o.deliveryFee);
    const count = valid.length;
    const doneAmount = sumOf(valid.filter(o => o.status === 'done'), o => o.total);

    let items = 0;
    const agg = {};
    valid.forEach(o => (o.items || []).forEach(i => {
      const qty = numOf(i.qty);
      items += qty;
      const k = String(i.code || i.name || '');
      const a = agg[k] || (agg[k] = { code: i.code || '', name: i.name || '', spec: i.spec || '', unit: i.unit || '', qty: 0, amount: 0 });
      a.qty += qty;
      a.amount = round2(a.amount + numOf(i.price) * qty);
    }));
    const top = Object.keys(agg).map(k => agg[k])
      .sort((a, b) => b.qty - a.qty || b.amount - a.amount)
      .slice(0, 8)
      .map(a => Object.assign({}, a, { pct: items ? Math.round(a.qty / items * 1000) / 10 : 0 }));

    const daily = range.days.map(dk => {
      const all = inRange.filter(o => dayKey(o.createdAt) === dk);
      const ok = all.filter(o => o.status !== 'cancelled');
      return { date: dk, label: dk.slice(5), count: ok.length, revenue: sumOf(ok, o => o.total), cancelled: all.length - ok.length };
    });

    const byType = t => {
      const g = valid.filter(o => (o.deliveryType || 'pickup') === t);
      return { count: g.length, amount: sumOf(g, o => o.total) };
    };

    return {
      range: range, count: count, revenue: revenue, goods: goods, deliveryFee: deliveryFee,
      avgOrder: count ? round2(revenue / count) : 0,
      items: items, skuCount: Object.keys(agg).length,
      doneAmount: doneAmount, openAmount: round2(revenue - doneAmount),
      byStatus: byStatus, top: top, daily: daily,
      pickup: byType('pickup'), delivery: byType('delivery'),
      maxDaily: daily.reduce((m, d) => Math.max(m, d.revenue), 0)
    };
  }

  function pctOf(now, prev) { return prev > 0 ? Math.round((now - prev) / prev * 1000) / 10 : null; }

  // 报表主函数：orders 传 Mall.getOrders()，now 可注入（测试用）
  function buildReport(orders, key, now) {
    const list = Array.isArray(orders) ? orders : [];
    const range = rangeOf(key, now, list);
    const r = aggregate(list, range);
    r.now = (now ? new Date(now) : new Date()).getTime();
    if (range.key !== 'all') {                       // 等长的上一个区间 → 环比
      const prevDays = [];
      for (let i = range.count; i >= 1; i--) prevDays.push(dayKey(shiftDay(new Date(range.from + 'T00:00:00'), -i)));
      const p = aggregate(list, { days: prevDays, from: prevDays[0], to: prevDays[prevDays.length - 1], count: prevDays.length, label: '上一区间' });
      r.prev = { revenue: p.revenue, count: p.count, avgOrder: p.avgOrder };
      r.delta = { revenue: pctOf(r.revenue, p.revenue), count: pctOf(r.count, p.count), avgOrder: pctOf(r.avgOrder, p.avgOrder) };
    }
    return r;
  }

  function pctText(v) { return v == null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%'; }

  // 32 字宽纯文本日报（复制到微信 / 打印用）
  function reportText(r, opts) {
    const o = opts || {};
    const store = o.store || getStoreInfo();
    const line = '--------------------------------';
    const L = [(store.name || DEFAULT_STORE.name) + ' · 销售日报'];
    L.push(r.range.label + '（' + r.range.from + (r.range.count > 1 ? ' 至 ' + r.range.to : '') + '）');
    L.push(line);
    L.push('单量：' + r.count + ' 单' + (r.byStatus.cancelled ? '（另有取消 ' + r.byStatus.cancelled + ' 单）' : ''));
    L.push('营业额：¥' + r.revenue.toFixed(2) + '（下单口径，不含取消）');
    L.push('客单价：¥' + r.avgOrder.toFixed(2));
    L.push('商品金额：¥' + r.goods.toFixed(2) + ' · 配送费：¥' + r.deliveryFee.toFixed(2));
    L.push('已完成：¥' + r.doneAmount.toFixed(2) + ' · 进行中：¥' + r.openAmount.toFixed(2));
    L.push('自提 ' + r.pickup.count + ' 单 · 配送 ' + r.delivery.count + ' 单');
    L.push('未完成：待备货 ' + r.byStatus.pending + ' · 配送中 ' + r.byStatus.delivering + ' · 待自提 ' + r.byStatus.ready);
    if (r.delta) L.push('环比：营业额 ' + pctText(r.delta.revenue) + ' · 单量 ' + pctText(r.delta.count));
    if (r.top.length) {
      L.push(line);
      L.push('热销 TOP ' + Math.min(5, r.top.length));
      r.top.slice(0, 5).forEach((t, i) => {
        L.push((i + 1) + '. ' + t.name + (t.spec ? ' ' + t.spec : ''));
        L.push('   ' + t.qty + ' ' + (t.unit || '件') + ' · ¥' + t.amount.toFixed(2) + ' · 占 ' + t.pct + '%');
      });
    }
    L.push(line);
    L.push('生成时间：' + formatTime(o.now || r.now || Date.now()));
    return L.join('\n');
  }

  return {
    KEYS: KEYS,
    DEFAULT_COURIERS: DEFAULT_COURIERS,
    DEFAULT_STORE: DEFAULT_STORE,
    DEFAULT_UNIT: DEFAULT_UNIT,
    DEFAULT_CATEGORY: DEFAULT_CATEGORY,
    LOW_STOCK: LOW_STOCK,
    normalizeProduct: normalizeProduct,
    validateProduct: validateProduct,
    logProductEvent: logProductEvent,
    saveProduct: saveProduct,
    assertDeletable: assertDeletable,
    deleteProduct: deleteProduct,
    listProducts: listProducts,
    categories: categories,
    productStats: productStats,
    draftFrom: draftFrom,
    round2: round2,
    isDemoProduct: isDemoProduct,
    demoCount: demoCount,
    kpiOf: kpiOf,
    orderSig: orderSig,
    newOrdersSince: newOrdersSince,
    BULK_MODES: BULK_MODES,
    BULK_ROUNDS: BULK_ROUNDS,
    BULK_FIELDS: BULK_FIELDS,
    roundStep: roundStep,
    bulkNewPrice: bulkNewPrice,
    ruleLabel: ruleLabel,
    bulkPlan: bulkPlan,
    bulkSummary: bulkSummary,
    applyBulkPlan: applyBulkPlan,
    applyBulkField: applyBulkField,
    getCouriers: getCouriers,
    setCouriers: setCouriers,
    getStockLog: getStockLog,
    adjustStock: adjustStock,
    stockIn: stockIn,
    stockTake: stockTake,
    setCourier: setCourier,
    getStoreInfo: getStoreInfo,
    setStoreInfo: setStoreInfo,
    buildReceipt: buildReceipt,
    formatTime: formatTime,
    REPORT_RANGES: REPORT_RANGES,
    rangeOf: rangeOf,
    dayKey: dayKey,
    syncOrders: syncOrders,
    ORDER_STATUSES: ORDER_STATUSES,
    ORDER_DATE_PRESETS: ORDER_DATE_PRESETS,
    orderDateRange: orderDateRange,
    orderFilterQuery: orderFilterQuery,
    hasOrderFilter: hasOrderFilter,
    filterOrders: filterOrders,
    buildReport: buildReport,
    reportText: reportText,
    getCustomers: getCustomers,
    setCustomerNote: setCustomerNote,
    TIERS: TIERS,
    tierLabel: tierLabel,
    validTier: validTier,
    refreshCustomers: refreshCustomers,
    setTier: setTier,
    saveCustomerNote: saveCustomerNote,
    WX_ROLES: WX_ROLES,
    validWxRole: validWxRole,
    roleLabel: roleLabel,
    normalizeWxUser: normalizeWxUser,
    shortOpenid: shortOpenid,
    listWxUsers: listWxUsers,
    setWxRole: setWxRole,
    renderWxUsers: renderWxUsers,
    saveCourier: saveCourier,
    recordStockEntry: recordStockEntry
  };
})();

// 顶层 const 不会成为 window 的属性，而 sdy-api.js 的 resolveAdmin() 需要拿到它做本地镜像：
// 显式挂到 window 上（Node 测试里 typeof window === 'undefined'，不受影响）。
if (typeof window !== 'undefined') window.Admin = Admin;

if (typeof module !== 'undefined' && module.exports) module.exports = Admin;

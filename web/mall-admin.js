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

  // ---------------- 库存流水 ----------------
  function getStockLog() {
    const l = MallCore._load(KEYS.stockLog, []);
    return Array.isArray(l) ? l : [];
  }
  function logStock(entry) {
    const l = getStockLog();
    l.unshift(Object.assign({ ts: Date.now() }, entry));
    if (l.length > 500) l.length = 500;
    MallCore._save(KEYS.stockLog, l);
    return l[0];
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
  // 由订单聚合：同手机号合并；叠加备注/标签
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
    const list = Object.keys(map).map(k => {
      const c = map[k];
      const n = notes[c.phone] || {};
      return Object.assign({}, c, { note: n.note || '', tag: n.tag || '' });
    });
    list.sort((a, b) => b.lastOrderAt - a.lastOrderAt);
    return list;
  }
  function setCustomerNote(phone, note, tag) {
    const notes = MallCore._load(KEYS.customerNotes, {}) || {};
    if (!notes[phone]) notes[phone] = {};
    if (note !== undefined) notes[phone].note = note;
    if (tag !== undefined) notes[phone].tag = tag;
    MallCore._save(KEYS.customerNotes, notes);
    return notes[phone];
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
      stock: Math.round(stock),
      isWholesale: !!(src.isWholesale || src.wholesale)
    };
    // 价格防线：复用 pricing.js（与后端 Go pricing.CheckRetailPrice 同一份规则）
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
  function draftFrom(p) {
    const x = p || {};
    return {
      code: x.code || '', name: x.name || '', brand: x.brand || '', spec: x.spec || '',
      category: x.category || DEFAULT_CATEGORY, unit: x.unit || DEFAULT_UNIT, img: x.img || '',
      costPrice: x.costPrice || 0, salePrice: x.salePrice || 0, refPrice: x.refPrice || 0,
      isWholesale: !!(x.isWholesale || x.wholesale)
    };
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
    getCustomers: getCustomers,
    setCustomerNote: setCustomerNote
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Admin;

/* =====================================================================
 * 管理端 Demo —— 核心逻辑（无 DOM，可在 Node 中直接测试）
 * 对应《开发计划》M1.2：订单管理（状态操作 + 4 人配送雏形）、
 * 库存管理（入库单/盘点/直接改数，D8 手动）、顾客管理（私域雏形）
 * 数据约定：与顾客端共用 mall_orders；库存沿用 bd_products；
 *           管理端自有 mall_couriers / mall_stockLog / mall_customers。
 * 注意：库存页为占位实现（D1/D2/D4 待确认后可能调整形态）；
 *       一切库存变更必须走本模块并留流水（审计），扫码不改库存（D8）。
 * ===================================================================== */
'use strict';

// 浏览器：mall.js 已定义全局 Mall；Node：require
const Mall = (typeof module !== 'undefined' && module.exports) ? require('./mall.js') : window.Mall;

const Admin = (() => {

  const KEYS = {
    couriers: 'mall_couriers',
    stockLog: 'mall_stockLog',
    customerNotes: 'mall_customers'
  };
  const DEFAULT_COURIERS = ['老张', '小李', '阿强', '小美']; // 4 人配送雏形

  // ---------------- 配送员 ----------------
  function getCouriers() {
    const c = Mall._load(KEYS.couriers, null);
    if (!Array.isArray(c) || !c.length) { Mall._save(KEYS.couriers, DEFAULT_COURIERS); return DEFAULT_COURIERS.slice(); }
    return c.slice();
  }
  function setCouriers(list) {
    if (!Array.isArray(list) || !list.length) throw new Error('配送员名单不能为空');
    Mall._save(KEYS.couriers, list);
    return list;
  }

  // ---------------- 库存流水 ----------------
  function getStockLog() {
    const l = Mall._load(KEYS.stockLog, []);
    return Array.isArray(l) ? l : [];
  }
  function logStock(entry) {
    const l = getStockLog();
    l.unshift(Object.assign({ ts: Date.now() }, entry));
    if (l.length > 500) l.length = 500;
    Mall._save(KEYS.stockLog, l);
    return l[0];
  }

  // 改库存的公共步骤：校验 → 写 bd_products → 记流水
  function applyStockChange(code, delta, type, reason, by) {
    if (!delta || isNaN(delta)) throw new Error('变更数量无效');
    const products = Mall.loadCatalog();
    const p = products.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    const before = p.stock;
    const after = before + delta;
    if (after < 0) throw new Error('库存不能为负（当前 ' + before + ' ' + p.unit + '）');
    p.stock = after;
    Mall.saveCatalog(products);
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
    const products = Mall.loadCatalog();
    const p = products.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    const delta = counted - p.stock;
    if (delta === 0) return logStock({ type: 'stock_take', code: code, name: p.name, unit: p.unit, delta: 0, before: p.stock, after: p.stock, reason: '盘点一致', by: by || '店主' });
    p.stock = counted;
    Mall.saveCatalog(products);
    return logStock({ type: 'stock_take', code: code, name: p.name, unit: p.unit, delta: delta, before: p.stock - delta, after: p.stock, reason: '盘点调整', by: by || '店主' });
  }

  // ---------------- 订单管理（4 人配送雏形） ----------------
  // 给配送订单分配配送员：pending → delivering 并挂 courier；已配送/待自提可改派
  function setCourier(orderId, courier) {
    const roster = getCouriers();
    if (!roster.includes(courier)) throw new Error('配送员不在名单中：' + courier);
    let o = Mall.getOrders().find(x => x.id === orderId);
    if (!o) throw new Error('订单不存在');
    if (o.deliveryType !== 'delivery') throw new Error('自提订单无需配送员');
    if (o.status === 'pending') Mall.advanceOrder(orderId, 'delivering');
    const list = Mall.getOrders();
    const o2 = list.find(x => x.id === orderId);
    o2.courier = courier;
    o2.deliveredAt = o2.deliveredAt || 0;
    Mall._save(Mall.KEYS.orders, list);
    return o2;
  }

  // ---------------- 顾客管理（私域雏形） ----------------
  // 由订单聚合：同手机号合并；叠加备注/标签
  function getCustomers() {
    const orders = Mall.getOrders();
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
    const notes = Mall._load(KEYS.customerNotes, {}) || {};
    const list = Object.keys(map).map(k => {
      const c = map[k];
      const n = notes[c.phone] || {};
      return Object.assign({}, c, { note: n.note || '', tag: n.tag || '' });
    });
    list.sort((a, b) => b.lastOrderAt - a.lastOrderAt);
    return list;
  }
  function setCustomerNote(phone, note, tag) {
    const notes = Mall._load(KEYS.customerNotes, {}) || {};
    if (!notes[phone]) notes[phone] = {};
    if (note !== undefined) notes[phone].note = note;
    if (tag !== undefined) notes[phone].tag = tag;
    Mall._save(KEYS.customerNotes, notes);
    return notes[phone];
  }

  return {
    KEYS: KEYS,
    DEFAULT_COURIERS: DEFAULT_COURIERS,
    getCouriers: getCouriers,
    setCouriers: setCouriers,
    getStockLog: getStockLog,
    adjustStock: adjustStock,
    stockIn: stockIn,
    stockTake: stockTake,
    setCourier: setCourier,
    getCustomers: getCustomers,
    setCustomerNote: setCustomerNote
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Admin;

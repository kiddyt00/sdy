/* =====================================================================
 * 顾客端商城 Demo —— 核心逻辑（无 DOM，可在 Node 中直接测试）
 * 对应《开发计划》M1.1：首页/详情/购物车/结算/我的订单
 * 数据约定：与 barcode-demo 共用 localStorage['bd_products']（商品库档案），
 *           扫码建档后的商品在此立即可售；本 demo 另存购物车 mall_cart、
 *           订单 mall_orders。
 * 规则：
 *   - 配送费：自提 0；配送 满 30 免、否则 3 元（占位规则，可配）
 *   - 下单：校验库存 → 扣减 → 生成订单（待备货）；库存为 0 禁购
 *   - 取消：仅「待备货」可取消，取消回补库存；已备货不可直接删单
 *   - 扫码只读（D8）：本模块不改库存，库存只随下单/取消/管理端手动调整
 * ===================================================================== */
'use strict';

const Mall = (() => {

  // ---------------- 常量与存储 ----------------
  const KEYS = { products: 'bd_products', cart: 'mall_cart', orders: 'mall_orders' };
  const DELIVERY_RULES = { pickupFee: 0, minFree: 30, fee: 3 }; // 配送满 30 免、否则 3 元（占位）
  const STATUS_FLOW = {                    // 订单状态机：合法迁移表
    pending:    ['delivering', 'ready'],   // 待备货 → 配送中 | 待自提
    delivering: ['done'],                  // 配送中 → 已完成
    ready:      ['done'],                  // 待自提 → 已完成
    done:       [], cancelled: []
  };
  const STATUS_META = {
    pending:    { label: '待备货', cls: 'st-pending' },
    delivering: { label: '配送中', cls: 'st-delivering' },
    ready:      { label: '待自提', cls: 'st-ready' },
    done:       { label: '已完成', cls: 'st-done' },
    cancelled:  { label: '已取消', cls: 'st-cancelled' }
  };

  // Node 环境下无 localStorage → 用内存兜底（测试用）
  const mem = {};
  function loadLS(key, fallback) {
    let raw = null;
    if (typeof localStorage !== 'undefined') { try { raw = localStorage.getItem(key); } catch (e) {} }
    if (raw == null) raw = (key in mem ? mem[key] : null);
    try { return raw == null ? fallback : JSON.parse(raw); } catch (e) { return fallback; }
  }
  function saveLS(key, val) {
    const s = JSON.stringify(val);
    mem[key] = s;
    if (typeof localStorage !== 'undefined') { try { localStorage.setItem(key, s); } catch (e) {} }
  }

  // ---------------- 演示种子（与 barcode-demo 共用商品库） ----------------
  const SEED = [
    { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', img: '', costPrice: 1.8, salePrice: 2.5, unit: '罐', stock: 120, syncStatus: '已同步', createdAt: 0 },
    { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', category: '饮料', img: '', costPrice: 1.1, salePrice: 1.8, unit: '瓶', stock: 200, syncStatus: '已同步', createdAt: 0 },
    { code: '6921168509256', name: '心相印抽纸', brand: '心相印', spec: '3层100抽', category: '纸品', img: '', costPrice: 3.2, salePrice: 4.5, unit: '包', stock: 60, syncStatus: '待同步', createdAt: 0 },
    { code: '6925303725941', name: '旺旺雪饼', brand: '旺旺', spec: '84g', category: '休闲零食', img: '', costPrice: 3.0, salePrice: 4.5, unit: '袋', stock: 40, syncStatus: '已同步', createdAt: 0 },
    { code: '6901001100113', name: '青岛啤酒', brand: '青岛', spec: '500ml 罐', category: '酒水', img: '', costPrice: 4.2, salePrice: 6.0, unit: '罐', stock: 90, syncStatus: '已同步', createdAt: 0 },
    { code: '6907992751797', name: '伊利纯牛奶', brand: '伊利', spec: '250ml', category: '乳饮', img: '', costPrice: 2.6, salePrice: 3.5, unit: '盒', stock: 80, syncStatus: '已同步', createdAt: 0 }
  ];

  // ---------------- 商品库 ----------------
  function loadCatalog() {
    let list = loadLS(KEYS.products, null);
    if (!list || !list.length) { saveLS(KEYS.products, SEED); list = SEED; }
    return list.map(p => Object.assign({}, p));
  }
  function saveCatalog(list) { saveLS(KEYS.products, list); }
  function getProduct(code) {
    return loadCatalog().find(p => p.code === String(code).trim());
  }

  // ---------------- 购物车 ----------------
  function getCart() {
    const c = loadLS(KEYS.cart, []);
    return Array.isArray(c) ? c : [];
  }
  function saveCart(items) { saveLS(KEYS.cart, items); }
  function addToCart(code, qty) {
    const p = getProduct(code);
    if (!p) throw new Error('商品不存在');
    const n = Math.max(1, qty || 1);
    if (p.stock <= 0) throw new Error('「' + p.name + '」已售罄');
    if (n > p.stock) throw new Error('「' + p.name + '」库存不足（仅剩 ' + p.stock + ' ' + p.unit + '）');
    const cart = getCart();
    const it = cart.find(i => i.code === code);
    if (it) {
      if (it.qty >= p.stock) throw new Error('「' + p.name + '」已达库存上限（' + p.stock + ' ' + p.unit + '）');
      it.qty = Math.min(it.qty + n, p.stock);
    }
    else cart.push({ code: code, qty: n });
    saveCart(cart);
    return cart;
  }
  function setQty(code, qty) {
    const p = getProduct(code);
    let cart = getCart();
    if (qty <= 0) cart = cart.filter(i => i.code !== code);
    else {
      const it = cart.find(i => i.code === code);
      if (!it) throw new Error('购物车无此商品');
      const max = p ? p.stock : it.qty;
      it.qty = Math.min(qty, max);
      if (it.qty <= 0) cart = cart.filter(i => i.code !== code);
    }
    saveCart(cart);
    return cart;
  }
  function removeItem(code) {
    const cart = getCart().filter(i => i.code !== code);
    saveCart(cart);
    return cart;
  }
  function clearCart() { saveCart([]); }

  // 汇总：count / subtotal（含商品详情补全）
  function cartSummary() {
    const cart = getCart();
    let count = 0, subtotal = 0;
    const lines = cart.map(i => {
      const p = getProduct(i.code) || { code: i.code, name: '未知商品', spec: '', salePrice: 0, unit: '件' };
      count += i.qty;
      subtotal += +(p.salePrice * i.qty).toFixed(2);
      return { code: i.code, name: p.name, spec: p.spec, unit: p.unit, price: p.salePrice, qty: i.qty, stock: p.stock };
    });
    return { count: count, subtotal: Math.round(subtotal * 100) / 100, lines: lines };
  }

  // ---------------- 配送费规则 ----------------
  function calcDeliveryFee(deliveryType, subtotal) {
    const s = Math.round((subtotal || 0) * 100) / 100;
    if (deliveryType === 'pickup') return DELIVERY_RULES.pickupFee;
    if (deliveryType === 'delivery') return s >= DELIVERY_RULES.minFree ? 0 : DELIVERY_RULES.fee;
    throw new Error('未知配送方式');
  }

  // ---------------- 订单 ----------------
  function getOrders() {
    const o = loadLS(KEYS.orders, []);
    return Array.isArray(o) ? o : [];
  }
  function saveOrders(list) { saveLS(KEYS.orders, list); }

  // 下单：校验库存 → 扣减 → 生成订单（待备货）→ 清空购物车
  function createOrder(opts) {
    const deliveryType = opts && opts.deliveryType;
    const customer = opts && opts.customer || {};
    if (deliveryType !== 'pickup' && deliveryType !== 'delivery') throw new Error('请选择自提或配送');
    if (!customer.name || !customer.phone) throw new Error('请填写姓名与电话');
    if (deliveryType === 'delivery' && !customer.address) throw new Error('配送需填写地址');

    const sum = cartSummary();
    if (!sum.count) throw new Error('购物车是空的');

    const products = loadCatalog();
    // 1) 统一校验库存
    sum.lines.forEach(l => {
      if (l.qty > l.stock) throw new Error('「' + l.name + '」库存不足（仅剩 ' + l.stock + ' ' + l.unit + '）');
    });
    // 2) 扣减
    sum.lines.forEach(l => {
      const p = products.find(x => x.code === l.code);
      if (p) p.stock -= l.qty;
    });
    saveCatalog(products);
    // 3) 生成订单
    const deliveryFee = calcDeliveryFee(deliveryType, sum.subtotal);
    const order = {
      id: 'M' + Date.now(),
      createdAt: Date.now(),
      items: sum.lines.map(l => ({ code: l.code, name: l.name, spec: l.spec, unit: l.unit, price: l.price, qty: l.qty })),
      subtotal: sum.subtotal,
      deliveryType: deliveryType,
      deliveryFee: deliveryFee,
      total: Math.round((sum.subtotal + deliveryFee) * 100) / 100,
      customer: { name: customer.name, phone: customer.phone, address: customer.address || '' },
      status: 'pending'
    };
    const orders = getOrders();
    orders.unshift(order);
    saveOrders(orders);
    clearCart();
    return order;
  }

  // 取消：仅「待备货」→ 取消并回补库存
  function cancelOrder(id) {
    const orders = getOrders();
    const o = orders.find(x => x.id === id);
    if (!o) throw new Error('订单不存在');
    if (o.status !== 'pending') throw new Error('已备货订单不可取消');
    const products = loadCatalog();
    o.items.forEach(it => {
      const p = products.find(x => x.code === it.code);
      if (p) p.stock += it.qty;
    });
    saveCatalog(products);
    o.status = 'cancelled';
    saveOrders(orders);
    return o;
  }

  // 状态流转：pending→delivering|ready；delivering/ready→done
  function advanceOrder(id, to) {
    const orders = getOrders();
    const o = orders.find(x => x.id === id);
    if (!o) throw new Error('订单不存在');
    if (!(STATUS_FLOW[o.status] || []).includes(to)) throw new Error('状态不允许从「' + STATUS_META[o.status].label + '」变更为「' + (STATUS_META[to] ? STATUS_META[to].label : to) + '」');
    o.status = to;
    saveOrders(orders);
    return o;
  }

  function orderView(o) {
    return Object.assign({}, o, { statusLabel: STATUS_META[o.status].label, statusCls: STATUS_META[o.status].cls });
  }

  // ---------------- 测试辅助 ----------------
  function _resetForTest() {
    Object.keys(mem).forEach(k => delete mem[k]);
  }

  return {
    KEYS: KEYS,
    DELIVERY_RULES: DELIVERY_RULES,
    STATUS_FLOW: STATUS_FLOW,
    STATUS_META: STATUS_META,
    loadCatalog: loadCatalog,
    saveCatalog: saveCatalog,
    getProduct: getProduct,
    getCart: getCart,
    addToCart: addToCart,
    setQty: setQty,
    removeItem: removeItem,
    clearCart: clearCart,
    cartSummary: cartSummary,
    calcDeliveryFee: calcDeliveryFee,
    getOrders: getOrders,
    createOrder: createOrder,
    cancelOrder: cancelOrder,
    advanceOrder: advanceOrder,
    orderView: orderView,
    _resetForTest: _resetForTest
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Mall;

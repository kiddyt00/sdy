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
  const KEYS = {
    products: 'bd_products', cart: 'mall_cart', orders: 'mall_orders', addresses: 'mall_addresses',
    myPhone: 'mall_my_phone', myTier: 'mall_my_tier'   // 我的手机号与等级（任务池⑦ / D24）
  };
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
  // 上架判定（任务池⑥ / D23）：字段缺失一律视为上架，只有明确 onSale === false 才算下架。
  // 本地演示目录没有这个字段，不能因为 undefined 就把商品全下架。
  function isOnSale(p) { return !!p && p.onSale !== false; }
  // 顾客端可见商品（下架商品不出现在首页/分类/搜索结果里）
  function listOnSale() { return loadCatalog().filter(isOnSale); }
  // 局部更新商品字段（如 refPrice 牵牛花参考价），返回更新后的商品
  function updateProduct(code, patch) {
    const list = loadCatalog();
    const p = list.find(x => x.code === code);
    if (!p) throw new Error('商品不存在：' + code);
    Object.assign(p, patch || {});
    saveCatalog(list);
    return Object.assign({}, p);
  }

  // ---------------- 顾客等级与有效价（任务池⑦ / D24） ----------------
  // 口径与服务端 server/internal/pricing/pricing.go 完全一致：
  //   等级 retail(默认)/wholesale/vip；非零售等级且批发价 > 0 → 批发价，否则零售价；
  //   一律 round2。价格口径的真源在服务端——服务端在商品上算好 price 下发，
  //   这里优先用 p.price；拿不到（离线演示 / 直开 HTML）才按本地等级自己算。
  function round2(n) { return Math.round((+(n) || 0) * 100) / 100; }
  function isWholesaleTier(tier) { return tier === 'wholesale' || tier === 'vip'; }

  function getMyPhone() {
    const v = loadLS(KEYS.myPhone, '');
    return typeof v === 'string' ? v : '';
  }
  // 等级来源：① 在线同步时服务端告知的（mall_my_tier）
  //          ② 离线演示时管理端在本地顾客档案里设过的（mall_customers）
  function getMyTier() {
    const stored = loadLS(KEYS.myTier, '');
    if (stored === 'retail' || isWholesaleTier(stored)) return stored;
    const phone = getMyPhone();
    if (phone) {
      const cs = loadLS('mall_customers', null);
      let hit = null;
      if (Array.isArray(cs)) hit = cs.find(c => String(c.phone || '').trim() === phone) || null;
      else if (cs && typeof cs === 'object') hit = cs[phone] || null;
      if (hit && isWholesaleTier(hit.tier)) return hit.tier;
    }
    return 'retail';
  }
  // 记住「我的手机号」（下单成功后自动记住，下次进来就按我的等级显示价格）
  function setMyPhone(phone, tier) {
    const p = String(phone == null ? '' : phone).trim();
    const prev = getMyPhone();
    saveLS(KEYS.myPhone, p);
    if (tier === 'retail' || isWholesaleTier(tier)) saveLS(KEYS.myTier, tier);
    else if (!p || p !== prev) saveLS(KEYS.myTier, '');   // 换了手机号才清掉旧等级
    return p;
  }
  // 有效价：页面展示、购物车小计、离线下单都用它
  function priceOf(p) {
    if (!p) return 0;
    if (typeof p.price === 'number' && isFinite(p.price)) return round2(p.price);
    const w = +p.wholesalePrice || 0;
    if (isWholesaleTier(getMyTier()) && w > 0) return round2(w);
    return round2(p.salePrice);
  }
  // 是否按批发价（用于页面标「批发价」与划线原价）
  function isWholesalePrice(p) {
    const sale = round2(p && p.salePrice);
    return priceOf(p) < sale;
  }

  // ---------------- 购物车 ----------------
  // 「立即购买」是一张临时单：结算时只算这一件、结算完自动消失，绝不写进真正的购物车（与小程序同语义）。
  let buyNow = null;
  function setBuyNow(lines) {
    const list = (Array.isArray(lines) ? lines : [])
      .map(l => ({ code: String(l.code || ''), qty: Math.max(1, +(l.qty) || 1) }))
      .filter(l => l.code);
    buyNow = list.length ? list : null;   // 空数组等于没开（免得成了一张「没有商品的单」）
    return buyNow;
  }
  function peekBuyNow() { return buyNow ? buyNow.map(l => ({ code: l.code, qty: l.qty })) : null; }
  function clearBuyNow() { buyNow = null; }
  function getCart() {
    if (buyNow) return buyNow.map(l => ({ code: l.code, qty: l.qty }));
    const c = loadLS(KEYS.cart, []);
    return Array.isArray(c) ? c : [];
  }
  function saveCart(items) { saveLS(KEYS.cart, items); }
  function addToCart(code, qty) {
    buyNow = null;   // 手动动购物车就退出「立即购买」模式，免得两套数据打架
    const p = getProduct(code);
    if (!p) throw new Error('商品不存在');
    if (!isOnSale(p)) throw new Error('「' + p.name + '」已下架，暂时不能购买');
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
    buyNow = null;
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
    buyNow = null;
    const cart = getCart().filter(i => i.code !== code);
    saveCart(cart);
    return cart;
  }
  function clearCart() {
    if (buyNow) { buyNow = null; return; }   // 立即购买结算完只清这张临时单，购物车原样留着
    saveCart([]);
  }

  // 汇总：count / subtotal（含商品详情补全）
  function cartSummary() {
    const cart = getCart();
    let count = 0, subtotal = 0;
    const lines = cart.map(i => {
      const p = getProduct(i.code) || { code: i.code, name: '未知商品', spec: '', salePrice: 0, unit: '件' };
      const price = priceOf(p);                       // 有效价（任务池⑦ / D24）
      count += i.qty;
      subtotal += +(price * i.qty).toFixed(2);
      return {
        code: i.code, name: p.name, spec: p.spec, unit: p.unit, price: price,
        listPrice: round2(p.salePrice), wholesale: price < round2(p.salePrice),
        qty: i.qty, stock: p.stock, img: p.img || '', onSale: isOnSale(p)
      };
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
    // 1) 统一校验库存（顺手拦住「加购后商品被下架」的情况）
    sum.lines.forEach(l => {
      if (l.onSale === false) throw new Error('「' + l.name + '」已下架，请从购物车移除后重新结算');
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
    // 订单号唯一：本地单号是毫秒时间戳，同一毫秒内连下两单会撞号，之后按 id 找单会找错单
    while (orders.some(o => o.id === order.id)) order.id = 'M' + (Number(order.id.slice(1)) + 1);
    orders.unshift(order);
    saveOrders(orders);
    clearCart();
    setMyPhone(customer.phone);   // 记住手机号：下次进来按我的等级显示价格（D24）
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
  // 订单状态的一句话解释：文案与小程序 miniprogram/utils/rules.js 的 statusHint 保持一致，别在这里另写一套
  function statusHint(o) {
    if (!o) return '';
    if (o.status === 'pending') return o.deliveryType === 'delivery' ? '老板正在备货，稍后安排配送' : '老板正在备货，到店报手机号自提';
    if (o.status === 'delivering') return '正在配送途中，请留意电话';
    if (o.status === 'ready') return '已备好，到店报手机号即可取货';
    if (o.status === 'done') return '这笔已完成，谢谢惠顾';
    if (o.status === 'cancelled') return '这笔已取消，库存已回补';
    return '';
  }

  // ---------------- 收货地址簿（D18） ----------------
  // 与后端 server/internal/store 的 Address 同语义：按手机号归档、第一条自动默认、
  // 显式 isDefault 才顶替默认、编辑不动默认标记、删掉默认由剩下最早的一条顶替。
  // 订单里的地址仍是下单当时的快照 —— 改地址簿不影响历史订单。
  let _addrSeq = 0;
  function addrPhone(phone) { return String(phone == null ? '' : phone).trim(); }
  function _addrBook() {
    const m = loadLS(KEYS.addresses, null);
    return (m && typeof m === 'object' && !Array.isArray(m)) ? m : {};
  }
  function _addrWrite(book) { saveLS(KEYS.addresses, book); }
  function _addrNormalize(input) {
    const a = input || {};
    const phone = addrPhone(a.phone);
    const contact = String(a.contact == null ? '' : a.contact).trim();
    const address = String(a.address == null ? '' : a.address).trim();
    if (!phone) throw new Error('手机号不能为空');
    if (!contact) throw new Error('收货人不能为空');
    if (contact.length > 20) throw new Error('收货人不能超过 20 字');
    if (!address) throw new Error('送货地址不能为空');
    if (address.length > 120) throw new Error('送货地址不能超过 120 字');
    return {
      id: Number(a.id) || 0, phone: phone, contact: contact, address: address,
      isDefault: !!a.isDefault, createdAt: a.createdAt || '', updatedAt: a.updatedAt || ''
    };
  }
  // 默认地址排最前，其余按加入先后
  function listAddresses(phone) {
    const p = addrPhone(phone);
    if (!p) throw new Error('手机号不能为空');
    return (_addrBook()[p] || []).slice()
      .sort((a, b) => (b.isDefault ? 1 : 0) - (a.isDefault ? 1 : 0) || a.id - b.id);
  }
  function defaultAddress(phone) {
    const list = listAddresses(phone);
    return list.length ? list[0] : null;
  }
  function saveAddress(input) {
    const a = _addrNormalize(input);
    const all = _addrBook();
    const book = (all[a.phone] || []).slice();
    const now = new Date().toISOString();
    if (!book.length) a.isDefault = true;              // 第一条地址就是默认地址
    if (a.id) {
      const i = book.findIndex(x => x.id === a.id);
      if (i < 0) throw new Error('地址不存在');
      a.createdAt = book[i].createdAt || now;
      a.isDefault = a.isDefault || book[i].isDefault;  // 不传 isDefault 时不摘掉默认标记
      a.updatedAt = now;
      book[i] = a;
    } else {
      _addrSeq += 1;
      a.id = Date.now() * 1000 + (_addrSeq % 1000);
      a.createdAt = now; a.updatedAt = now;
      book.push(a);
    }
    if (a.isDefault) book.forEach(x => { if (x.id !== a.id) x.isDefault = false; });
    all[a.phone] = book;
    _addrWrite(all);
    return listAddresses(a.phone).filter(x => x.id === a.id)[0];
  }
  function deleteAddress(phone, id) {
    const p = addrPhone(phone);
    if (!p) throw new Error('手机号不能为空');
    const n = Number(id);
    if (!n) throw new Error('地址编号不合法');
    const all = _addrBook();
    const book = (all[p] || []).slice();
    const i = book.findIndex(x => x.id === n);
    if (i < 0) throw new Error('地址不存在');
    const wasDefault = book[i].isDefault;
    book.splice(i, 1);
    if (wasDefault && book.length) {
      const oldest = book.slice().sort((a, b) => a.id - b.id)[0];
      book.forEach(x => { x.isDefault = x.id === oldest.id; });
    }
    all[p] = book;
    _addrWrite(all);
    return { ok: true, id: n };
  }
  // 在线模式同步：把服务端地址簿整体覆盖进本地镜像（离线时仍能带出默认地址）
  function _saveAddresses(phone, list) {
    const p = addrPhone(phone);
    if (!p) return;
    const all = _addrBook();
    all[p] = (list || []).map(x => ({
      id: Number(x.id) || 0, phone: p, contact: x.contact || '', address: x.address || '',
      isDefault: !!x.isDefault, createdAt: x.createdAt || '', updatedAt: x.updatedAt || ''
    }));
    _addrWrite(all);
  }

  // ---------------- 测试辅助 ----------------
  function _resetForTest() {
    buyNow = null;
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
    isOnSale: isOnSale,
    listOnSale: listOnSale,
    updateProduct: updateProduct,
    getMyPhone: getMyPhone,
    setMyPhone: setMyPhone,
    getMyTier: getMyTier,
    priceOf: priceOf,
    isWholesalePrice: isWholesalePrice,
    getCart: getCart,
    setBuyNow: setBuyNow,
    peekBuyNow: peekBuyNow,
    clearBuyNow: clearBuyNow,
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
    statusHint: statusHint,
    listAddresses: listAddresses,
    defaultAddress: defaultAddress,
    saveAddress: saveAddress,
    deleteAddress: deleteAddress,
    _saveAddresses: _saveAddresses,
    _resetForTest: _resetForTest,
    _load: loadLS,   // 供管理端模块共用同一存储（含 Node 测试内存）
    _save: saveLS
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Mall;

/* =====================================================================
 * 顾客端商城 Demo —— 核心逻辑（无 DOM，可在 Node 中直接测试）
 * 对应《开发计划》M1.1：首页/详情/购物车/结算/我的订单
 * 数据约定：与 barcode-demo 共用 localStorage['bd_products']（商品库档案），
 *           扫码建档后的商品在此立即可售；本 demo 另存购物车 mall_cart、
 *           订单 mall_orders。
 * 规则：
 *   - 配送费：自提 0；配送满 minFree 免、否则 deliveryFee（本地默认占位，真源在服务端 /api/settings）
 *   - 起送价：subtotal < minOrder 时不下单，提示还差多少（minOrder=0 不限）
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
  // 本地兜底默认值（**唯一一处**）：服务端 /api/settings 下发什么就用什么（第 27 轮起
  // GET /api/settings 同时下发 lowStock / minOrder / deliveryFee / minFree），
  // 离线或服务端没下发这两个字段时才回落到这里。页面里别再硬编码 5 或 0。
  const LOCAL_DEFAULTS = { pickupFee: 0, minFree: 30, deliveryFee: 3, lowStock: 5, minOrder: 0 };
  // 生效中的配送费规则：对象身份保持不变，页面 index.html 直接读 Mall.DELIVERY_RULES
  const DELIVERY_RULES = { pickupFee: LOCAL_DEFAULTS.pickupFee, minFree: LOCAL_DEFAULTS.minFree, fee: LOCAL_DEFAULTS.deliveryFee };
  // 生效中的阈值：低库存阈值（≤ 它算「快没了」）/ 起送价
  const thresholds = { lowStock: LOCAL_DEFAULTS.lowStock, minOrder: LOCAL_DEFAULTS.minOrder };
  // 是否已经连上后端（由 sdy-api.js 探测/同步后告知）：连上了就不许再用本地演示商品重播种。
  let serverConnected = false;
  // 支付轮（支付）：服务端 /api/settings 的派生字段 payEnabled（微信支付是否已配置好）。
  // **默认 false = 未开通**：拿不到字段 / 请求失败 / 不是布尔，全按未开通算——这正是当前线上的真实状态。
  // 未开通时全站退回第 28 轮语义：pending 一律「待备货」，不叫顾客去别处付款。
  let payOn = false;
  const STATUS_FLOW = {                    // 订单状态机：合法迁移表
    pending:    ['delivering', 'ready'],   // 待备货 → 配送中 | 待取货
    delivering: ['done'],                  // 配送中 → 已完成
    ready:      ['done'],                  // 待取货 → 已完成
    done:       [], cancelled: []
  };
  const STATUS_META = {
    pending:    { label: '待备货', cls: 'st-pending' },
    delivering: { label: '配送中', cls: 'st-delivering' },
    ready:      { label: '待取货', cls: 'st-ready' },
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
  // 空库不重播种（P0-4）：后端已连但一件商品都没有时，必须如实显示「店里还没上架商品」，
  // 绝不能拿 6 条本地演示商品顶上——否则顾客会照着假货下单。只有从没连过后端时才允许演示数据。
  function loadCatalog() {
    let list = loadLS(KEYS.products, null);
    if (!list || !list.length) {
      if (serverConnected) return [];
      saveLS(KEYS.products, SEED); list = SEED;
    }
    return list.map(p => Object.assign({}, p));
  }
  function setServerConnected(on) { serverConnected = !!on; return serverConnected; }
  function isServerConnected() { return serverConnected; }
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

  // ---------------- 配送费 / 阈值（真源在服务端 /api/settings） ----------------
  // 复用 pricing.js 的同一份实现（三端同一口径）；拿不到时走等价内联兜底。
  function pricingModule() {
    try {
      if (typeof Pricing !== 'undefined' && Pricing && typeof Pricing.deliveryFee === 'function') return Pricing;
    } catch (e) { /* pricing.js 还没执行到（TDZ）时忽略 */ }
    if (typeof window !== 'undefined' && window.Pricing && typeof window.Pricing.deliveryFee === 'function') return window.Pricing;
    if (typeof module !== 'undefined' && module.exports) { try { return require('./pricing.js'); } catch (e) { /* 忽略 */ } }
    return null;
  }
  function deliveryCfg() {
    return { pickupFee: DELIVERY_RULES.pickupFee, minFree: DELIVERY_RULES.minFree, deliveryFee: DELIVERY_RULES.fee };
  }
  function calcDeliveryFee(deliveryType, subtotal) {
    const P = pricingModule();
    if (P) return P.deliveryFee(deliveryType, subtotal, deliveryCfg());
    // 内联兜底：未知配送方式按 delivery（与 pricing.js / Go 真源一致，不再抛错）
    const goods = round2(subtotal);
    if (deliveryType === 'pickup') return DELIVERY_RULES.pickupFee;
    return (DELIVERY_RULES.minFree > 0 && goods >= DELIVERY_RULES.minFree) ? 0 : DELIVERY_RULES.fee;
  }
  // 服务端 /api/settings → 本地生效值：下发的字段优先，没下发的保持本地默认。
  // 只认得出数字的字段，别把 undefined 当成 0 覆盖掉默认值（minOrder=0 代表「不限」，是真值）。
  function setSettings(s) {
    const x = s || {};
    if (typeof x.deliveryFee === 'number') DELIVERY_RULES.fee = round2(x.deliveryFee);
    if (typeof x.minFree === 'number') DELIVERY_RULES.minFree = round2(x.minFree);
    if (typeof x.pickupFee === 'number') DELIVERY_RULES.pickupFee = round2(x.pickupFee);
    if (typeof x.lowStock === 'number' && isFinite(x.lowStock)) thresholds.lowStock = Math.max(0, Math.floor(x.lowStock));
    if (typeof x.minOrder === 'number' && isFinite(x.minOrder)) thresholds.minOrder = round2(x.minOrder);
    // 严格认布尔真值：'true' / 1 / 缺字段都算未开通（服务端下发的是 JSON bool，别自作聪明做类型兼容）
    payOn = (x.payEnabled === true);
    return Object.assign({}, DELIVERY_RULES, { lowStock: thresholds.lowStock, minOrder: thresholds.minOrder, payEnabled: payOn });
  }
  // 回到本地默认（断线重连失败 / 测试复位用）
  function resetSettings() {
    DELIVERY_RULES.pickupFee = LOCAL_DEFAULTS.pickupFee;
    DELIVERY_RULES.minFree = LOCAL_DEFAULTS.minFree;
    DELIVERY_RULES.fee = LOCAL_DEFAULTS.deliveryFee;
    thresholds.lowStock = LOCAL_DEFAULTS.lowStock;
    thresholds.minOrder = LOCAL_DEFAULTS.minOrder;
    payOn = false;   // 复位即「未开通」，与「取不到 = 未开通」同一口径
    return Object.assign({}, DELIVERY_RULES, { lowStock: thresholds.lowStock, minOrder: thresholds.minOrder, payEnabled: payOn });
  }
  // 在线支付是否已开通（mall-admin.js / admin.html / index.html 都读这一个入口）
  function payEnabled() { return payOn === true; }
  function lowStock() { return thresholds.lowStock; }
  function minOrder() { return thresholds.minOrder; }
  // 起送价校验：返回 null 表示可以通过，否则返回给顾客看的中文原因
  function minOrderBlock(subtotal) {
    const min = thresholds.minOrder;
    if (!(min > 0)) return null;
    const goods = round2(subtotal);
    if (goods >= min) return null;
    return '还差 ' + round2(min - goods).toFixed(2) + ' 元起送';
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
    const blocked = minOrderBlock(sum.subtotal);   // 起送价（真源在服务端设置，minOrder=0 不限）
    if (blocked) throw new Error(blocked);

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
    return Object.assign({}, o, { statusLabel: orderLabel(o), statusCls: STATUS_META[o.status].cls });
  }
  // 支付轮（支付）：显示口径的唯一真源 —— status 一个值都不新增，只在 pending 内部按 paid 派生。
  // 「今日营业额 / 待备货队列」等业务口径不在这里判断，见 mall-admin.js 的 kpiOf / prepQueue。
  // 支付轮（payEnabled）：微信支付未开通时退回第 28 轮语义 —— pending 一律「待备货」，
  // 否则老板的备货队列会因为「没人付得了款」而恒空，店铺直接停摆。
  function isPaid(o) { return !!(o && (o.paid === true || o.paid === 1 || o.paid === '1')); }
  function orderLabel(o) {
    if (!o) return '';
    if (o.status === 'pending') return (isPaid(o) || !payEnabled()) ? '待备货' : '待付款';
    return (STATUS_META[o.status] || {}).label || String(o.status || '');
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtPaidAt(t) {
    if (!t) return '';
    const d = new Date(t);
    if (isNaN(d.getTime())) return '';
    const p = n => (n < 10 ? '0' : '') + n;
    return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  // 支付徽标四态（管理后台订单表「支付」列 / 详情区共用）：
  //   未付款 → 琥珀 .st-pending；已付款（带到账时间）→ 绿 .st-done；
  //   退款处理中 → 蓝 .st-info；退款失败 → 红 .st-warn（必须一眼看见，不许静默）；
  //   已退款 → 灰 .st-cancelled。
  // 退款态（refundState）优先于 paid 显示：退款处理中的单 paid 仍为 true，只看 paid 会误读成「已收款」。
  // 支付轮（支付）：退款三态中文以小程序侧字面为准，三端逐字一致（改文案前先看 miniprogram 同名字段）。
  function payBadgeHTML(o) {
    if (!o) return '';
    const rs = String(o.refundState || '');
    if (rs === 'processing') return '<span class="badge st-info">退款处理中</span>';
    if (rs === 'fail') return '<span class="badge st-warn">退款失败，请联系店家</span>';
    if (rs === 'success') return '<span class="badge st-cancelled">已退款</span>';
    // 支付轮（payEnabled）：未开通在线支付时「未付款」不是异常、也没人能付，
    // 挂个琥珀「未付款」只会让老板以为漏收了钱 —— 干脆不出徽标。
    // 退款三态与「已付款」不受影响：那两件事都是真发生过的资金动作。
    if (!isPaid(o) && !payEnabled()) return '';
    if (!isPaid(o)) return '<span class="badge st-pending">未付款</span>';
    const t = fmtPaidAt(o.paidAt);
    // 时间缺省（老单被后台标记已收款但没写时间）时退化成「已付款」，不编造时间。
    return '<span class="badge st-done">' + (t ? '已付款 ' + esc(t) : '已付款') + '</span>';
  }
  // 订单状态的一句话解释：文案与小程序 miniprogram/utils/rules.js 的 statusHint 保持一致，别在这里另写一套。
  // 支付轮（支付）：待付款单先讲钱——Web 端不做线上支付，顾客必须知道要去小程序付。
  function statusHint(o) {
    if (!o) return '';
    if (o.status === 'pending') {
      // 未开通在线支付：没有任何付款动作可做，别叫顾客去小程序 —— 回到与小程序逐字一致的备货文案。
      if (!isPaid(o) && !payEnabled()) {
        return o.deliveryType === 'delivery' ? '老板正在备货，稍后安排配送' : '老板正在备货，到店报手机号自提';
      }
      if (!isPaid(o)) return '请在微信小程序里完成支付（网页版暂不支持线上支付）';
      return o.deliveryType === 'delivery' ? '老板正在备货，稍后安排配送' : '老板正在备货，到店报手机号自提';
    }
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

  // ---------------- 商品列表：关键词 / 筛选 / 排序 / 分页（第 28 轮 7.2、7.4、7.8） ----------------
  // 排序取值三端逐字相同（7.8）：default|hot|price_asc|price_desc|stock_desc。
  // 后端是价格/销量口径的真源；这里的纯函数只在离线（本地演示）与「后端抽风」时兜底，
  // 口径必须与 server 一致，否则离线看到的顺序和连上后端后不一样。
  const SORTS = ['default', 'hot', 'price_asc', 'price_desc', 'stock_desc'];
  function normalizeSort(s) { return SORTS.indexOf(String(s == null ? '' : s)) >= 0 ? String(s) : 'default'; }
  function byName(a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }

  // 近 N 天有效销量（与后端 sort=hot 同口径：pending / delivering / ready / done）
  function salesOf(code, days) {
    const since = Date.now() - (days == null ? 30 : days) * 86400000;
    let n = 0;
    getOrders().forEach(o => {
      if (['pending', 'delivering', 'ready', 'done'].indexOf(o.status) < 0) return;
      if (o.createdAt && o.createdAt < since) return;
      (o.items || []).forEach(it => { if (it.code === code) n += Number(it.qty) || 0; });
    });
    return n;
  }
  function matchKeyword(p, kw) {
    const k = String(kw == null ? '' : kw).trim().toLowerCase();
    if (!k) return true;
    return ((p.name || '') + ' ' + (p.brand || '') + ' ' + (p.code || '')).toLowerCase().indexOf(k) >= 0;
  }
  // 排序（不改入参数组）。default 保持原顺序（第 27 轮行为不变）。
  function sortProducts(list, sort) {
    const s = normalizeSort(sort);
    const arr = (list || []).slice();
    if (s === 'default') return arr;
    if (s === 'price_asc' || s === 'price_desc') {
      const dir = (s === 'price_asc') ? 1 : -1;
      return arr.sort((a, b) => ((priceOf(a) - priceOf(b)) * dir) || byName(a, b));
    }
    if (s === 'stock_desc') {
      return arr.sort((a, b) => ((Number(b.stock) || 0) - (Number(a.stock) || 0)) || byName(a, b));
    }
    // hot：有销量的按销量降序；**没销量的排在后面而不是被排除**；并列上架优先 + 名称升序
    return arr.sort((a, b) => {
      const d = salesOf(b.code) - salesOf(a.code);
      if (d) return d;
      const on = ((b.onSale !== false) ? 1 : 0) - ((a.onSale !== false) ? 1 : 0);
      if (on) return on;
      return byName(a, b);
    });
  }
  // 分页：limit=0 表示不限（与后端默认一致）；hasMore 由「已取条数 + offset < total」判定
  function listPage(input) {
    const q = input || {};
    const all = q.list ? q.list.slice() : loadCatalog();
    const onlySale = (q.onSale === 1 || q.onSale === '1' || q.onSale === true);
    const list = all.filter(p => {
      if (onlySale && p.onSale === false) return false;
      if (q.category && (p.category || '未分类') !== q.category) return false;
      return matchKeyword(p, q.keyword);
    });
    const total = list.length;
    const sorted = sortProducts(list, q.sort);
    const limit = Number(q.limit) > 0 ? Number(q.limit) : 0;
    const offset = Number(q.offset) > 0 ? Number(q.offset) : 0;
    const items = (limit > 0) ? sorted.slice(offset, offset + limit) : sorted.slice(offset);
    return { items: items, total: total, limit: limit, offset: offset, hasMore: offset + items.length < total, tier: getMyTier() };
  }
  // 缺货替代（7.4）：同分类热销优先，不够用全店热销补足（不重复）；只回上架且有货、排除自身
  function alternatives(code, limit) {
    const n = Number(limit) > 0 ? Number(limit) : 5;
    const self = getProduct(code);
    const pool = loadCatalog().filter(p => p.code !== code && p.onSale !== false && (Number(p.stock) || 0) > 0);
    const cat = self ? (self.category || '未分类') : '';
    const same = cat ? sortProducts(pool.filter(p => (p.category || '未分类') === cat), 'hot') : [];
    const rest = sortProducts(pool.filter(p => same.indexOf(p) < 0), 'hot');
    const items = same.concat(rest).slice(0, n);
    return { items: items, total: items.length };
  }
  // 防抖：搜索框每敲一个字就整块重建商品卡太费（7.8 要求 300ms）。
  // flush/cancel/delay 是给测试用的（不改语义），页面只用 wrapped。
  function debounce(fn, ms) {
    const delay = (Number(ms) >= 0) ? Number(ms) : 300;
    let t = null;
    function wrapped() {
      const self = this, args = arguments;
      if (t) clearTimeout(t);
      t = setTimeout(() => { t = null; fn.apply(self, args); }, delay);
    }
    wrapped.delay = delay;
    wrapped.cancel = function () { if (t) clearTimeout(t); t = null; };
    wrapped.flush = function () { if (t) { clearTimeout(t); t = null; fn(); } };
    return wrapped;
  }
  // 全量商品档案（含下架）：管理端「内置示例商品」提示条在用（admin.html:1854）
  function listProducts() { return loadCatalog(); }

  // ---------------- 测试辅助 ----------------
  function _resetForTest() {
    buyNow = null;
    serverConnected = false;
    resetSettings();
    Object.keys(mem).forEach(k => delete mem[k]);
  }

  return {
    KEYS: KEYS,
    LOCAL_DEFAULTS: LOCAL_DEFAULTS,
    DELIVERY_RULES: DELIVERY_RULES,
    setSettings: setSettings,
    resetSettings: resetSettings,
    lowStock: lowStock,
    minOrder: minOrder,
    minOrderBlock: minOrderBlock,
    setServerConnected: setServerConnected,
    isServerConnected: isServerConnected,
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
    // 第 28 轮（7.2 / 7.4 / 7.8）：列表筛选/排序/分页、缺货替代、搜索防抖
    SORTS: SORTS,
    normalizeSort: normalizeSort,
    matchKeyword: matchKeyword,
    sortProducts: sortProducts,
    listPage: listPage,
    alternatives: alternatives,
    debounce: debounce,
    listProducts: listProducts,
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
    // 支付轮（支付）：显示口径真源（管理后台 mall-admin.js 再导出这两个，两端共用一套）
    orderLabel: orderLabel,
    payBadgeHTML: payBadgeHTML,
    isPaid: isPaid,
    // 支付轮（payEnabled）：在线支付是否开通（false = 未开通，全站退回「待备货」语义）
    payEnabled: payEnabled,
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

/* =====================================================================
 * 顾客端商城 Demo —— 核心逻辑测试（Node）
 * 覆盖：购物车合计 / 配送费规则 / 下单扣库存 / 取消回补 / 状态机 / 售罄
 * 运行：node test-mall.js
 * ===================================================================== */
'use strict';
const Mall = require('./mall.js');

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ ' + msg); }
}
function throws(fn, msg) {
  try { fn(); ok(false, msg + '（应抛错却成功）'); }
  catch (e) { ok(true, msg + '（' + e.message + '）'); }
}
function section(t) { console.log('\n■ ' + t); }

function fresh() {
  Mall._resetForTest();
  Mall.loadCatalog();           // 触发播种
}

// ============ ① 购物车与合计 ============
section('① 购物车与合计');
fresh();
ok(Mall.cartSummary().count === 0 && Mall.cartSummary().subtotal === 0, '空车 count=0 subtotal=0');
Mall.addToCart('6901234567892', 2);   // 可乐 2.5
Mall.addToCart('6902083881234', 3);   // 农夫山泉 1.8
Mall.addToCart('6901234567892', 1);   // 再加 1 → 同码合并 3
{
  const s = Mall.cartSummary();
  ok(s.count === 6, 'count=6（2+3+1 合并）');
  ok(s.subtotal === 2.5 * 3 + 1.8 * 3 && Math.abs(s.subtotal - 12.9) < 1e-6, 'subtotal=12.9（3×2.5+3×1.8）');
  ok(s.lines.find(l => l.code === '6901234567892').qty === 3, '同码合并 qty=3');
}
Mall.setQty('6902083881234', 0);
ok(Mall.cartSummary().count === 3, 'setQty(0) 移除该行，count=3');
Mall.setQty('6901234567892', 999);    // 超库存 → 钳到 120
ok(Mall.cartSummary().lines[0].qty === 120, '超库存钳制到 120');
throws(() => Mall.addToCart('6901234567892', 100), '已到 120 再加 100 → 库存不足拦截');
Mall.clearCart();
ok(Mall.cartSummary().count === 0, 'clearCart 后 count=0');

// ============ ② 配送费规则 ============
section('② 配送费规则');
ok(Mall.calcDeliveryFee('pickup', 0) === 0, '自提任意金额免配送费');
ok(Mall.calcDeliveryFee('pickup', 99.99) === 0, '自提 99.99 免配送费');
ok(Mall.calcDeliveryFee('delivery', 29.99) === 3, '配送 29.99 < 30 → 3 元');
ok(Mall.calcDeliveryFee('delivery', 30) === 0, '配送 30 → 免');
ok(Mall.calcDeliveryFee('delivery', 55.5) === 0, '配送 55.5 → 免');
throws(() => Mall.calcDeliveryFee('xxx', 10), '未知配送方式抛错');

// ============ ③ 下单：校验 → 扣减 → 生成订单 ============
section('③ 下单扣库存与校验');
fresh();
const stockBefore = Mall.getProduct('6901234567892').stock; // 120
Mall.addToCart('6901234567892', 5);
Mall.addToCart('6901001100113', 2);   // 青岛 6.0
{
  const o = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '张三', phone: '13800000000' } });
  ok(o.status === 'pending', '订单初始状态=待备货');
  ok(o.subtotal === 2.5 * 5 + 6 * 2, 'subtotal 正确');
  ok(o.deliveryFee === 0 && o.total === o.subtotal, '自提配送费 0，total=subtotal');
  ok(Mall.getProduct('6901234567892').stock === stockBefore - 5, '下单扣减库存 120→115');
  ok(Mall.cartSummary().count === 0, '下单后购物车清空');
  ok(Mall.getOrders().length === 1, '订单已入列表');
}
// 库存不足下单（先手动改库存：加购 2 后，下单前库存降为 1）
Mall._resetForTest();
{
  const list = Mall.loadCatalog();
  list.find(p => p.code === '6901234567892').stock = 3;
  Mall.saveCatalog(list);
  Mall.addToCart('6901234567892', 2);                // 2 ≤ 3，可加购
  const list2 = Mall.loadCatalog();
  list2.find(p => p.code === '6901234567892').stock = 1; // 下单前库存降为 1
  Mall.saveCatalog(list2);
  throws(() => Mall.createOrder({ deliveryType: 'delivery', customer: { name: '李四', phone: '13900000000', address: '幸福路1号' } }), '下单时库存不足 → 拦截且不生成订单');
  ok(Mall.getOrders().length === 0, '拦截后订单数为 0');
  ok(Mall.getProduct('6901234567892').stock === 1, '拦截后库存未变（仍 1）');
}
// 表单校验
fresh();
throws(() => Mall.createOrder({ deliveryType: 'delivery', customer: { name: '', phone: '1' } }), '缺姓名 → 拦截');
throws(() => Mall.createOrder({ deliveryType: 'pickup', customer: { name: '王五' } }), '缺电话 → 拦截');
Mall.addToCart('6901234567892', 1);
throws(() => Mall.createOrder({ deliveryType: 'delivery', customer: { name: '王五', phone: '1' } }), '配送缺地址 → 拦截');
{
  const o = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '王五', phone: '13700000000', address: '花园路2号' } });
  ok(o.deliveryFee === 3, '配送 <30 → 运费 3 计入 total');
}

// ============ ④ 取消回补 ============
section('④ 取消订单回补库存');
fresh();
const s2 = Mall.getProduct('6901001100113').stock; // 90
Mall.addToCart('6901001100113', 4);
const o2 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '赵六', phone: '13600000000' } });
ok(Mall.getProduct('6901001100113').stock === s2 - 4, '下单后库存 90→86');
Mall.cancelOrder(o2.id);
ok(Mall.getProduct('6901001100113').stock === s2, '取消后库存回补 86→90');
ok(Mall.getOrders()[0].status === 'cancelled', '状态=已取消');
// 已备货不可取消
Mall.addToCart('6901001100113', 1);
const o3 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '钱七', phone: '13500000000' } });
Mall.advanceOrder(o3.id, 'ready');
throws(() => Mall.cancelOrder(o3.id), '待自提（已备货）不可取消 → 拦截');

// ============ ⑤ 订单状态机 ============
section('⑤ 订单状态机');
fresh();
Mall.addToCart('6907992751797', 2);
const o4 = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '孙八', phone: '13400000000', address: '梧桐巷3号' } });
Mall.advanceOrder(o4.id, 'delivering');
ok(Mall.getOrders()[0].status === 'delivering', 'pending → delivering 合法');
Mall.advanceOrder(o4.id, 'done');
ok(Mall.getOrders()[0].status === 'done', 'delivering → done 合法');
Mall.addToCart('6907992751797', 1);
const o5 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '周九', phone: '13300000000' } });
Mall.advanceOrder(o5.id, 'ready');
ok(Mall.getOrders()[0].status === 'ready', 'pending → ready 合法');
Mall.advanceOrder(o5.id, 'done');
ok(Mall.getOrders()[0].status === 'done', 'ready → done 合法');
Mall.addToCart('6907992751797', 1);
const o6 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '吴十', phone: '13200000000' } });
throws(() => Mall.advanceOrder(o6.id, 'done'), 'pending → done 非法（必须经 delivering/ready）');
throws(() => Mall.advanceOrder(o6.id, 'cancelled'), 'pending → cancelled 非法（取消走 cancelOrder）');
ok(Mall.getOrders()[0].status === 'pending', '非法迁移后状态仍为 pending');
{
  // 同一毫秒连下两单不能撞号（本地单号 = 毫秒时间戳；撞号会让流转/取消找错单）
  const realNow = Date.now;
  Date.now = () => 1760000000000;
  fresh();
  Mall.addToCart('6907992751797', 1);
  const a1 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '甲', phone: '13000000001' } });
  Mall.addToCart('6907992751797', 1);
  const a2 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '乙', phone: '13000000002' } });
  Date.now = realNow;
  ok(a1.id !== a2.id, '同一毫秒内两单订单号不重复（' + a1.id + ' / ' + a2.id + '）');
  ok(Mall.getOrders().length === 2, '两单都在库里（2 条）');
}

// ============ ⑥ 售罄 ============
section('⑥ 售罄禁购');
fresh();
{
  const list = Mall.loadCatalog();
  list.find(p => p.code === '6925303725941').stock = 0;
  Mall.saveCatalog(list);
}
throws(() => Mall.addToCart('6925303725941', 1), '售罄商品加购 → 拦截');
{
  const list = Mall.loadCatalog();
  list.find(p => p.code === '6925303725941').stock = 2;
  Mall.saveCatalog(list);
  Mall.addToCart('6925303725941', 2);
  Mall.addToCart('6901234567892', 1);
  const list2 = Mall.loadCatalog();
  list2.find(p => p.code === '6925303725941').stock = 1; // 下单前该品库存降为 1 < 车 2
  Mall.saveCatalog(list2);
  throws(() => Mall.createOrder({ deliveryType: 'pickup', customer: { name: '郑一', phone: '13100000000' } }), '下单时某品售罄 → 整单拦截');
}

// ============ ⑦ updateProduct（M2 价格防线保存参考价） ============
section('⑦ updateProduct 商品字段更新');
fresh();
{
  const p = Mall.updateProduct('6901234567892', { refPrice: 5.2 });
  ok(p.refPrice === 5.2, '写入 refPrice 并返回更新后商品');
  ok(Mall.getProduct('6901234567892').refPrice === 5.2, 'refPrice 持久化');
}
throws(() => Mall.updateProduct('6900000000000', { refPrice: 1 }), '更新不存在的商品 → 拦截');
{
  Mall.updateProduct('6902083881234', { salePrice: 1.9 });
  Mall.addToCart('6902083881234', 1);
  ok(Math.abs(Mall.cartSummary().subtotal - 1.9) < 1e-6, '改价后购物车按新价合计');
  Mall.clearCart();
}

// ============ ⑧ 收货地址簿（D18） ============
section('⑧ 收货地址簿');
fresh();
const P1 = '13800000001', P2 = '13800000002';
ok(Array.isArray(Mall.listAddresses(P1)) && Mall.listAddresses(P1).length === 0, '新手机号 → 空地址簿');
throws(() => Mall.listAddresses('  '), '空手机号查地址簿 → 拦截');
const a1 = Mall.saveAddress({ phone: P1, contact: ' 王阿姨 ', address: ' 幸福路1号 3单元 501 ' });
ok(a1.isDefault === true, '第一条地址自动成为默认');
ok(a1.contact === '王阿姨' && a1.address === '幸福路1号 3单元 501', '收货人/地址两端空格被裁掉');
ok(a1.id > 0 && a1.createdAt, '拿到 id 与 createdAt');
const a2 = Mall.saveAddress({ phone: P1, contact: '王叔叔', address: '幸福路1号 3单元 502' });
ok(a2.isDefault === false, '第二条不抢默认');
ok(Mall.defaultAddress(P1).id === a1.id, 'defaultAddress 返回第一条');
ok(Mall.listAddresses(P1).length === 2 && Mall.listAddresses(P1)[0].id === a1.id, '列表默认地址排最前');
const a3 = Mall.saveAddress({ phone: P1, contact: '王叔叔', address: '幸福路2号 1单元 101', isDefault: true });
ok(Mall.defaultAddress(P1).id === a3.id, '显式 isDefault 顶替默认');
ok(Mall.listAddresses(P1).filter(x => x.isDefault).length === 1, '任何时刻只有一个默认地址');
{
  const ed = Mall.saveAddress({ id: a1.id, phone: P1, contact: '王阿姨', address: '幸福路1号 3单元 501 改' });
  ok(ed.address.endsWith('改'), '编辑地址生效');
  ok(ed.createdAt === a1.createdAt, '编辑保留 createdAt');
  ok(ed.isDefault === false, '编辑不传 isDefault → 不摘掉也不抢默认');
  ok(Mall.defaultAddress(P1).id === a3.id, '默认地址仍是 a3');
}
throws(() => Mall.saveAddress({ id: 999999, phone: P1, contact: '谁', address: '哪' }), '编辑不存在的地址 → 拦截');
throws(() => Mall.saveAddress({ phone: '', contact: '甲', address: '乙' }), '缺手机号 → 拦截');
throws(() => Mall.saveAddress({ phone: P1, contact: '', address: '乙' }), '缺收货人 → 拦截');
throws(() => Mall.saveAddress({ phone: P1, contact: '甲', address: '' }), '缺地址 → 拦截');
throws(() => Mall.saveAddress({ phone: P1, contact: '甲'.repeat(21), address: '乙' }), '收货人 21 字 → 拦截');
throws(() => Mall.saveAddress({ phone: P1, contact: '甲', address: '乙'.repeat(121) }), '地址 121 字 → 拦截');
Mall.saveAddress({ phone: P2, contact: '李叔', address: '和平小区 7 栋 202' });
ok(Mall.listAddresses(P2).length === 1 && Mall.defaultAddress(P2).contact === '李叔', '按手机号隔离，各自独立默认');
ok(Mall.listAddresses(P1).length === 3, 'P1 不受 P2 影响');
throws(() => Mall.deleteAddress(P1, 0), '删除 id=0 → 拦截');
throws(() => Mall.deleteAddress('', a1.id), '删除空手机号 → 拦截');
throws(() => Mall.deleteAddress(P1, 999999), '删除不存在的地址 → 拦截');
Mall.deleteAddress(P1, a3.id);   // 删默认 → 剩下最早一条顶上
ok(Mall.listAddresses(P1).length === 2, '删除后剩 2 条');
ok(Mall.defaultAddress(P1).id === a1.id, '删掉默认地址 → 剩下最早一条顶为默认');
Mall._saveAddresses(P1, [{ id: 501, contact: '同步人', address: '云端地址', isDefault: true }]);
ok(Mall.listAddresses(P1).length === 1 && Mall.defaultAddress(P1).contact === '同步人', '_saveAddresses 覆盖本地镜像（在线同步用）');
ok(Mall.listAddresses(P1)[0].phone === P1, '镜像条目回填 phone');

/* ============ ⑨ 上下架（D23） ============ */
section('⑨ 上下架（任务池⑥ / D23）');
fresh();
{
  const C = '6901234567892';
  ok(Mall.isOnSale(Mall.getProduct(C)) === true, '演示目录默认在售');
  ok(Mall.listOnSale().length === Mall.loadCatalog().length, '没人下架时顾客端列表＝全量');
  Mall.updateProduct(C, { onSale: false });
  ok(Mall.isOnSale(Mall.getProduct(C)) === false, '下架后 isOnSale=false');
  ok(!Mall.listOnSale().some(p => p.code === C), '下架商品不在顾客端列表（首页/分类/搜索都不出）');
  ok(Mall.loadCatalog().some(p => p.code === C), '管理端全量仍能看到（否则再也上不了架）');
  throws(() => Mall.addToCart(C, 1), '下架商品不能加购');
  ok(Mall.isOnSale({ code: 'x' }) === true, '字段缺失视为在售（兼容旧演示数据）');
  ok(Mall.isOnSale(null) === false, 'null 不算在售');
  // 加购后商品被下架 → 结算必须拦住，且不能扣库存
  Mall.updateProduct(C, { onSale: true });
  Mall.addToCart(C, 2);
  const before = Mall.getProduct(C).stock;
  Mall.updateProduct(C, { onSale: false });
  ok(Mall.cartSummary().lines[0].onSale === false, '购物车行标记「已下架」');
  throws(() => Mall.createOrder({ deliveryType: 'pickup', customer: { name: '王阿姨', phone: '13900000001' } }), '含下架商品的购物车不能结算');
  ok(Mall.getProduct(C).stock === before, '拦截发生在扣库存之前');
  Mall.updateProduct(C, { onSale: true });
  const o = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '王阿姨', phone: '13900000001' } });
  ok(o.status === 'pending' && Mall.getProduct(C).stock === before - 2, '重新上架后可以下单并扣库存');
  ok(Mall.cartSummary().count === 0, '下单后购物车清空');
}

// ============ ⑩ 立即购买（不碰购物车） ============
section('⑩ 立即购买（不碰购物车）');
const COLA = '6901234567892';    // 2.5
const WATER = '6902083881234';   // 1.8
fresh();
Mall.addToCart(WATER, 1);
ok(Mall.getCart().length === 1, '购物车原有 1 行（农夫山泉）');
Mall.setBuyNow([{ code: COLA, qty: 2 }]);
{
  const s = Mall.cartSummary();
  ok(s.count === 2 && Math.abs(s.subtotal - 5) < 1e-6, '立即购买只算这一件：2×2.5=5');
  ok(s.lines.length === 1 && s.lines[0].code === COLA, '结算视图里只有这一件');
}
const colaStock = Mall.getProduct(COLA).stock;
const waterStock = Mall.getProduct(WATER).stock;
const bnow = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '立即购买顾客', phone: '13800138000' } });
ok(bnow.items.length === 1 && bnow.items[0].code === COLA && bnow.total === 5, '下单只下这一件，自提 5 元');
ok(Mall.getProduct(COLA).stock === colaStock - 2, '只扣这一件的库存：' + colaStock + ' → ' + Mall.getProduct(COLA).stock);
ok(Mall.getProduct(WATER).stock === waterStock, '购物车里那件库存没被扣');
ok(Mall.peekBuyNow() === null, '下单后自动退出立即购买模式');
ok(Mall.getCart().length === 1 && Mall.getCart()[0].code === WATER, '原购物车原封不动');
ok(Mall.cartSummary().count === 1, '视图回到真实购物车');

Mall.setBuyNow([{ code: COLA, qty: 1 }]);
Mall.clearBuyNow();
ok(Mall.peekBuyNow() === null && Mall.cartSummary().count === 1, 'clearBuyNow 只退出模式，不动购物车');

Mall.setBuyNow([{ code: COLA, qty: 1 }]);
Mall.addToCart(WATER, 1);
ok(Mall.peekBuyNow() === null, '手动动购物车就退出立即购买模式（两套数据不打架）');
ok(Mall.cartSummary().count === 2, '退出后算的是真实购物车（1+1）');
Mall.setBuyNow([]);
ok(Mall.peekBuyNow() === null, '空数组等于没开立即购买');
Mall.setBuyNow([{ code: COLA, qty: 1 }]);
ok(Mall.cartSummary().count === 1 && Mall.getCart()[0].code === COLA, '开启后结算只看到立即购买那一件');
Mall.clearBuyNow();
Mall.clearCart();

// ============ ⑪ 订单状态文案（与小程序同口径） ============
section('⑪ 订单状态文案');
const rules = require('../miniprogram/utils/rules.js');
fresh();
const hintCases = [
  { status: 'pending', deliveryType: 'delivery' },
  { status: 'pending', deliveryType: 'pickup' },
  { status: 'delivering', deliveryType: 'delivery' },
  { status: 'ready', deliveryType: 'pickup' },
  { status: 'done', deliveryType: 'delivery' },
  { status: 'cancelled', deliveryType: 'pickup' }
];
hintCases.forEach((c) => {
  ok(Mall.statusHint(c) === rules.statusHint(c) && Mall.statusHint(c) !== '',
    '文案与小程序一致：' + c.status + '/' + c.deliveryType + ' → ' + Mall.statusHint(c));
});
ok(Mall.statusHint(null) === '', '空订单一句话也不编');

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

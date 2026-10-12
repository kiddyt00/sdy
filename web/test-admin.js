/* =====================================================================
 * 管理端 Demo —— 核心逻辑测试（Node）
 * 覆盖：库存变更/入库/盘点流水、库存非负拦截、4 人配送分配、
 *       顾客聚合（同号合并/金额统计/备注标签）、流水顺序
 * 运行：node test-admin.js
 * ===================================================================== */
'use strict';
const Mall = require('./mall.js');
const Admin = require('./mall-admin.js');

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

// ============ ① 直接改数 + 入库 ============
section('① 库存变更与流水');
fresh();
{
  const e = Admin.adjustStock('6901234567892', 5, '到货补货', '店主');
  ok(e.type === 'adjust' && e.delta === 5 && e.before === 120 && e.after === 125, '直接改数 +5：120→125，流水完整');
  ok(e.by === '店主' && e.reason === '到货补货', '流水记录操作人与原因');
  ok(Mall.getProduct('6901234567892').stock === 125, '商品库存已更新 125');
}
{
  const e = Admin.stockIn('6902083881234', 10, '入库单 R20261010-01（怡宝水）', '阿强');
  ok(e.type === 'stock_in' && e.before === 200 && e.after === 210, '入库单 +10：200→210');
  ok(Mall.getProduct('6902083881234').stock === 210, '入库后库存 210');
}
throws(() => Admin.stockIn('6902083881234', -5, 'x'), '入库数量非正 → 拦截');
throws(() => Admin.adjustStock('6901234567892', -999, '盘亏', '店主'), '改数使库存为负 → 拦截（当前 125 罐）');
throws(() => Admin.adjustStock('9999999999999', 1, 'x'), '商品不存在 → 拦截');
{
  const log = Admin.getStockLog();
  ok(log.length === 2, '流水共 2 条（被拦截的变更不记流水）');
  ok(log[0].ts >= log[1].ts, '流水按时间倒序（最新在前）');
}

// ============ ② 盘点 ============
section('② 盘点以实盘为准');
fresh();
{
  const e = Admin.stockTake('6921168509256', 58, '店主');   // 账面 60 → 实盘 58
  ok(e.type === 'stock_take' && e.delta === -2 && e.before === 60 && e.after === 58, '盘点 60→58，差异 -2 入流水');
  ok(Mall.getProduct('6921168509256').stock === 58, '盘点后库存=实盘 58');
}
{
  const e = Admin.stockTake('6901234567892', 120, '店主');  // 一致
  ok(e.delta === 0 && e.reason === '盘点一致', '盘点一致：delta=0，原因=盘点一致');
  ok(Mall.getProduct('6901234567892').stock === 120, '盘点一致不改库存');
}
throws(() => Admin.stockTake('6901234567892', -1, '店主'), '实盘为负 → 拦截');

// ============ ③ 4 人配送分配 ============
section('③ 配送员分配');
fresh();
ok(Admin.getCouriers().join() === '老张,小李,阿强,小美', '默认 4 人配送名单');
{
  Admin.setCouriers(['阿强', '小美']);
  ok(Admin.getCouriers().length === 2, '自定义名单生效');
  Admin.setCouriers(Admin.DEFAULT_COURIERS);
}
Mall.addToCart('6901001100113', 2);
const oD = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '张三', phone: '13800000000', address: '幸福路1号' } });
{
  const o = Admin.setCourier(oD.id, '小李');
  ok(o.status === 'delivering' && o.courier === '小李', '配送订单分配小李：pending→delivering 并挂名');
  ok(Mall.getOrders()[0].status === 'delivering', '订单状态已持久化');
  const o2 = Admin.setCourier(oD.id, '阿强');
  ok(o2.courier === '阿强', '配送中可改派阿强');
}
Mall.addToCart('6907992751797', 1);
const oP = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '李四', phone: '13900000000' } });
throws(() => Admin.setCourier(oP.id, '老张'), '自提订单分配配送员 → 拦截');
throws(() => Admin.setCourier(oD.id, '路人甲'), '不在名单中的配送员 → 拦截');
{
  const o = Mall.advanceOrder(oD.id, 'done');
  ok(o.status === 'done', '配送完成后状态=已完成');
}

// ============ ④ 顾客聚合 ============
section('④ 顾客聚合与备注');
fresh();
Mall.addToCart('6901234567892', 2);   // 2×2.5=5
Mall.createOrder({ deliveryType: 'pickup', customer: { name: '张三', phone: '13800000000' } });
Mall.addToCart('6901001100113', 1);   // 6
Mall.createOrder({ deliveryType: 'delivery', customer: { name: '张三', phone: '13800000000', address: '幸福路1号' } });
Mall.addToCart('6907992751797', 4);   // 4×3.5=14
Mall.createOrder({ deliveryType: 'pickup', customer: { name: '王五', phone: '13700000000' } });
{
  const cs = Admin.getCustomers();
  ok(cs.length === 2, '2 位顾客（张三/王五）');
  const z = cs.find(c => c.phone === '13800000000');
  ok(z.orderCount === 2 && Math.abs(z.totalSpent - 14) < 1e-6, '同号合并：2 单、累计消费 14（5 + 配送 6+3）');
  const w = cs.find(c => c.phone === '13700000000');
  ok(w.orderCount === 1 && Math.abs(w.totalSpent - 14) < 1e-6, '王五：1 单、消费 14 元');
  ok(cs[0].lastOrderAt >= cs[1].lastOrderAt, '按最近下单时间倒序');
}
Admin.setCustomerNote('13800000000', '每周三自提，喜欢可乐', '熟客');
{
  const z = Admin.getCustomers().find(c => c.phone === '13800000000');
  ok(z.note.indexOf('每周三') === 0 && z.tag === '熟客', '备注/标签已挂到顾客档案');
}
Admin.setCustomerNote('13800000000', undefined, 'VIP');
ok(Admin.getCustomers().find(c => c.phone === '13800000000').tag === 'VIP', '标签可更新为 VIP');
ok(Admin.getCustomers().find(c => c.phone === '13700000000').tag === '', '其他顾客无标签');

// ============ ⑤ 取消订单不计顾客消费 ============
section('⑤ 取消订单不计消费');
fresh();
Mall.addToCart('6901234567892', 1);
const oC = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '赵六', phone: '13600000000' } });
ok(Admin.getCustomers().find(c => c.phone === '13600000000').totalSpent === 2.5, '未取消时消费 2.5');
Mall.cancelOrder(oC.id);
ok(Admin.getCustomers().find(c => c.phone === '13600000000').orderCount === 0
  && Admin.getCustomers().find(c => c.phone === '13600000000').totalSpent === 0, '取消后订单数/消费归零');

// ============ ⑥ 商品档案（建档 / 编辑 / 删除） ============
section('⑥ 商品档案（建档 / 编辑 / 删除）');
fresh();
{
  const p = Admin.saveProduct({
    code: ' 6901111111111 ', name: ' 农夫山泉 550ml ', brand: '农夫山泉', spec: '550ml',
    category: '饮料', unit: '瓶', costPrice: 1.1, salePrice: 1.7, refPrice: 1.8, stock: 24
  });
  ok(p.code === '6901111111111', '建档：条码去空格归一化');
  ok(p.name === '农夫山泉 550ml' && p.unit === '瓶' && p.category === '饮料', '建档：名称去空格，单位/分类落库');
  ok(p.stock === 24, '建档：初始库存 24（只累加一次，不重复）');
  const log = Admin.getStockLog();
  ok(log.length === 2 && log[0].type === 'stock_in' && log[1].type === 'product_new', '建档留 2 条流水：初始库存入库 + 建档');
  ok(log[0].code === p.code && log[0].before === 0 && log[0].after === 24, '初始库存流水 0→24');
  ok(log[1].delta === 0 && log[1].reason === '建档', '建档流水 delta=0、原因为建档');
}
{
  // 默认值与缺省：不填单位/分类走默认
  const p = Admin.saveProduct({ code: '6902222222222', name: '散装花生', salePrice: 8 });
  ok(p.unit === Admin.DEFAULT_UNIT && p.category === Admin.DEFAULT_CATEGORY, '缺省单位/分类 → 件 / 未分类');
  ok(p.stock === 0, '不填初始库存 → 0，且不产生 stock_in 流水');
  Admin.deleteProduct('6902222222222');
}
{
  const bad = [
    [{ name: 'x', salePrice: 1 }, '条码'],
    [{ code: 'a b', name: 'x', salePrice: 1 }, '条码'],
    [{ code: '6901x', salePrice: 1 }, '商品名称'],
    [{ code: '6901x', name: '   ', salePrice: 1 }, '商品名称'],
    [{ code: '6901x', name: 'x', salePrice: 0 }, '售价必须大于 0'],
    [{ code: '6901x', name: 'x', salePrice: -1 }, '不能为负数'],
    [{ code: '6901x', name: 'x', salePrice: 1, costPrice: 'abc' }, '进价必须是数字'],
    [{ code: '6901x', name: 'x', salePrice: 1, stock: 1.5 }, '整数'],
    [{ code: '6901x', name: 'x', salePrice: 3.9, refPrice: 4 }, '比价防线']
  ];
  bad.forEach(([input, kw]) => {
    const r = Admin.validateProduct(input);
    ok(!r.ok && r.msg.indexOf(kw) >= 0, '拦截非法入参「' + kw + '」→ ' + r.msg);
  });
  const longName = Admin.validateProduct({ code: '6901x', name: new Array(42).join('长'), salePrice: 1 });
  ok(!longName.ok && longName.msg.indexOf('40') >= 0, '名称超长（>40 字）拦截');
}
{
  ok(Admin.validateProduct({ code: '6901x', name: 'x', salePrice: 1, refPrice: 2, isWholesale: true }).ok, '批发商品豁免比价防线');
  ok(Admin.validateProduct({ code: '6901x', name: 'x', salePrice: 99 }).ok, '无参考价 → 放行');
  ok(Admin.validateProduct({ code: '6901x', name: 'x', salePrice: 1.9, refPrice: 2 }).ok, '恰好压线 1.90 ≤ 2×0.95 → 放行');
  const over = Admin.validateProduct({ code: '6901x', name: 'x', salePrice: 1.91, refPrice: 2 });
  ok(!over.ok && over.msg.indexOf('1.9') >= 0, '超 1 分（1.91 > 1.90）也拦');
}
{
  const before = Mall.getProduct('6901111111111');
  Admin.stockIn('6901111111111', 6, '测试入库', '店主');   // 24 → 30
  const p = Admin.saveProduct({ code: '6901111111111', name: '农夫山泉 550ml×2', salePrice: 1.5, refPrice: 1.8, category: '饮料', unit: '瓶' });
  ok(p.stock === 30, '编辑档案不改库存（30 不变）');
  ok(p.name === '农夫山泉 550ml×2' && p.salePrice === 1.5, '编辑生效：名称/售价已更新');
  ok(p.createdAt === before.createdAt, '编辑保留建档时间');
  const log = Admin.getStockLog();
  ok(log[0].type === 'product_edit' && log[0].delta === 0 && log[0].by === '店主', '编辑留流水（product_edit / delta=0 / 操作人）');
}
throws(() => Admin.saveProduct({ code: '6901111111111', name: '重复建档', salePrice: 1.2 }, { requireNew: true }), '已存在条码 + requireNew → 拦截');
{
  const kwHit = Admin.listProducts({ keyword: '农夫' });
  ok(kwHit.length === 2 && kwHit.some(p => p.code === '6901111111111') && kwHit.some(p => p.code === '6902083881234'),
    '关键词搜索（名称/品牌）命中种子农夫山泉 + 新建商品');
  ok(Admin.listProducts({ keyword: '6901111111111' }).length === 1, '关键词搜索（条码）命中 1 条');
  ok(Admin.listProducts({ keyword: '不存在的东西' }).length === 0, '关键词无命中 → 空表');
  ok(Admin.listProducts({ category: '饮料' }).length === 3, '按分类筛选（种子 2 + 新建 1）');
  ok(Admin.categories().length === 5, '分类清单去重（5 个）');
  ok(Admin.categories().indexOf('饮料') >= 0, '分类清单含饮料');
  const st = Admin.productStats();
  ok(st.total === 7 && st.pending === 2, '统计：7 个商品、2 个待同步');
  ok(st.noRef === 6, '统计：6 个无参考价（仅新建商品有）');
  const d = Admin.draftFrom(Mall.getProduct('6902083881234'));
  ok(d.code === '6902083881234' && d.name === '农夫山泉', '编辑表单初值来自商品档案');
  ok(!('stock' in d), '编辑表单初值不含库存（表单不改库存）');
}
throws(() => Admin.deleteProduct('6901111111111'), '库存非 0 → 拒绝删除（提示先盘点为 0）');
throws(() => Admin.deleteProduct('9999999999999'), '删除不存在的商品 → 拦截');
{
  Admin.stockTake('6901111111111', 5, '店主');
  Mall.addToCart('6901111111111', 1);
  const o = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '张三', phone: '13800000000' } });
  Admin.stockTake('6901111111111', 0, '店主');    // 库存已 0，但订单进行中
  try {
    Admin.deleteProduct('6901111111111');
    ok(false, '有进行中订单引用 → 应拒绝删除');
  } catch (e) {
    ok(e.message.indexOf('进行中') >= 0, '进行中订单引用 → 拒绝删除（' + e.message + '）');
  }
  Mall.advanceOrder(o.id, 'ready');
  Mall.advanceOrder(o.id, 'done');
  const del = Admin.deleteProduct('6901111111111', '店主');
  ok(del.code === '6901111111111' && !Mall.getProduct('6901111111111'), '订单完成后库存 0 可删除');
  ok(Admin.listProducts({}).length === 6, '删除后商品数回到 6');
  ok(Admin.getStockLog()[0].type === 'product_del', '删除留流水（product_del）');
}

// ============ ⑦ 小票 / 配送单（任务池第 2 项） ============
section('⑦ 小票 / 配送单');
fresh();
{
  const st = Admin.getStoreInfo();
  ok(st.name === Admin.DEFAULT_STORE.name && st.footer === Admin.DEFAULT_STORE.footer, '门店抬头有默认值（' + st.name + '）');
  const s2 = Admin.setStoreInfo({ name: '  小邻里超市  ', phone: ' 13800000000 ', address: '幸福路 1 号', footer: '' });
  ok(s2.name === '小邻里超市' && s2.phone === '13800000000', '抬头保存前 trim 空格');
  ok(s2.footer === Admin.DEFAULT_STORE.footer, '票尾留空回落到默认文案');
  ok(Admin.getStoreInfo().name === '小邻里超市', '抬头已持久化，下次打票生效');
  throws(() => Admin.setStoreInfo({ name: '   ' }), '店名为空 → 拦截');
  throws(() => Admin.setStoreInfo({ name: '一二三四五六七八九十一二三四五六七八九十一' }), '店名超 20 字 → 拦截');
}
{
  Mall.addToCart('6901234567892', 2);   // 2.50 × 2
  Mall.addToCart('6921168509256', 1);   // 4.50 × 1
  const o = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '张三', phone: '13800000000', address: '幸福路1号' } });
  const r = Admin.buildReceipt(o, { store: Admin.getStoreInfo() });
  ok(r.title === '配送小票' && r.isPickup === false, '配送单标题=配送小票');
  ok(r.orderNo === o.id && r.customer.phone === '13800000000' && r.customer.address === '幸福路1号', '单号/电话/地址带出');
  ok(r.count === 3 && r.items.length === 2, '件数按 qty 求和（3 件 / 2 行）');
  ok(r.items[0].amount === 5 && r.items[1].amount === 4.5, '行金额 = 单价 × 数量（2.50×2=5.00）');
  ok(r.subtotal === 9.5 && r.deliveryFee === Mall.calcDeliveryFee('delivery', 9.5) && r.total === 12.5, '小计 9.50 ＋ 配送 3.00 ＝ 应收 12.50');
  ok(Mall.calcDeliveryFee('delivery', 30) === 0, '满 30 免配送费（规则同源）');
  ok(r.storeName === '小邻里超市' && r.statusLabel === '待备货', '抬头与订单状态带出（' + r.statusLabel + '）');
  ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(r.time), '时间格式 YYYY-MM-DD HH:MM（' + r.time + '）');
  ok(r.text.indexOf('单号：' + o.id) >= 0 && r.text.indexOf('应收：¥12.50') >= 0, '纯文本小票含单号与应收');
  ok(r.text.indexOf('配送费：¥3.00') >= 0 && r.text.indexOf('方式：配送到家') >= 0, '纯文本含配送费与配送方式');
  ok(r.text.split('\n').length >= 16, '纯文本小票分行完整（' + r.text.split('\n').length + ' 行）');
}
{
  Mall.addToCart('6902083881234', 1);   // 1.80 × 1
  const o2 = Mall.createOrder({ deliveryType: 'pickup', customer: { name: '李四', phone: '13900000000' } });
  const r2 = Admin.buildReceipt(o2);
  ok(r2.title === '自提小票' && r2.text.indexOf('方式：到店自提') >= 0, '自提单标题与方式正确');
  ok(r2.deliveryFee === 0 && r2.text.indexOf('配送费') < 0, '自提不打印配送费行');
  ok(r2.storeName === Admin.DEFAULT_STORE.name, '不传 store 时用默认抬头');
  ok(r2.courier === '', '自提单不出现配送员');
  Mall.cancelOrder(o2.id);
  const r3 = Admin.buildReceipt(Mall.getOrders().find(x => x.id === o2.id));
  ok(r3.cancelled === true && r3.text.indexOf('（作废）') >= 0, '已取消订单在票面标注作废');
  throws(() => Admin.buildReceipt({}), '无单号 → 拦截（订单不存在）');
}

section('⑧ 销售报表 / 日报（D19）');
{
  const NOW = new Date('2026-10-10T20:00:00').getTime();
  const ts = s => new Date(s).getTime();
  const od = (id, at, extra) => Object.assign({
    id: id, createdAt: at, status: 'done', deliveryType: 'pickup',
    items: [], subtotal: 0, deliveryFee: 0, total: 0,
    customer: { name: '测试', phone: '13800000000', address: '' }
  }, extra);
  const cola = { code: '6902083881234', name: '可口可乐', spec: '330ml', unit: '罐', price: 1.8, qty: 11 };
  const water = { code: '6921168509256', name: '农夫山泉', spec: '550ml', unit: '瓶', price: 12.9, qty: 1 };
  const salt = { code: '6901234567890', name: '加碘盐', spec: '400g', unit: '袋', price: 1.8, qty: 1 };

  const A = od('A', ts('2026-10-10T12:00:00'), { status: 'done', deliveryType: 'delivery', items: [cola, water], subtotal: 32.7, deliveryFee: 3, total: 35.7 });
  const B = od('B', ts('2026-10-10T09:00:00'), { status: 'pending', items: [salt], subtotal: 1.8, total: 1.8 });
  const C = od('C', ts('2026-10-10T08:00:00'), { status: 'cancelled', items: [cola], subtotal: 9, total: 9 });
  const D = od('D', ts('2026-10-09T10:00:00'), { status: 'done', items: [water], subtotal: 12.9, total: 12.9 });
  const list = [A, B, C, D];

  ok(Admin.REPORT_RANGES.length === 6 && Admin.REPORT_RANGES[0][0] === 'today', '六个区间且首项为今天');
  ok(Admin.dayKey(ts('2026-01-05T08:00:00')) === '2026-01-05', 'dayKey 补零为 YYYY-MM-DD');

  const r7 = Admin.rangeOf('7d', NOW, list);
  ok(r7.count === 7 && r7.from === '2026-10-04' && r7.to === '2026-10-10', '近 7 天含首尾共 7 格');
  const rm = Admin.rangeOf('month', NOW, list);
  ok(rm.count === 10 && rm.from === '2026-10-01', '本月从 1 号到今天共 10 格');
  const rall = Admin.rangeOf('all', NOW, list);
  ok(rall.from === '2026-10-09' && rall.count === 2, '全部区间以最早一单那天为起点');
  ok(Admin.rangeOf('bogus', NOW, list).key === 'today', '未知区间回落今天');

  const t = Admin.buildReport(list, 'today', NOW);
  ok(t.count === 2 && t.revenue === 37.5, '今天：2 单 ¥37.50（取消单不计）');
  ok(t.goods === 34.5 && t.deliveryFee === 3, '商品金额 ¥34.50、配送费 ¥3.00 分开统计');
  ok(t.avgOrder === 18.75, '客单价 = 营业额 ÷ 单量 = ¥18.75');
  ok(t.doneAmount === 35.7 && t.openAmount === 1.8, '已交付 ¥35.70 / 未交付 ¥1.80');
  ok(t.byStatus.pending === 1 && t.byStatus.done === 1 && t.byStatus.cancelled === 1, '状态分布单独给出取消数');
  ok(t.items === 13 && t.skuCount === 3, '售出 13 件 / 3 个商品');
  ok(t.top[0].code === '6902083881234' && t.top[0].qty === 11, '热销榜第一按件数排序');
  ok(t.top[1].name === '农夫山泉' && t.top[2].name === '加碘盐', '件数相同按金额降序（水 ¥12.90 在盐 ¥1.80 之前）');
  ok(t.top[0].pct === 84.6, '占比 = 件数占比（11/13 = 84.6%）');
  ok(t.top[0].amount === 19.8, '热销金额 = 单价 × 件数');
  ok(t.top.every(x => x.name !== ''), '热销榜条目都带商品名');
  ok(t.pickup.count === 1 && t.pickup.amount === 1.8 && t.delivery.count === 1 && t.delivery.amount === 35.7, '自提 / 配送单量与金额拆分');
  const d10 = t.daily.find(d => d.date === '2026-10-10');
  ok(d10.count === 2 && d10.revenue === 37.5 && d10.cancelled === 1, '当日格子：2 单 ¥37.50 + 取消 1 单');
  ok(t.daily.length === 1 && t.maxDaily === 37.5, '今天区间只有一格，峰值 = 当日营业额');

  ok(t.delta.revenue === 190.7, '营业额环比对照等长的上一区间（¥37.50 vs ¥12.90 → +190.7%）');
  ok(t.delta.count === 100 && t.delta.avgOrder === 45.3, '单量 +100.0% / 客单价 +45.3%');

  const r7rep = Admin.buildReport(list, '7d', NOW);
  ok(r7rep.count === 3 && r7rep.revenue === 50.4, '近 7 天：3 单 ¥50.40（含 10-09 那一单）');
  ok(r7rep.top[0].qty === 11 && r7rep.top[1].qty === 2, '跨天热销累加同商品件数（水 1+1=2）');
  ok(r7rep.daily.filter(d => d.revenue === 0).length === 5, '近 7 天有 5 个零单日');
  const z = r7rep.daily.find(d => d.date === '2026-10-08');
  ok(z && z.count === 0 && z.revenue === 0, '零单日照样占格且各项为 0');
  ok(Admin.buildReport(list, 'all', NOW).delta === undefined, '全部区间不做环比');

  const empty = Admin.buildReport([], 'today', NOW);
  ok(empty.count === 0 && empty.revenue === 0 && empty.avgOrder === 0 && empty.top.length === 0, '零单区间各项为 0 且不崩');
  ok(empty.maxDaily === 0 && empty.daily.length === 1, '零单时峰值 0，今天仍占 1 格');

  Mall._save(Mall.KEYS.orders, list);
  ok(Admin.buildReport(Mall.getOrders(), 'today', NOW).count === 2, '接 Mall.getOrders() 数据源口径一致');

  const txt = Admin.reportText(t, { store: { name: '家庭超市' }, now: NOW });
  ok(txt.indexOf('家庭超市 · 销售日报') === 0, '日报抬头用门店名');
  ok(txt.indexOf('单量：2 单（另有取消 1 单）') >= 0, '日报含单量与取消数');
  ok(txt.indexOf('营业额：¥37.50（下单口径，不含取消）') >= 0, '日报标注营业额口径');
  ok(txt.indexOf('客单价：¥18.75') >= 0 && txt.indexOf('商品金额：¥34.50 · 配送费：¥3.00') >= 0, '日报含客单价与金额拆分');
  ok(txt.indexOf('已完成：¥35.70 · 进行中：¥1.80') >= 0, '日报区分已交付 / 未交付');
  ok(txt.indexOf('自提 1 单 · 配送 1 单') >= 0, '日报含自提 / 配送单量');
  ok(txt.indexOf('热销 TOP 3') >= 0 && txt.indexOf('占 84.6%') >= 0, '日报含热销 TOP 与占比');
  ok(txt.indexOf('环比：营业额 +190.7% · 单量 +100.0%') >= 0, '日报含环比');
  ok(/生成时间：2026-10-\d\d \d\d:\d\d/.test(txt), '日报末尾含生成时间');
  ok(txt.split('\n').every(l => l.length <= 34), '日报每行不超过 34 字（32 字宽热敏纸可打）');
  ok(Admin.reportText(empty, { store: { name: '家庭超市' }, now: NOW }).indexOf('热销') < 0, '零单日报不打印热销段');
}

// ============ ⑨ 批量改价 / 批量操作（任务池第 5 项，D20） ============
section('⑨ 批量改价 / 批量操作（D20）');
fresh();
{
  Admin.saveProduct({ code:'B1', name:'批量测试1', category:'饮料', unit:'瓶', costPrice:6, salePrice:9, refPrice:10, isWholesale:false, stock:12 }, { by:'老板' });
  Admin.saveProduct({ code:'B2', name:'批量测试2', category:'饮料', unit:'瓶', costPrice:14, salePrice:20, refPrice:10, isWholesale:true, stock:3 }, { by:'老板' });
  Admin.saveProduct({ code:'B3', name:'批量测试3', category:'未分类', unit:'件', costPrice:5, salePrice:7, refPrice:0, isWholesale:false, stock:30 }, { by:'老板' });
  Admin.saveProduct({ code:'B4', name:'批量测试4', category:'纸品', unit:'提', costPrice:3, salePrice:5, refPrice:100, isWholesale:false, stock:8 }, { by:'老板' });
  const shop = ['B1','B2','B3','B4'].map(c => Mall.getProduct(c));
  ok(shop.length === 4 && shop.every(Boolean) && shop[0].salePrice === 9, '造 4 款商品（超防线 / 批发 / 缺参考价 / 高参考价）');

  ok(Admin.roundStep(3.33, 0.5) === 3.5 && Admin.roundStep(3.24, 0.1) === 3.2 && Admin.roundStep(7.4, 1) === 7, 'roundStep 按步长四舍五入');
  ok(Admin.bulkNewPrice({ salePrice:9 }, { mode:'pct', value:20, step:0.01 }) === 10.8, '按比例 +20%：9.00 → 10.80');
  ok(Admin.bulkNewPrice({ salePrice:9 }, { mode:'delta', value:1, step:0.01 }) === 10, '按金额 +1：9.00 → 10.00');
  ok(Admin.bulkNewPrice({ salePrice:9 }, { mode:'set', value:8.88, step:0.5 }) === 9, '统一设为 8.88 取整到 5 角 → 9.00');
  throws(() => Admin.bulkNewPrice({ salePrice:9 }, { mode:'nope', value:1 }), '未知调整方式抛错');
  ok(Admin.ruleLabel({ mode:'pct', value:10, step:1 }) === '批量改价：+10%，取整到 1 元', '规则写成「人话」进流水 reason');
  ok(Admin.ruleLabel({ mode:'nope' }) === '批量改价', '未知规则回落「批量改价」');
  ok(Admin.BULK_MODES.length === 3 && Admin.BULK_ROUNDS.length === 4, '三种调整方式 / 四档取整');

  const rule20 = { mode:'pct', value:20, step:0.01 };
  const rows = Admin.bulkPlan(shop, rule20);
  ok(rows.length === 4 && rows[0].status === 'capped' && rows[0].cap === 9.5, 'B1 10.80 超防线 9.50 → capped 并给出顶格价');
  ok(rows[1].status === 'change' && rows[1].newPrice === 24 && rows[1].msg.indexOf('批发') >= 0, 'B2 批发商品跳过比价检查 → 可改 24.00');
  ok(rows[2].status === 'change' && rows[2].newPrice === 8.4 && rows[2].msg.indexOf('缺') >= 0, 'B3 缺牵牛花参考价 → 跳过检查可改 8.40');
  ok(rows[3].status === 'change' && rows[3].newPrice === 6, 'B4 参考价高 → 6.00 合规');
  ok(rows[0].delta === 1.8 && rows[3].delta === 1, '预览给出涨跌差值');
  const s20 = Admin.bulkSummary(rows);
  ok(s20.total === 4 && s20.change === 3 && s20.capped === 1 && s20.up === 3, 'summary：4 款 / 可改 3 / 超防线 1 / 全为涨价');

  const caps = Admin.bulkPlan(shop, rule20, { useCaps: { B1: 1 } });
  ok(caps[0].status === 'change' && caps[0].newPrice === 9.5 && caps[0].msg.indexOf('顶格') >= 0, '按防线顶格：B1 改用 9.50 并标「顶格」');
  ok(Admin.bulkPlan(shop, rule20, { useCaps: { B2: 1 } })[0].status === 'capped', 'useCaps 只对超线行起作用');
  ok(Admin.bulkPlan(shop, { mode:'pct', value:0, step:0.01 }).every(r => r.status === 'same'), '价格未变 → same（不写流水）');
  ok(Admin.bulkPlan(shop, { mode:'set', value:0, step:0.01 })[0].status === 'blocked', '新价 0 → blocked');
  ok(Admin.bulkPlan([{ code:'X', name:'X', salePrice:1, refPrice:1 }], { mode:'delta', value:-5, step:0.01 })[0].status === 'blocked', '新价为负 → blocked');

  const logBefore = Admin.getStockLog().length;
  const res = Admin.applyBulkPlan(rows, { rule: rule20, by: '老板' });
  ok(res.changed === 3 && res.rows.length === 3 && res.failed.length === 0, '只写入 change 行（B2 批发 / B3 缺参考价 / B4 合规）；超防线的 B1 不写');
  ok(Mall.getProduct('B2').salePrice === 24 && Mall.getProduct('B3').salePrice === 8.4, '新售价已落库');
  ok(Mall.getProduct('B1').salePrice === 9, '超防线那款价格没被动');
  ok(Mall.getProduct('B2').stock === 3 && Mall.getProduct('B3').stock === 30, '库存一律不动（D16）');
  ok(Mall.getProduct('B1').category === '饮料' && Mall.getProduct('B4').category === '纸品', '规则未涉及的字段保持原值');
  const ev = Admin.getStockLog().filter(e => e.type === 'product_edit' && e.reason === '批量改价：+20%');
  ok(ev.length === 3 && ev[0].delta === 0 && ev[0].by === '老板', '每款写一条 product_edit 流水，reason 记规则原文');
  ok(Admin.getStockLog().length === logBefore + 3, '流水只增 3 条（超防线那款不写）');
  const res2 = Admin.applyBulkPlan(rows, { rule: rule20, by: '老板' });
  ok(res2.changed === 0 && res2.noop === 3, '同一批再应用一次：现价已等于目标价 → 跳过且不写流水');
  ok(Admin.getStockLog().length === logBefore + 3, '重复应用不再增流水');

  const stale = Admin.bulkPlan([{ code:'B2', name:'批量测试2', salePrice:24, refPrice:10, isWholesale:true, category:'饮料' }], { mode:'delta', value:1, step:0.01 });
  Admin.applyBulkField(['B2'], 'category', '酒水', { by:'老板' });
  const res3 = Admin.applyBulkPlan(stale, { rule:{ mode:'delta', value:1, step:0.01 }, by:'老板' });
  ok(res3.changed === 1 && Mall.getProduct('B2').salePrice === 25, '过期快照仍能按目标价改价');
  ok(Mall.getProduct('B2').category === '酒水', '写入时重读当前商品，不把旧分类覆盖回去');

  const r4 = Admin.applyBulkField(['B1','B3','NOPE'], 'category', ' 冲调 ', { by:'老板' });
  ok(r4.changed === 2 && r4.failed.length === 1 && r4.failed[0].code === 'NOPE', '批量改分类：成功 2 / 不存在的 1（不中断整批）');
  ok(Mall.getProduct('B1').category === '冲调' && Mall.getProduct('B3').category === '冲调', '分类名 trim 后落库');
  ok(Mall.getProduct('B1').stock === 12, '批量改分类不动库存');
  throws(() => Admin.applyBulkField(['B1'], 'category', '   '), '空分类被拦');
  throws(() => Admin.applyBulkField(['B1'], 'img', 'x'), '不支持的批量字段抛错');
  const r5 = Admin.applyBulkField(['B1','B4'], 'isWholesale', true, { by:'老板' });
  ok(r5.changed === 2 && Mall.getProduct('B1').isWholesale === true, '批量设为批发生效');
  const r6 = Admin.applyBulkField(['B1'], 'isWholesale', false, { by:'老板' });
  ok(r6.changed === 1 && !Mall.getProduct('B1').isWholesale, '批量取消批发生效');
  ok(Admin.getStockLog().filter(e => e.reason === '批量改批发标记：取消批发').length === 1, '批发标记改动也写流水');
  const r7 = Admin.applyBulkField(['B2'], 'isWholesale', false, { by:'老板' });
  ok(r7.changed === 0 && r7.failed.length === 1 && r7.failed[0].msg.indexOf('取消批发后') === 0, '售价超防线时取消批发被拦（' + r7.failed[0].msg.slice(0, 22) + '…）');
  ok(Mall.getProduct('B2').isWholesale === true, '被拦的批发标记保持原样（绝不静默改价）');
}

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

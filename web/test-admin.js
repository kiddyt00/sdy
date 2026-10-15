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
  const s2 = Admin.setStoreInfo({ name: '  啥都有快送  ', phone: ' 13800000000 ', address: '幸福路 1 号', footer: '' });
  ok(s2.name === '啥都有快送' && s2.phone === '13800000000', '抬头保存前 trim 空格');
  ok(s2.footer === Admin.DEFAULT_STORE.footer, '票尾留空回落到默认文案');
  ok(Admin.getStoreInfo().name === '啥都有快送', '抬头已持久化，下次打票生效');
  throws(() => Admin.setStoreInfo({ name: '   ' }), '店名为空 → 拦截');
  throws(() => Admin.setStoreInfo({ name: '一二三四五六七八九十一二三四五六七八九十一' }), '店名超 20 字 → 拦截');
}
{
  Mall.addToCart('6901234567892', 2);   // 2.50 × 2
  Mall.addToCart('6921168509256', 1);   // 4.50 × 1
  const o = Mall.createOrder({ deliveryType: 'delivery', customer: { name: '张三', phone: '13800000000', address: '幸福路1号' } });
  o.paid = true;   // 支付轮（支付）：小票印的是「待备货」的单，显式标已收款
  const r = Admin.buildReceipt(o, { store: Admin.getStoreInfo() });
  ok(r.title === '配送小票' && r.isPickup === false, '配送单标题=配送小票');
  ok(r.orderNo === o.id && r.customer.phone === '13800000000' && r.customer.address === '幸福路1号', '单号/电话/地址带出');
  ok(r.count === 3 && r.items.length === 2, '件数按 qty 求和（3 件 / 2 行）');
  ok(r.items[0].amount === 5 && r.items[1].amount === 4.5, '行金额 = 单价 × 数量（2.50×2=5.00）');
  ok(r.subtotal === 9.5 && r.deliveryFee === Mall.calcDeliveryFee('delivery', 9.5) && r.total === 12.5, '小计 9.50 ＋ 配送 3.00 ＝ 应收 12.50');
  ok(Mall.calcDeliveryFee('delivery', 30) === 0, '满 30 免配送费（规则同源）');
  ok(r.storeName === '啥都有快送' && r.statusLabel === '待备货', '抬头与订单状态带出（' + r.statusLabel + '）');
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

// ============ ⑩ 商品图片与上下架（任务池⑥ / D23） ============
section('⑩ 商品图片与上下架（D23）');
fresh();
{
  const a = Admin.saveProduct({ code: '6903333333333', name: '测试图商品', salePrice: 5, img: ' https://cdn.example.com/a.jpg ' });
  ok(a.img === 'https://cdn.example.com/a.jpg', '建档：图片地址两端空格裁掉');
  const b = Admin.saveProduct({ code: '6903333333334', name: '无图商品', salePrice: 5 });
  ok(b.img === '', '建档：不填图片 → 空串（顾客端回退分类图标）');
  Mall.updateProduct('6903333333333', { onSale: false });
  const edited = Admin.saveProduct({ code: '6903333333333', name: '测试图商品（改名）', salePrice: 5.5, img: 'https://cdn.example.com/b.jpg' });
  ok(edited.name === '测试图商品（改名）' && edited.img === 'https://cdn.example.com/b.jpg', '编辑：改名与换图都生效');
  ok(edited.onSale === false, '编辑档案不把下架商品偷偷上架（D23）');
  ok(edited.stock === a.stock, '编辑档案不动库存（不变量①）');
  const r = Admin.applyBulkField(['6903333333333'], 'category', '日用', { by: '老板' });
  const after = Mall.getProduct('6903333333333');
  ok(r.changed === 1 && after.category === '日用', '批量改分类生效');
  ok(after.img === 'https://cdn.example.com/b.jpg' && after.onSale === false && after.stock === a.stock, '批量改分类不动图片 / 上下架 / 库存');
  Admin.deleteProduct('6903333333334');
  Admin.deleteProduct('6903333333333');
  ok(!Mall.getProduct('6903333333333'), '清理测试商品完成');
}

// ============ ⑪ 库存审计 / 配送员 / 顾客备注落库（D25） ============
section('⑪ 落库审计（D25）');
fresh();
{
  // 流水字段与服务端对齐：kind / at 是新字段，type / ts 老数据仍在（页面只读 kind/at）
  const e = Admin.adjustStock('6901234567892', 2, '整箱到货', '老板');
  ok(e.kind === 'adjust' && e.type === 'adjust', '流水同时写 kind（服务端口径）与 type（老数据兼容）');
  ok(typeof e.at === 'number' && e.at > 0 && e.ts === e.at, '流水带 at 毫秒时间戳（渲染用 when(at||ts)）');
  ok(Admin.getStockLog(1).length === 1, 'getStockLog(limit) 只取最近 N 条');
}
{
  // 服务端流水镜像：对齐本地库存 + 记流水；同一条（按 id）幂等
  const before = Mall.getProduct('6901234567892').stock;
  const entry = {
    id: 991, at: Date.now(), ts: '2026-10-12T10:00:00+08:00', kind: 'stock_in',
    code: '6901234567892', name: '可口可乐 330ml', unit: '罐',
    delta: 30, before: before, after: before + 30, reason: '整箱到货', by: '老板'
  };
  const n0 = Admin.getStockLog().length;
  Admin.recordStockEntry(entry);
  ok(Mall.getProduct('6901234567892').stock === before + 30, '镜像服务端流水：本地库存对齐 after');
  ok(Admin.getStockLog().length === n0 + 1 && Admin.getStockLog()[0].id === 991, '镜像确实记了一条流水');
  Admin.recordStockEntry(entry);
  ok(Admin.getStockLog().length === n0 + 1, '同一条服务端流水重复镜像不重复记（按 id 幂等）');
  throws(() => Admin.recordStockEntry({ delta: 1 }), '流水缺少商品编码 → 拦截');
}
{
  // 配送员增删与约束（离线只维护姓名清单；手机号要有后端才存得住）
  const n0 = Admin.getCouriers().length;
  Admin.saveCourier('阿明', '13900009999');
  ok(Admin.getCouriers().length === n0 + 1 && Admin.getCouriers().indexOf('阿明') >= 0, '新增配送员');
  Admin.saveCourier('阿明', '');
  ok(Admin.getCouriers().length === n0 + 1, '重复新增不产生重名');
  throws(() => Admin.saveCourier('  ', ''), '空姓名 → 拦截');
  throws(() => Admin.saveCourier('一二三四五六七八九十一二三', ''), '姓名超 12 字 → 拦截');
  throws(() => Admin.saveCourier('查无此人', '', true), '删除不存在的配送员 → 拦截');
  Admin.saveCourier('阿明', '', true);
  ok(Admin.getCouriers().length === n0, '删除配送员');
  while (Admin.getCouriers().length > 1) Admin.saveCourier(Admin.getCouriers()[0], '', true);
  throws(() => Admin.saveCourier(Admin.getCouriers()[0], '', true), '只剩一位时不许再删（没有配送员就没法派单）');
  Admin.setCouriers(Admin.DEFAULT_COURIERS);
  ok(Admin.getCouriers().length === 4, '恢复默认 4 人名单');
}
{
  // 顾客备注：只登记过备注（没下过单、仍是零售）的顾客也要进档案
  Admin.setCustomerNote('13500001111', '只在微信订过货', '熟客');
  const c = Admin.getCustomers().find(x => x.phone === '13500001111');
  ok(!!c && c.tag === '熟客' && c.tier === 'retail' && c.orderCount === 0, '只登记备注的顾客也进档案（零售、0 单）');
  const saved = Admin.setCustomerNote('13500001111', undefined, 'VIP');
  ok(saved.tag === 'VIP' && saved.tags === 'VIP', '标签同时写 tag 与 tags（与服务端字段对齐）');
}

{
  // 回归（第 20 轮生产 CDP 发现的缺陷）：浏览器里顶层 const 不会成为 window 的属性，
  // 而 sdy-api.js 的 resolveAdmin() 靠它做本地库存镜像 —— mall-admin.js 必须显式挂到 window.Admin，
  // 否则在线改库存时「服务端改了、页面没改」，且 Node 测试注入 cfg.admin 会把这个坑掩盖掉。
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const savedWin = global.window;
  const p = require.resolve('./mall-admin.js');
  const cached = require.cache[p];
  delete require.cache[p];
  global.window = {};
  const reloaded = require('./mall-admin.js');
  ok(global.window.Admin === reloaded && typeof reloaded.recordStockEntry === 'function',
     'mall-admin.js 显式暴露 window.Admin（在线库存镜像的前提）');
  if (cached) require.cache[p] = cached; else delete require.cache[p];
  if (had) global.window = savedWin; else delete global.window;
}

/* ============ ⑫ 微信用户角色（任务池⑫ / D32） ============
 * setWxRole / listWxUsers 是异步的，所以这一节放到最后用 async 跑，跑完再汇总退出码。
 * 用一个内存「假 SdyApi」当服务端真源：POST 改完，下一次 GET 就能看到新角色（页面正是靠重拉刷新）。
 */
(async function main() {
  section('⑫ 微信用户角色（D32）');
  const U1 = 'oX9k2LmQwErTyUiOpAsDfGhJkLz1';
  const U2 = 'oYb8nMpRvWxYzAbCdEfGhIjKlMn2';
  const U3 = 'oZc7oNqSwXyZaBcDeFgHiJkLmNo3';
  const server = [
    { openid: U1, unionid: 'u1', phone: '13800001111', nickname: '张三', avatar: 'https://x/a.png', role: 'customer', createdAt: '2026-04-01', updatedAt: '2026-04-01', lastLogin: '2026-05-01 09:30' },
    { openid: U2, unionid: 'u2', phone: '', nickname: '李四', avatar: '', role: 'staff', createdAt: '2026-04-02', updatedAt: '2026-04-02', lastLogin: '2026-05-02 18:02' },
    { openid: U3, unionid: '', phone: '13900002222', nickname: '', avatar: '', role: '老板', createdAt: '', updatedAt: '', lastLogin: '' }
  ];
  const calls = [];
  const hadSdy = Object.prototype.hasOwnProperty.call(global, 'SdyApi');
  const savedSdy = global.SdyApi;
  global.SdyApi = {
    on: () => true,
    req: async (method, path, body) => {
      calls.push({ method: method, path: path, body: body });
      if (method === 'GET' && path.indexOf('/api/wx/users') === 0) return { items: server, total: server.length };
      if (method === 'POST' && path === '/api/wx/role') {
        if (!body || !body.openid) throw new Error('缺少 openid（让对方先用小程序登录一次）');
        const hit = server.filter(u => u.openid === body.openid)[0];
        if (!hit) throw new Error('用户不存在');
        hit.role = body.role;
        return { ok: true, openid: body.openid, role: body.role, nickname: hit.nickname, phone: hit.phone, lastLoginAt: hit.lastLogin };
      }
      throw new Error('no route ' + path);
    }
  };

  // —— 纯函数：标签 / 归一化 / 截断 ——
  ok(Admin.roleLabel('customer') === '顾客' && Admin.roleLabel('staff') === '员工', '角色中文标签：customer→顾客、staff→员工');
  ok(Admin.roleLabel('老板') === '顾客' && Admin.roleLabel('') === '顾客', '未知 / 空角色一律按顾客显示');
  ok(Admin.validWxRole('staff') === true && Admin.validWxRole('boss') === false, '角色白名单只有 customer / staff');
  const nn = Admin.normalizeWxUser({ openid: U1, role: '奇怪', nickname: null, avatar: undefined });
  ok(nn.role === 'customer' && nn.nickname === '' && nn.avatar === '' && nn.phone === '' && nn.lastLogin === '',
     '归一化：未知角色→customer、缺字段→空串（渲染层不崩）');
  ok(Admin.shortOpenid(U1) === 'oX9k2L…kLz1' && Admin.shortOpenid('short') === 'short', 'openid 长截断（首 6+…+末 4）、短照原样');

  // —— 渲染：角色标签 / 相反按钮 / 头像 / 截断 ——
  const html = Admin.renderWxUsers(server);
  ok(html.indexOf('<span class="badge st-done">员工</span>') > -1, '员工行给明显绿色标签 .badge.st-done');
  ok(html.indexOf('<span class="badge">顾客</span>') > -1, '顾客行给「顾客」标签（未知角色也按顾客渲染）');
  ok(html.indexOf('设为员工') > -1 && html.indexOf('设为顾客') > -1, '按钮按当前角色给相反动作文案');
  ok(html.indexOf("wxToggleRole('" + U1 + "','staff')") > -1, '顾客行按钮 → wxToggleRole(openid, staff)');
  ok(html.indexOf("wxToggleRole('" + U2 + "','customer')") > -1, '员工行按钮 → wxToggleRole(openid, customer)');
  ok(html.indexOf('<img class="wxavatar" src="https://x/a.png"') > -1, '有 avatar 才渲染 <img>（加载失败自动 remove）');
  ok(html.indexOf('wxavatar-ph') > -1 && html.indexOf('>李<') > -1, '没头像用昵称首字占位（空昵称给 👤）');
  ok(html.indexOf('title="' + U1 + '"') > -1 && html.indexOf('oX9k2L…kLz1') > -1, 'openid 列表截断、全量放 title');
  ok(html.indexOf('13800001111') > -1 && html.indexOf('—') > -1, '手机号照常显示，缺手机号给「—」');
  ok(html.indexOf('2026-05-01 09:30') > -1, '最后登录时间显示后端原值');
  ok(html.indexOf('<table class="table">') > -1 && html.indexOf('头像') > -1, '用现有 .table 结构（风格与其它面板一致）');
  ok(Admin.renderWxUsers([]).indexOf('还没有微信用户') > -1, '空列表给友好中文提示');
  ok(Admin.renderWxUsers(null).indexOf('还没有微信用户') > -1 && Admin.renderWxUsers(undefined).indexOf('<table') < 0,
     'null / undefined 当空列表处理，不抛错');

  // —— 拉列表：GET + limit + 归一化 ——
  calls.length = 0;
  const list = await Admin.listWxUsers();
  ok(calls.length === 1 && calls[0].method === 'GET' && calls[0].path === '/api/wx/users?limit=200',
     'listWxUsers → GET /api/wx/users?limit=200');
  ok(list.length === 3 && list[2].role === 'customer', '列表归一化：未知角色落回 customer');
  await Admin.listWxUsers(50);
  ok(calls[1].path === '/api/wx/users?limit=50', 'limit 参数透传');

  // —— 设角色：POST body / 参数校验 / 错误透传 ——
  calls.length = 0;
  const r = await Admin.setWxRole(U1, 'staff');
  ok(calls.length === 1 && calls[0].method === 'POST' && calls[0].path === '/api/wx/role',
     '点「设为员工」→ POST /api/wx/role');
  ok(calls[0].body && calls[0].body.openid === U1 && calls[0].body.role === 'staff',
     'body 正确：' + JSON.stringify(calls[0].body));
  ok(calls[0].body && Object.keys(calls[0].body).length === 2, 'body 只带 openid / role 两个字段');
  ok(r && r.ok === true && r.role === 'staff', '成功响应透传（ok / role）');
  const after = await Admin.listWxUsers();
  ok(after[0].role === 'staff' && Admin.renderWxUsers(after).indexOf("wxToggleRole('" + U1 + "','customer')") > -1,
     '切换成功后重拉列表：该行按钮变「设为顾客」');
  await Admin.setWxRole(U1, 'customer');
  ok(server[0].role === 'customer', '再切一次改回顾客，服务端角色回落');

  let msg = '';
  try { await Admin.setWxRole('', 'staff'); } catch (e) { msg = e.message; }
  ok(msg.indexOf('缺少 openid') > -1, '空 openid → 中文报错：' + msg);
  msg = '';
  try { await Admin.setWxRole(U1, 'boss'); } catch (e) { msg = e.message; }
  ok(msg.indexOf('角色只能是') > -1, '非法角色 → 拦截：' + msg);
  msg = '';
  try { await Admin.setWxRole('查无此人', 'staff'); } catch (e) { msg = e.message; }
  ok(msg.indexOf('用户不存在') > -1, '接口报错原样透传（页面据此 toast）：' + msg);

  // —— 离线：微信用户只在服务端，必须给中文提示而不是静默 ——
  global.SdyApi.on = () => false;
  msg = '';
  try { await Admin.listWxUsers(); } catch (e) { msg = e.message; }
  ok(msg.indexOf('未连接后端') > -1, '离线拉列表 → 中文提示：' + msg);
  msg = '';
  try { await Admin.setWxRole(U1, 'staff'); } catch (e) { msg = e.message; }
  ok(msg.indexOf('未连接后端') > -1, '离线设角色 → 中文提示：' + msg);

  if (hadSdy) global.SdyApi = savedSdy; else delete global.SdyApi;

  // ============ ⑬ 第 27 轮新增纯函数：演示数据识别 / 营业额口径 / 新单签名 ============
  section('⑬ 演示数据识别 / 营业额口径 / 新单签名（第 27 轮）');
  {
    ok(Admin.isDemoProduct({ isDemo: true }) === true, 'isDemo:true → 判定为示例商品');
    ok(Admin.isDemoProduct({ is_demo: 1 }) === true, 'is_demo:1 → 判定为示例商品');
    ok(Admin.isDemoProduct({ SEED_DEMO: '1' }) === true, "SEED_DEMO:'1' → 判定为示例商品");
    ok(Admin.isDemoProduct({}) === false, '字段缺失 → 当正式商品（绝不误标真货）');
    ok(Admin.isDemoProduct(null) === false && Admin.isDemoProduct(undefined) === false, 'null / undefined 不抛错，当正式商品');
    ok(Admin.demoCount([{ isDemo: true }, {}, { is_demo: 1 }]) === 2, 'demoCount 数出 2 件示例商品');
    ok(Admin.demoCount(null) === 0 && Admin.demoCount('x') === 0, 'demoCount 非数组入参 → 0，不抛错');
  }
  {
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const mk = (id, status, total, at) => ({ id: id, status: status, total: total, createdAt: at == null ? now : at });
    const orders = [
      mk('A', 'pending', 10.005), mk('B', 'delivering', 20), mk('C', 'ready', 5.5),
      mk('D', 'done', 30), mk('E', 'done', 0.1), mk('F', 'cancelled', 99),
      mk('G', 'done', 1000, now - day)
    ];
    const k = Admin.kpiOf(orders, now);
    ok(k.today === 6, '「今日」只数今天的 6 单，昨天的已完成单不进今日：' + k.today);
    ok(k.valid === 5 && k.cancelled === 1, '取消单单独计数、不算有效单：valid=' + k.valid + ' cancelled=' + k.cancelled);
    ok(k.done === 2, '今日已完成 2 单');
    ok(k.doneAmount === 30.1, '今日营业额 = 已完成合计 30.10（下单≠收款，进行中不算）：' + k.doneAmount);
    ok(k.open === 3 && k.openAmount === 35.51, '进行中 3 单 / 35.51（10.005 先 round2 成 10.01 再求和）');
    ok(k.doneAmount + k.openAmount !== 129.61, '取消单的 99 元既不进营业额也不进进行中金额');
    const empty = Admin.kpiOf([], now);
    ok(empty.today === 0 && empty.doneAmount === 0 && empty.openAmount === 0, '空列表全 0，不抛错');
    ok(Admin.kpiOf(null, now).today === 0, 'orders 为 null 时全 0，不抛错');
  }
  {
    const now = Date.now();
    const o1 = { id: 'M1', createdAt: now - 1000 }, o2 = { id: 'M2', createdAt: now };
    ok(Admin.orderSig([o1, o2]) === String(now), 'orderSig = 镜像里最新的下单时间');
    ok(Admin.orderSig([]) === '0' && Admin.orderSig(null) === '0', '空列表签名 0（首轮不会误报一堆新单）');
    ok(Admin.orderSig([{ id: 'M0' }]) === '0', 'createdAt 缺失当 0，不抛错');
    const fresh = Admin.newOrdersSince([o1, o2], String(now - 1000), String(now - 1000));
    ok(fresh.length === 1 && fresh[0].id === 'M2', '传入上次签名后只提醒更新的单，历史单不重复弹');
    ok(Admin.newOrdersSince([o2], now, String(now)).length === 0, '签名相同 → 不再提醒（轮询不会刷屏）');
    ok(Admin.newOrdersSince(null, now, '').length === 0, 'orders 为 null → 空数组，不抛错');
  }

  // ============ ⑭ 第 28 轮：订单筛选参数拼装 / 日期区间 / 导出 / 批量区顺序 ============
  section('⑭ 订单筛选参数拼装与日期区间（第 28 轮 7.5 / 7.8）');
  {
    const NOW = new Date(2026, 9, 14, 10, 30, 0).getTime();   // 固定「现在」= 2026-10-14 10:30 本地时间
    const J = o => JSON.stringify(o);
    // —— 参数逐字正确 ——
    ok(J(Admin.orderFilterQuery({ date: 'today', now: NOW })) === J({ date: '2026-10-14' }),
      '今天 → {date:2026-10-14}（本地日，不走 UTC）');
    ok(J(Admin.orderFilterQuery({ date: '7d', now: NOW })) === J({ from: '2026-10-08', to: '2026-10-14' }),
      '近 7 天 → from=2026-10-08 to=2026-10-14（含今天共 7 天）');
    ok(J(Admin.orderFilterQuery({ date: 'custom', from: '2026-10-01', to: '2026-10-07' })) === J({ from: '2026-10-01', to: '2026-10-07' }),
      '自定义 → 原样带上 from/to（含端点）');
    ok(J(Admin.orderFilterQuery({ date: 'custom', from: '2026-10-01', to: '' })) === J({ from: '2026-10-01' }),
      '自定义只填起始日 → 只带 from，不伪造 to');
    ok(J(Admin.orderFilterQuery({ date: 'none', from: '2026-10-01', to: '2026-10-07' })) === J({}),
      '全部时间 → 一个日期参数都不带（from/to 也被剔除）');
    const full = Admin.orderFilterQuery({ q: '  张三  ', status: 'pending,delivering', type: 'pickup', date: 'custom', from: '2026-10-01', to: '2026-10-07' });
    ok(J(full) === J({ q: '张三', status: 'pending,delivering', type: 'pickup', from: '2026-10-01', to: '2026-10-07' }),
      '关键词去空白 / status 多值原样 / type 原样：' + J(full));
    ok(J(Admin.orderFilterQuery({ status: 'all', type: 'all', date: 'today', now: NOW })) === J({ date: '2026-10-14' }),
      '「全部」状态与「全部」配送方式不拼进查询串（空 = 不筛）');
    ok(J(Admin.orderFilterQuery({})) === J({ date: Admin.dayKey(new Date()) }), '不传日期时按今天兜底，绝不出现空 query');
    ok(Admin.orderFilterQuery({ date: 'custom', from: '2026-13-40', to: 'x' }).from === '2026-13-40',
      '非法日期原样透传（400 由服务端按 7.5 给中文提示，前端不擅自吞掉）');

    // —— phone 绝不被筛选覆盖：第 27 轮身份通道与筛选通道是两根管子 ——
    const withPhone = Admin.orderFilterQuery({ q: '李四', status: 'pending', date: 'today', phone: '13800000000', now: NOW });
    ok(withPhone.phone === undefined && J(withPhone).indexOf('13800000000') < 0,
      'filter 里没有 phone、也不含被传入的手机号（身份只走 sync 的 phone 参数）');
    ok(Admin.orderFilterQuery({ q: '13800000000', date: 'today', now: NOW }).q === '13800000000',
      '手机号要筛只能走 q（模糊搜索），不占身份字段');
    ok(J(Admin.orderFilterQuery(undefined)) === J({ date: Admin.dayKey(new Date()) }), 'undefined 入参不抛错，仍给默认今天');

    // —— 日期优先级：date 与 from/to 同时给 → date 优先（7.5）——
    ok(J(Admin.orderFilterQuery({ date: '7d', from: '2026-01-01', to: '2026-01-02', now: NOW })) === J({ from: '2026-10-08', to: '2026-10-14' }),
      'date 优先于 from/to：同时给时 from/to 被忽略');
    ok(J(Admin.orderDateRange('custom', '', '', NOW)) === J({}), '自定义两个日期都空 → 空区间（不回落今天）');
  }
  {
    // —— 区间边界（本地日零点~23:59:59.999），自定义区间首尾都算 ——
    const d = (y, mo, day, h) => new Date(y, mo - 1, day, h == null ? 12 : h, 0, 0).getTime();
    const mk = (id, at, status, type, name, phone) => ({
      id: id, status: status || 'pending', deliveryType: type || 'pickup', total: 10,
      createdAt: at, customer: { name: name || '张三', phone: phone || '13800000000' }
    });
    const orders = [
      mk('B1', d(2026, 10, 1, 0)),      // 区间起点 00:00 → 算
      mk('B2', d(2026, 10, 7, 23)),     // 区间终点当天 → 算
      mk('B3', d(2026, 9, 30, 23)),     // 差一天 → 不算
      mk('B4', d(2026, 10, 8, 0))       // 差一天 → 不算
    ];
    const inRange = Admin.filterOrders(orders, { date: 'custom', from: '2026-10-01', to: '2026-10-07' });
    ok(inRange.length === 2 && inRange[0].id === 'B1' && inRange[1].id === 'B2',
      '自定义区间含端点：10-01 00:00 与 10-07 23:00 都算，09-30 / 10-08 不算');
    ok(Admin.filterOrders(orders, { date: 'custom', from: '2026-10-07', to: '2026-10-07' }).length === 1,
      '起止同一天 = 单日区间，只回当天 1 单');

    // —— 其余三个条件的本地兜底口径（后端未就绪时页面照样筛得对）——
    const all = [
      mk('C1', d(2026, 10, 14), 'pending', 'pickup', '张三', '13800000000'),
      mk('C2', d(2026, 10, 14), 'delivering', 'delivery', '李四', '13900000000'),
      mk('C3', d(2026, 10, 14), 'done', 'pickup', '王五', '13700000000'),
      mk('C4', d(2026, 10, 14), 'cancelled', 'delivery', '张三', '13800000000')
    ];
    ok(Admin.filterOrders(all, { status: 'pending,delivering' }).map(o => o.id).join() === 'C1,C2',
      'status 逗号多值 → 只回 pending + delivering');
    ok(Admin.filterOrders(all, { q: '张三' }).length === 2 && Admin.filterOrders(all, { q: '13900000000' })[0].id === 'C2' &&
      Admin.filterOrders(all, { q: 'c3' })[0].id === 'C3',
      'q 同时匹配顾客名 / 手机号 / 订单号（大小写不敏感）');
    ok(Admin.filterOrders(all, { type: 'delivery' }).map(o => o.id).join() === 'C2,C4', 'type=delivery 只回配送单');
    ok(Admin.filterOrders(null, { q: 'x' }).length === 0 && Admin.filterOrders(all, {}).length === 4,
      '空入参不抛错：null → []，无筛选 → 原样全回');
    ok(Admin.hasOrderFilter({}) === false && Admin.hasOrderFilter({ date: '2026-10-14' }) === true &&
      Admin.hasOrderFilter({ type: 'pickup' }) === true, 'hasOrderFilter 认全部 5 类条件');
  }
  {
    // —— 与页面接线逐字核对：页面控件必须真的把 filter 送进 sync / 导出，失败必须红 toast ——
    const fs = require('fs');
    const html = fs.readFileSync(require.resolve('./admin.html'), 'utf8');
    const mod = fs.readFileSync(require.resolve('./mall-admin.js'), 'utf8');
    const T = s => html.indexOf(s) >= 0;
    const M = s => mod.indexOf(s) >= 0;
    ok(M('sync(null, { all: true, filter: f })') && M('syncOrders: syncOrders'),
      '筛选请求统一走 Admin.syncOrders（sync 带上 filter，参数由 Admin.orderFilterQuery 拼装）');
    ok(T('const rows = await Admin.syncOrders(filter)') && T('renderOrders(rows)') && T('renderOrderKpis(rows)'),
      '一次刷新同时喂列表与 KPI（同一批行，口径不会打架）');
    ok(!T('Mall._save(Mall.KEYS.orders, Admin.filterOrders('),
      '筛选结果绝不写回订单镜像（否则 renderDash 的「当前待处理（不限日期）」会被日期筛选截断）');
    ok(T('<div class="obar" id="orderFilterBar">') && T('id="orderFooter"'),
      '订单列表上方有筛选条，列表下方有页脚计数');
    ok(T('id="ofQ"') && T('placeholder="顾客名 / 手机号 / 订单号"'), '关键词框占位提示逐字一致');
    ok(T('id="ofCustom" class="obar-custom hide"') && T("orderFilter.date === 'custom' ? '' : ' hide'") &&
      /\.hide\s*\{[^}]*display:\s*none/.test(fs.readFileSync(require.resolve('./assets/theme.css'), 'utf8')),
      '自定义日期区间默认收起、只在「自定义」档展开（.hide 真有 display:none 定义）');
    // 支付轮（支付）：pending 显示名要跟支付状态走，所以状态下拉改成由 ORDER_STATUSES
    // 动态生成（选项文案只有 Mall.orderLabel 一份真源）。契约的 5 个 status 值仍在，不新增。
    ok(['pending', 'delivering', 'ready', 'done', 'cancelled'].every(s => M("'" + s + "'")) &&
      T('id="ofStatus"') && T('Admin.ORDER_STATUSES') && T('Mall.orderLabel') &&
      T('<option value="today">今天</option>') && T('<option value="7d">近 7 天</option>') &&
      T('<option value="custom">自定义</option>') && T('id="ofFrom"') && T('id="ofTo"') &&
      T('<option value="pickup">自提</option>') && T('<option value="delivery">配送</option>'),
      '状态 5 值（动态生成）/ 日期 3 档 + from-to / 配送方式 3 值齐备');
    ok(T("['ofQ', 'ofStatus', 'ofDate', 'ofFrom', 'ofTo', 'ofType', 'ofPaid']"),
      '7 个控件（含新增的支付状态）都走同一个刷新出口（不会只刷半个页面）');
    ok(T('await SdyApi.downloadOrdersCSV(filter)') && T('btn.disabled = true') && T("btn.textContent = '导出中…'"),
      '导出调用 SdyApi.downloadOrdersCSV(filter)，导出中按钮禁用并显示「导出中…」');
    ok(T('toastErr(') && T(".className = 'toast show err'") && T('.toast.err {'),
      '失败路径是红色 toast（不是静默失败，也不是 alert）');
    ok(T("btn.textContent = label || '⬇ 导出 CSV'"),
      '成功后恢复按钮原文案（无论成功失败都不会卡在「导出中…」）');
    const iFilterVar = html.indexOf('const filter = orderFilterQuery();');
    const iCall = html.indexOf('await SdyApi.downloadOrdersCSV(filter)');
    ok(iFilterVar > 0 && iCall > iFilterVar,
      '导出用的 filter 就是当前筛选（同一个 orderFilterQuery，先取筛选再下载）');
    const iBulk = html.indexOf('<div class="panel" id="bulkPanel"');
    const iTable = html.indexOf('<div class="table-wrap" id="prodTable"></div>');
    ok(iBulk > 0 && iTable > iBulk, 'DOM 顺序：#bulkPanel 在商品表格之前（老板先框选再操作）');
    // 第 27 轮成果不许回退：批量改价 / 批量改分类 / 取消批发三条 payload 仍带 wholesalePrice
    const nWholesale = (html.match(/wholesalePrice: p\.wholesalePrice \|\| 0/g) || []).length;
    ok(nWholesale >= 3, '三条批量 payload 都继续带 wholesalePrice（数到 ' + nWholesale + ' 处，绝不回退第 27 轮修复）');
    ok(html.indexOf('function readOrderFilter()') > 0 && html.indexOf("date: v('ofDate') || 'today'") > 0,
      '页面筛选状态读取有唯一入口 readOrderFilter()');
    ok(html.indexOf('renderOrders();') > 0 && html.indexOf('renderOrderKpis();') > 0,
      '刷新时列表与 KPI 一起重算（同一份筛选结果）');
  }
  // ============ ⑭（续）筛选只影响渲染，绝不污染订单镜像 ============
  section('⑭（续）Admin.syncOrders：筛选结果不写回镜像（第 27 轮口径）');
  {
    const d = (y, mo, day) => new Date(y, mo - 1, day, 12, 0, 0).getTime();
    const mk = (id, at, status) => ({ id: id, status: status || 'pending', deliveryType: 'pickup', total: 10, createdAt: at, customer: { name: '张三', phone: '13800000000' } });
    Mall._resetForTest();
    Mall._save(Mall.KEYS.orders, [
      mk('D1', d(2026, 10, 1), 'pending'),
      mk('D2', d(2026, 10, 7), 'done'),
      mk('D3', d(2026, 9, 30), 'pending'),
      mk('D4', d(2026, 10, 8), 'delivering')
    ]);
    const f = { date: 'custom', from: '2026-10-01', to: '2026-10-07' };
    let syncArg = null;
    const fakeApi = { sync: function (phone, opts) { syncArg = { phone: phone, opts: opts }; return Promise.resolve({}); } };
    const rows = await Admin.syncOrders(f, fakeApi);
    ok(rows.map(o => o.id).join() === 'D1,D2', 'syncOrders 本地兜底：只回筛选区间内的单（' + rows.map(o => o.id).join() + '）');
    ok(Mall.getOrders().length === 4,
      '筛选后订单镜像仍是全量 4 单（第 27 轮「当前待处理不限日期」不被日期筛选截断）');
    ok(syncArg && syncArg.phone === null && syncArg.opts && syncArg.opts.all === true &&
      JSON.stringify(syncArg.opts.filter) === JSON.stringify(f),
      '参数逐字进 sync：sync(null,{all:true,filter}) → ' + JSON.stringify(syncArg && syncArg.opts && syncArg.opts.filter));
    const rowsAll = await Admin.syncOrders({}, { sync: function () { return Promise.resolve({}); } });
    ok(rowsAll.length === 4, '不带筛选条件时 syncOrders 原样回全量（不误伤）');
    // 后端真支持 filter 时以 sync 结果为准（条数变了 → 不再叠加本地筛选）
    const backendApi = {
      sync: function () {
        Mall._save(Mall.KEYS.orders, [mk('E1', d(2026, 10, 1), 'pending')]);
        return Promise.resolve({});
      }
    };
    const rowsBackend = await Admin.syncOrders(f, backendApi);
    ok(rowsBackend.length === 1 && rowsBackend[0].id === 'E1',
      '后端已支持 filter 时以 sync 结果为准（不再叠加本地筛选）');
  }

  console.log('\n========================================');
  // ============ ⑮ 支付轮：支付状态 / 退款 / 对账 ============
  section('⑮ 支付状态 / 退款 / 对账（支付轮）');
  {
    // 支付轮（payEnabled）：本节前半测「店家已开通在线支付」的口径，显式打开；
    // 未开通口径在本节末尾单测（默认就是未开通，两套口径必须分开测，否则互相掩盖）。
    Mall.setSettings({ payEnabled: true });
    // —— orderLabel：status 一个值都不新增，pending 内部按 paid 派生 ——
    ok(Mall.orderLabel({ status: 'pending', paid: false }) === '待付款', 'pending + 未付款 → 待付款');
    ok(Mall.orderLabel({ status: 'pending', paid: true }) === '待备货', 'pending + 已付款 → 待备货');
    ok(Mall.orderLabel({ status: 'pending' }) === '待付款', 'paid 字段缺失（老服务端）→ 当未付款，绝不假装已收款');
    ok(Mall.orderLabel({ status: 'pending', paid: 1 }) === '待备货' && Mall.orderLabel({ status: 'pending', paid: '1' }) === '待备货',
      'paid 为 1 / "1"（后端 JSON 数字或字符串）同样算已付款');
    ok(Mall.orderLabel({ status: 'delivering', paid: true }) === '配送中' &&
      Mall.orderLabel({ status: 'ready', paid: false }) === '待取货' &&
      Mall.orderLabel({ status: 'done', paid: true }) === '已完成' &&
      Mall.orderLabel({ status: 'cancelled', paid: true }) === '已取消',
      '其余状态沿用第 27 轮文案，paid 不影响（三端逐字一致）');
    ok(Admin.orderLabel({ status: 'pending', paid: true }) === '待备货' &&
      Admin.orderLabel === Mall.orderLabel || typeof Admin.orderLabel === 'function',
      'Admin.orderLabel 与 Mall.orderLabel 同一口径（页面不会各写一份）');

    // —— payBadgeHTML：未付款 / 已付款+时间 / 退款处理中 / 已退款 / 退款失败，请联系店家（红） ——
    const bUnpaid = Mall.payBadgeHTML({ status: 'pending', paid: false });
    ok(bUnpaid.indexOf('未付款') >= 0 && bUnpaid.indexOf('st-pending') >= 0,
      'payBadgeHTML 未付款 → 琥珀徽标：' + bUnpaid);
    const bPaid = Mall.payBadgeHTML({ status: 'pending', paid: true, paidAt: new Date(2026, 9, 10, 8, 6).getTime() });
    ok(bPaid.indexOf('已付款') >= 0 && bPaid.indexOf('st-done') >= 0 && bPaid.indexOf('10-10 08:06') >= 0,
      'payBadgeHTML 已付款 → 绿徽标 + 到账时间（MM-DD HH:mm）：' + bPaid);
    const bPaidNoTime = Mall.payBadgeHTML({ status: 'pending', paid: true });
    ok(bPaidNoTime.indexOf('已付款') >= 0 && !/\d\d-\d\d/.test(bPaidNoTime),
      'paidAt 缺失时只显示「已付款」，绝不瞎编时间：' + bPaidNoTime);
    const bProc = Mall.payBadgeHTML({ status: 'cancelled', paid: true, refundState: 'processing' });
    ok(bProc === '<span class="badge st-info">退款处理中</span>',
      'refundState=processing → 蓝徽标「退款处理中」（整串全等，字面与小程序一致；退款态优先于 paid）：' + bProc);
    const bDone = Mall.payBadgeHTML({ status: 'cancelled', paid: true, refundState: 'success' });
    ok(bDone === '<span class="badge st-cancelled">已退款</span>',
      'refundState=success → 灰徽标「已退款」（整串全等）：' + bDone);
    const bFail = Mall.payBadgeHTML({ status: 'cancelled', paid: true, refundState: 'fail' });
    ok(bFail === '<span class="badge st-warn">退款失败，请联系店家</span>',
      'refundState=fail → 红色徽标「退款失败，请联系店家」（整串全等，老板一眼看见）：' + bFail);
    ok(Mall.payBadgeHTML({ status: 'cancelled', paid: true, refundState: 'fail' }).indexOf('st-done') < 0,
      '「退款失败，请联系店家」绝不退化成绿色「已付款」（否则钱没退回来还看着像收了款）');
    ok(Mall.payBadgeHTML(null) === '' && Mall.payBadgeHTML(undefined) === '',
      '空订单吐空串，不抛错也不吐半个徽标');
    ok(Mall.payBadgeHTML({}).indexOf('未付款') >= 0,
      '订单对象缺 paid（老服务端）→ 按未付款显示，绝不假装已收款');

    // —— kpiOf：toCollect / paidAmount；doneAmount 语义一字不改 ——
    const now = Date.now();
    const day = 24 * 3600 * 1000;
    const mk = (id, status, total, paid, at) =>
      ({ id: id, status: status, total: total, paid: paid, createdAt: at == null ? now : at });
    const orders = [
      mk('A', 'pending', 100, true),      // 今日已付款待备货 → 进 paidAmount
      mk('B', 'pending', 10, false),      // 今日待付款 → 进 toCollect，不进 paidAmount
      mk('C', 'done', 30, true),          // 今日已完成且已收款 → 进 paidAmount 与 doneAmount
      mk('D', 'cancelled', 99, true),     // 今日已取消的已付款单 → 退款处理中，不计入已收款
      mk('E', 'done', 50, true, now - day),  // 昨天的单 → 只算今天，不进任何今日口径
      mk('F', 'delivering', 20, true)     // 今日配送中且已收款 → 进 paidAmount
    ];
    const k = Admin.kpiOf(orders, now);
    ok(k.paidAmount === 150, '今日已收款 = 已付款且未取消的合计 150（100+30+20）：' + k.paidAmount);
    ok(k.toCollect === 1, '今日待收款 = 今日未付款单数 1：' + k.toCollect);
    ok(k.doneAmount === 30, '「今日营业额」语义未变：仍只算已完成 30（已付款的 pending/delivering 绝不混入）');
    ok(k.paidAmount !== k.openAmount, '已收款 ≠ 进行中金额（口径是两根管子，别互相顶替）');
    ok(k.paidAmount + k.toCollect !== 0 && orders.filter(o => o.paid === true && o.status === 'cancelled').length === 1,
      '已取消的已付款单（99 元）既不计入已收款，也不计入营业额');
    const kEmpty = Admin.kpiOf([], now);
    ok(kEmpty.paidAmount === 0 && kEmpty.toCollect === 0, '空列表 paidAmount / toCollect 全 0，不抛错');
    ok(Admin.kpiOf(null, now).paidAmount === 0 && Admin.kpiOf(null, now).toCollect === 0,
      'orders 为 null 时 paidAmount / toCollect 全 0，不抛错');

    // —— ① 跨夜收款必须归到「付款那天」：昨晚下单、今天付款 = 今天的钱（微信商户账单口径） ——
    const overnight = [
      { id: 'N1', status: 'pending', total: 7, paid: true, createdAt: now - day, paidAt: now - 1000 }
    ];
    ok(Admin.kpiOf(overnight, now).paidAmount === 7,
      '昨晚下单 / 今天付款的单算进「今日已收款」（按 paidAt 归日）');
    ok(Admin.kpiOf(overnight, now - day).paidAmount === 0,
      '同一张单不算进「昨日已收款」（否则跟微信商户账单对不上）');
    ok(Admin.kpiOf(overnight, now).toCollect === 0 && Admin.kpiOf(overnight, now).doneAmount === 0,
      '跨夜单只影响已收款口径：待收款按 createdAt 归昨日、营业额仍只算已完成');
    // paidAt 用服务端 RFC3339 字符串也要能解析（真实数据就是这个形状）
    ok(Admin.kpiOf([{ id: 'N2', status: 'done', total: 9, paid: true, createdAt: now - day, paidAt: new Date(now).toISOString() }], now).paidAmount === 9,
      'paidAt 为 RFC3339 字符串（服务端原样）同样能解析归日');
    // —— ② paidAt 取不到 → 退回 createdAt 归日（不丢、不报错） ——
    const noPaidAt = [
      { id: 'N3', status: 'pending', total: 11, paid: true, createdAt: now },              // 老单：没有 paidAt
      { id: 'N4', status: 'done', total: 13, paid: true, createdAt: now - day },           // 老单：没有 paidAt
      { id: 'N5', status: 'pending', total: 17, paid: true, createdAt: now, paidAt: '不是时间' },  // paidAt 解析不出来
      { id: 'N6', status: 'pending', total: 19, paid: true }                               // 两个时间都缺 → 归不了日，丢掉也不报错
    ];
    ok(Admin.kpiOf(noPaidAt, now).paidAmount === 28,
      '缺 paidAt 的老单退回 createdAt 归日（今天 11 + 解析失败退回今天 17 = 28）：' + Admin.kpiOf(noPaidAt, now).paidAmount);
    ok(Admin.kpiOf(noPaidAt, now - day).paidAmount === 13,
      '缺 paidAt 的老单按 createdAt 归到昨天（昨天的 13 算昨天的钱）');
    ok(Admin.kpiOf(noPaidAt, now).toCollect === 0, '这些单都已付款 → 不计入待收款');
    ok(Admin.kpiOf([{ id: 'N7', status: 'pending', total: 5, paid: true }], now).paidAmount === 0,
      'paidAt / createdAt 都缺的单归不了日 → 不计入任何一天，但绝不抛错');

    // —— prepQueue：备货队列只列已付款的 pending（老板红线） ——
    const pq = Admin.prepQueue([
      mk('P1', 'pending', 1, true, now - 5000),
      mk('P2', 'pending', 1, false, now),
      mk('P3', 'pending', 1, true, now),
      mk('P4', 'done', 1, true, now),
      mk('P5', 'delivering', 1, true, now),
      mk('P6', 'pending', 1, '1', now - 10000)
    ]);
    ok(pq.length === 3 && pq.every(o => o.status === 'pending' && o.paid), 'prepQueue 只返回已付款的 pending 单');
    ok(pq.map(o => o.id).join(',') === 'P3,P1,P6', 'prepQueue 按下单时间倒序（最新在前）：' + pq.map(o => o.id).join(','));
    ok(Admin.prepQueue([mk('X', 'pending', 1, false)]).length === 0,
      '一张未付款单都不放行（未付款单绝不混进备货队列）');
    ok(Admin.prepQueue(null).length === 0 && Admin.prepQueue(undefined).length === 0 && Admin.prepQueue('x').length === 0,
      '非数组入参 → 空数组，不抛错');

    // —— orderFilterQuery 的 paid：只认 0/1，其余视为不筛 ——
    const NOW = new Date(2026, 9, 14, 10, 30, 0).getTime();
    const J = o => JSON.stringify(o);
    ok(J(Admin.orderFilterQuery({ date: 'none', paid: '1' })) === J({ paid: '1' }), "paid='1' 逐字进查询串");
    ok(J(Admin.orderFilterQuery({ date: 'none', paid: '0' })) === J({ paid: '0' }), "paid='0' 逐字进查询串");
    ok(J(Admin.orderFilterQuery({ date: 'none', paid: 'all' })) === J({}) &&
      J(Admin.orderFilterQuery({ date: 'none', paid: '' })) === J({}),
      "paid 为 'all' / '' / 缺失 → 不拼进查询串（空 = 不筛）");
    ok(J(Admin.orderFilterQuery({ date: 'none', paid: '2' })) === J({}) &&
      J(Admin.orderFilterQuery({ date: 'none', paid: 'true' })) === J({}),
      'paid 只认 0/1，其它值一律当不筛（绝不把非法值透传给服务端）');
    ok(Admin.hasOrderFilter({ paid: '1' }) === true && Admin.hasOrderFilter({ paid: '0' }) === true &&
      Admin.hasOrderFilter({ paid: 'all' }) === false && Admin.hasOrderFilter({}) === false,
      'hasOrderFilter 认 paid：有 paid=0/1 时必须走服务端过滤，不能当「无筛选」直接回镜像');
    const fo = Admin.filterOrders([
      { id: 'a', status: 'pending', paid: true, createdAt: now },
      { id: 'b', status: 'pending', paid: false, createdAt: now },
      { id: 'c', status: 'pending', paid: 1, createdAt: now }
    ], { paid: '1' });
    ok(fo.length === 2 && fo.every(o => o.paid), 'filterOrders(paid=1) 只留已付款单');
    ok(Admin.filterOrders([{ id: 'a', status: 'pending', paid: true }], { paid: '0' }).length === 0,
      'filterOrders(paid=0) 只留未付款单');

    // —— admin.html 接线：支付列 / 支付状态筛选 / 退款按钮 / KPI 卡都真在页面上 ——
    const fs = require('fs');
    const html = fs.readFileSync(require.resolve('./admin.html'), 'utf8');
    const T = s => html.indexOf(s) >= 0;
    ok(T('id="ofPaid"') && T('value="1">已付款') && T('value="0">待付款') && T('value="all">全部'),
      '筛选条有「支付状态」（全部 / 待付款 / 已付款）');
    ok(T('Mall.payBadgeHTML(o)') && /<th[^>]*>支付<\/th>/.test(html),
      '订单表有「支付」列且用 Mall.payBadgeHTML 渲染（四态一眼可见）');
    ok(T('markPaidO(') && T('refundO(') && T('function markPaidO(') && T('function refundO('),
      '订单动作区有「标记已收款」与「发起退款」按钮且处理函数都在');
    ok(T('SdyApi.markPaid(id, \'现金\')') && T("SdyApi.refundOrder(id, '老板发起退款')"),
      '两个按钮分别打 SdyApi.markPaid / SdyApi.refundOrder（没有本地假成功）');
    ok(T('confirm(') && /markPaidO[\s\S]{0,900}?toastErr\(/.test(html) && /refundO[\s\S]{0,900}?toastErr\(/.test(html),
      '两个动作都有二次确认，且失败走红色 toastErr（不静默）');
    ok(/if \(!Mall\.isPaid\(o\) && o\.status !== 'cancelled'\) acts\.push\([\s\S]{0,140}?markPaidO/.test(html),
      '「标记已收款」只给未付款且未取消的单（已取消的单再标已收款会把没进账的钱算进「今日已收款」）');
    ok(/if \(Mall\.isPaid\(o\) && o\.status !== 'cancelled'\) acts\.push\([\s\S]{0,140}?refundO/.test(html),
      '「发起退款」只给已付款且未取消的单（已取消的单服务端已发过退款）');
    ok(T('id="kpiPaidAmount"') && T('id="kpiToCollect"') &&
      T("$('kpiPaidAmount').textContent") && T("$('kpiToCollect').textContent"),
      'KPI 区新增「今日已收款（微信）」「待收款」两张卡且真会被写入');
    ok(T('按付款时间统计') && T('按订单时间统计'),
      '两张卡的脚注写明口径差别（已收款按付款时间 / 待收款按订单时间），老板一眼能懂');
    ok(T('只算已完成') && T('下单≠收款'),
      '「今日营业额」的脚注仍是「只算已完成（下单≠收款）」，没被改成含未收款');
    ok(T('Admin.prepQueue(list)') && T('Admin.prepQueue(Mall.getOrders())') &&
      !T("list.filter(o => o.status === 'pending').length"),
      '待备货计数与批量打印都走 Admin.prepQueue（未付款单混不进来）');
    ok(T('REFUND_LABELS') && T("processing: '退款处理中'") && T("fail: '退款失败，请联系店家'") && T("'': '未退款'") && T('function refundLabel('),
      'REFUND_LABELS 三态逐字用小程序侧字面（退款处理中 / 已退款 / 退款失败，请联系店家），后台空态保留「未退款」');
    ok(T('o.transactionId') && T('o.refundId') && T('o.paidAt'),
      '订单明细显示 transactionId / refundId / 到账时间（对账要看得到）');

    // —— 支付轮（payEnabled）：未开通在线支付（服务端缺 WXPAY_*，也就是当前线上真实状态）——
    // 这时根本不存在「待付款」这个状态：显示名回到第 28 轮，备货队列必须收下这些 pending 单，
    // 否则老板的备货队列恒空、店铺停摆（这正是本次要修的必修缺陷）。
    Mall.setSettings({ payEnabled: false });
    ok(Mall.payEnabled() === false && Admin.payEnabled() === false, '未开通在线支付 → Mall / Admin 读到同一个 false');
    ok(Mall.orderLabel({ status: 'pending', paid: false }) === '待备货' &&
      Mall.orderLabel({ status: 'pending' }) === '待备货' &&
      Admin.orderLabel({ status: 'pending', paid: false }) === '待备货',
      '未开通时 pending 一律显示「待备货」（第 28 轮语义），绝不显示「待付款」');
    ok(Mall.orderLabel({ status: 'cancelled', paid: false }) === '已取消' &&
      Mall.orderLabel({ status: 'done', paid: false }) === '已完成' &&
      Mall.orderLabel({ status: 'ready', paid: false }) === '待取货',
      '未开通时 cancelled/done/ready 分支一点不受影响');
    ok(Mall.payBadgeHTML({ status: 'pending', paid: false }) === '',
      '未开通时未付款单不出「未付款」徽标（线下收款不是欠款）');
    ok(Mall.payBadgeHTML({ status: 'pending', paid: true, paidAt: now }).indexOf('已付款') >= 0,
      '未开通时老板线下标记过的已收款单照常显示绿徽标（对账要看得见）');
    const pqOff = Admin.prepQueue([
      mk('Q1', 'pending', 1, false, now),
      mk('Q2', 'pending', 1, true, now - 1000),
      mk('Q3', 'done', 1, false, now),
      mk('Q4', 'cancelled', 1, false, now)
    ]);
    ok(pqOff.map(o => o.id).join(',') === 'Q1,Q2',
      '未开通时备货队列收全部 pending（含未付款单），done/cancelled 仍不进：' + pqOff.map(o => o.id).join(','));
    ok(Admin.kpiOf(orders, now).toCollect === 0,
      '未开通时「待收款」为 0（那笔钱不会从线上进来），卡片还在但这个数不该虚挂');
    ok(Admin.kpiOf(orders, now).paidAmount === 150 && Admin.kpiOf(orders, now).doneAmount === 30,
      '未开通时已收款 / 今日营业额口径照旧（线下标记的单仍算钱）');
    ok(Admin.orderFilterQuery({ date: 'none', paid: '1' }).paid === '1',
      '未开通时「已付款 / 待付款」筛选仍可用（老板要能翻出标记过收款的单）');
    Mall.setSettings({ payEnabled: true });   // 复位：别把「未开通」口径漏给后面的用例
  }

  console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

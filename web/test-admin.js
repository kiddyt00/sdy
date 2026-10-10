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

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

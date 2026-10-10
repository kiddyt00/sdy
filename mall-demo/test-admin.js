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

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

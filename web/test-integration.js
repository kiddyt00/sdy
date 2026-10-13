/* =====================================================================
 * 端到端联调测试：真 fetch → 真 Go 后端（不是假 fetch）
 *   验证「前端页面代码（Mall + SdyApi）」与「后端 HTTP API」确实对得上：
 *   下单扣库存 / 运费规则 / 状态流转 / 非法流转 409 / 取消回补 / 比价巡检 / 条码解析
 *   库存审计落库（D25）/ 配送员 / 门店抬头 / 顾客备注 / 离线降级
 *
 * 用法：
 *   1) 先启动后端：cd server && STATIC_DIR=.. go run ./cmd/server
 *   2) 再跑本测试：node web/test-integration.js
 *   （可用 SDY_API_BASE 指定地址；未探测到后端时自动跳过，退出码 0）
 * ===================================================================== */
'use strict';
const Mall = require('./mall.js');
const SdyApi = require('./sdy-api.js');
const Admin = require('./mall-admin.js');

const BASE = process.env.SDY_API_BASE || 'http://127.0.0.1:8093';
const CODE = '6901234567892';   // 可口可乐 2.5/罐（后端种子数据）

let passed = 0, failed = 0;
function ok(cond, msg) {
  if (cond) { passed++; console.log('  ✔ ' + msg); }
  else { failed++; console.log('  ✘ ' + msg); }
}
function section(t) { console.log('\n■ ' + t); }

async function serverStock(code) {
  const r = await SdyApi.req('GET', '/api/products?keyword=' + encodeURIComponent(code));
  const p = (r.items || []).find(x => x.code === code);
  return p ? p.stock : null;
}

(async function main() {
  Mall._resetForTest();
  SdyApi._resetForTest();
  Mall.loadCatalog();

  const st = await SdyApi.boot({ base: BASE, mall: Mall, admin: Admin, timeoutMs: 1500 });
  if (!st.online) {
    console.log('⏭  未探测到后端 ' + BASE + '（' + st.error + '）');
    console.log('   先启动后端再跑本联调测试：cd server && STATIC_DIR=.. go run ./cmd/server');
    process.exit(0);
  }

  section('① 连接与镜像');
  ok(st.mode === 'server', '探测到后端 → server 模式');
  ok(Mall.loadCatalog().length >= 6, '商品镜像已从后端拉取（' + Mall.loadCatalog().length + ' 条）');
  ok(!!Mall.getProduct(CODE), '镜像里能查到 ' + CODE);

  section('② 下单：服务端算价 + 扣库存');
  await SdyApi.setStock(CODE, 120);
  const before = await serverStock(CODE);
  ok(before === 120, '先把库存置为 120（服务端确认 ' + before + '）');

  Mall.clearCart();
  Mall.addToCart(CODE, 3);
  const o1 = await SdyApi.createOrder({ deliveryType: 'pickup', customer: { name: '联调自提', phone: '13800000001' } });
  ok(/^M\d+$/.test(o1.id), '下单成功，订单号 ' + o1.id);
  ok(Math.abs(o1.subtotal - 7.5) < 1e-6 && o1.deliveryFee === 0 && Math.abs(o1.total - 7.5) < 1e-6, '自提 3 罐：7.5 + 0 = 7.5');
  const after1 = await serverStock(CODE);
  ok(after1 === before - 3, '服务端库存 120 → ' + after1 + '（扣 3）');
  ok(Mall.getProduct(CODE).stock === after1, '本地镜像与后端一致（' + Mall.getProduct(CODE).stock + '）');

  section('③ 配送运费规则（服务端执行）');
  Mall.clearCart();
  Mall.addToCart(CODE, 1);   // 2.5 元 < 30 → 运费 3
  const o2 = await SdyApi.createOrder({ deliveryType: 'delivery', customer: { name: '联调配送', phone: '13800000002', address: '1 号楼 101' } });
  ok(Math.abs(o2.subtotal - 2.5) < 1e-6 && o2.deliveryFee === 3 && Math.abs(o2.total - 5.5) < 1e-6, '配送 2.5 元 → 运费 3 元，合计 5.5');

  section('④ 状态流转与非法流转');
  const dv = await SdyApi.advanceOrder(o1.id, 'delivering');
  ok(dv.status === 'delivering', 'pending → delivering 成功');
  let illegal = '';
  try { await SdyApi.advanceOrder(o1.id, 'pending'); } catch (e) { illegal = e.message; }
  ok(illegal.indexOf('状态不允许') >= 0, '非法流转被后端拒绝：' + illegal);
  const dn = await SdyApi.advanceOrder(o1.id, 'done');
  ok(dn.status === 'done', 'delivering → done 成功');

  section('⑤ 取消订单 → 服务端回补库存');
  const beforeCancel = await serverStock(CODE);
  const cx = await SdyApi.cancelOrder(o2.id);
  ok(cx.status === 'cancelled', '订单已取消（' + o2.id + '）');
  const afterCancel = await serverStock(CODE);
  ok(afterCancel === beforeCancel + 1, '库存 ' + beforeCancel + ' → ' + afterCancel + '（回补 1）');

  section('⑥ 条码解析与比价巡检');
  const bc = await SdyApi.resolveBarcode(CODE);
  ok(bc.source === 'product' && bc.found === true, '条码解析命中商品档案（source=' + bc.source + '）');
  const pk = await SdyApi.pricingCheck();
  ok(pk.total >= 6 && pk.over === 0, '比价巡检 total=' + pk.total + ' over=' + pk.over);

  section('⑦ 批发价与顾客等级（D24，真后端算价）');
  const PH = '13800002222';
  const prod = Mall.getProduct(CODE);
  const base = { code: prod.code, name: prod.name, brand: prod.brand, spec: prod.spec, category: prod.category,
    img: prod.img || '', costPrice: prod.costPrice, salePrice: prod.salePrice, refPrice: prod.refPrice,
    unit: prod.unit, isWholesale: false };
  await SdyApi.upsertProduct(Object.assign({}, base, { wholesalePrice: 2.2 }));
  await SdyApi.setCustomerTier(PH, '联调批发', 'wholesale');
  const rw = await SdyApi.setMyPhone(PH);
  ok(rw.tier === 'wholesale', '设手机号后服务端回等级 wholesale');
  ok(Math.abs(Mall.getProduct(CODE).price - 2.2) < 1e-6, '带手机号取价：服务端下发批发价 ' + Mall.getProduct(CODE).price);
  Mall.clearCart();
  Mall.addToCart(CODE, 2);
  const o3 = await SdyApi.createOrder({ deliveryType: 'pickup', customer: { name: '联调批发', phone: PH } });
  ok(Math.abs(o3.subtotal - 4.4) < 1e-6 && Math.abs(o3.items[0].price - 2.2) < 1e-6, '批发客户下单按批发价算：2.2×2 = 4.4（前端传价不参与）');
  const rr = await SdyApi.setCustomerTier(PH, '联调批发', 'retail');
  const rl = await SdyApi.setMyPhone(PH);
  ok(rr.tier === 'retail' && rl.tier === 'retail' && Math.abs(Mall.getProduct(CODE).price - 2.5) < 1e-6, '改回零售 → 取价回 2.5');
  ok(Math.abs(o3.subtotal - 4.4) < 1e-6, '历史订单价格不变（下单当时快照）');
  ok((await SdyApi.listCustomers()).some(c => c.phone === PH), '顾客档案里能查到该手机号');
  // 清理演示数据：批发价清零 + 忘掉本机手机号
  await SdyApi.upsertProduct(Object.assign({}, base, { wholesalePrice: 0 }));
  Mall.setMyPhone('');
  ok(Math.abs(Mall.getProduct(CODE).price - 2.5) < 1e-6, '清理后可乐回到零售价 2.5');

  section('⑧ 库存审计 / 配送员 / 门店抬头 / 顾客备注（D25，真后端落库）');
  const logBefore = await SdyApi.listStockLog(500);
  const rIn = await SdyApi.changeStock(CODE, 'stock_in', 5, '联调入库', '联调');
  ok(rIn && rIn.ok === true && rIn.entry.kind === 'stock_in', '入库走 POST /api/stock/change，返回审计流水');
  ok(rIn.entry.before + 5 === rIn.entry.after && rIn.stock === rIn.entry.after,
    '流水前后值自洽且 stock=after：' + rIn.entry.before + ' → ' + rIn.entry.after);
  ok(rIn.entry.reason === '联调入库' && rIn.entry.by === '联调', '「为什么改 / 谁改的」都记下：' + rIn.entry.reason + ' / ' + rIn.entry.by);
  ok(!!rIn.entry.ts && rIn.entry.at > 0, '流水带时间戳（' + rIn.entry.ts + '）');
  ok((await serverStock(CODE)) === rIn.entry.after, '服务端库存 = 流水 after（' + rIn.entry.after + '）');
  ok(Mall.getProduct(CODE).stock === rIn.entry.after, '本地镜像自动对齐 after（' + Mall.getProduct(CODE).stock + '）');

  const rAdj = await SdyApi.changeStock(CODE, 'adjust', -3, '联调改数', '联调');
  ok(Math.abs(rAdj.entry.delta + 3) < 1e-6, '改数流水 delta = ' + rAdj.entry.delta);
  const rTake = await SdyApi.changeStock(CODE, 'stock_take', rAdj.entry.after, '联调盘点', '联调');
  ok(rTake.entry.delta === 0 && rTake.entry.after === rAdj.entry.after, '盘点以实盘为准（delta=' + rTake.entry.delta + '，账面=' + rTake.entry.after + '）');

  let badQty = '';
  try { await SdyApi.changeStock(CODE, 'adjust', 0, '', '联调'); } catch (e) { badQty = e.message; }
  ok(badQty.indexOf('不能为 0') >= 0, '非法改数被后端拒绝：' + badQty);
  const log2 = await SdyApi.listStockLog(2);
  ok(log2.length === 2 && log2[0].id > log2[1].id, '流水按时间倒序、limit=2 生效');
  ok(log2[0].code === CODE, '最新一条就是刚才那笔（' + log2[0].kind + '）');
  const logAfter = await SdyApi.listStockLog(500);
  ok(logAfter.length === Math.min(500, logBefore.length + 3), '三笔变更各留一条审计（' + logBefore.length + ' → ' + logAfter.length + '）');

  const c0 = await SdyApi.listCouriers();
  ok(c0.length >= 4 && c0.some(c => c.name === '老张'), '配送员名单来自后端（' + c0.length + ' 人，含老张）');
  const c1 = await SdyApi.saveCourier('联调临时', '13700000009');
  ok(c1.some(c => c.name === '联调临时'), '新增配送员落库（' + c1.length + ' 人）');
  const c2 = await SdyApi.saveCourier('联调临时', '', true);
  ok(!c2.some(c => c.name === '联调临时') && c2.length === c0.length, '删除后回到 ' + c2.length + ' 人');

  const s0 = await SdyApi.getSettings();
  ok(!!s0 && !!s0.name, '门店抬头来自后端（' + s0.name + '）');
  const s1 = await SdyApi.saveSettings({ name: '联调小店', phone: '0591-0000000', address: '联调路 1 号', footer: '' });
  ok(s1.name === '联调小店' && !!s1.footer, '保存抬头，页脚留空回默认（' + s1.footer + '）');
  const s2 = await SdyApi.getSettings();
  ok(s2.name === '联调小店' && s2.phone === '0591-0000000', '重新读取仍是保存后的值（真落库）');
  await SdyApi.saveSettings({ name: s0.name, phone: s0.phone, address: s0.address, footer: s0.footer });
  ok((await SdyApi.getSettings()).name === s0.name, '还原原抬头（' + s0.name + '）');

  const PH2 = '13800003333';
  const n1 = await SdyApi.setCustomerNote(PH2, '联调备注顾客', '熟客', '每周三来拿两箱水');
  ok(n1.phone === PH2 && n1.tags === '熟客' && n1.note.indexOf('两箱水') >= 0, '顾客备注与标签落库');
  ok(n1.tier === 'retail', '只登记备注不动等级（tier=' + n1.tier + '）');
  const cust = (await SdyApi.listCustomers()).find(c => c.phone === PH2);
  ok(!!cust && cust.tags === '熟客' && cust.note.indexOf('两箱水') >= 0, '顾客档案里能查到备注与标签');
  let badNote = '';
  try { await SdyApi.setCustomerNote(PH2, '', '', 'x'.repeat(201)); } catch (e) { badNote = e.message; }
  ok(badNote.indexOf('200') >= 0, '超长备注被后端拒绝：' + badNote);

  section('⑨ 离线降级路径（错误地址）');
  SdyApi._resetForTest();
  const st2 = await SdyApi.boot({ base: 'http://127.0.0.1:1', mall: Mall, timeoutMs: 600 });
  ok(st2.online === false, '连不上时自动退回本地演示模式');
  ok((await SdyApi.changeStock(CODE, 'stock_in', 1, '', '')) === null, '离线时库存变更不发请求、返回 null');
  ok((await SdyApi.listCouriers()) === null && (await SdyApi.getSettings()) === null, '离线时配送员/门店抬头返回 null');
  ok((await SdyApi.listStockLog(30)) === null && (await SdyApi.setCustomerNote('13800009999', '', '', '')) === null, '离线时流水/备注返回 null');

  console.log('\n========================================');
  console.log('联调通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

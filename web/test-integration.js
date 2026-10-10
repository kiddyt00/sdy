/* =====================================================================
 * 端到端联调测试：真 fetch → 真 Go 后端（不是假 fetch）
 *   验证「前端页面代码（Mall + SdyApi）」与「后端 HTTP API」确实对得上：
 *   下单扣库存 / 运费规则 / 状态流转 / 非法流转 409 / 取消回补 / 比价巡检 / 条码解析
 *
 * 用法：
 *   1) 先启动后端：cd server && STATIC_DIR=.. go run ./cmd/server
 *   2) 再跑本测试：node mall-demo/test-integration.js
 *   （可用 SDY_API_BASE 指定地址；未探测到后端时自动跳过，退出码 0）
 * ===================================================================== */
'use strict';
const Mall = require('./mall.js');
const SdyApi = require('./sdy-api.js');

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

  const st = await SdyApi.boot({ base: BASE, mall: Mall, timeoutMs: 1500 });
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

  section('⑦ 离线降级路径（错误地址）');
  SdyApi._resetForTest();
  const st2 = await SdyApi.boot({ base: 'http://127.0.0.1:1', mall: Mall, timeoutMs: 600 });
  ok(st2.online === false, '连不上时自动退回本地演示模式');

  console.log('\n========================================');
  console.log('联调通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
  process.exit(failed ? 1 : 0);
})();

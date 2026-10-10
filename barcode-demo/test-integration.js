/* =====================================================================
 * barcode-demo/test-integration.js —— 扫码台 ↔ 真 Go 后端 端到端联调
 *
 * 跑法：
 *   cd server && ADDR=127.0.0.1:8097 DB_PATH=/tmp/sdy-bd.db STATIC_DIR=.. /tmp/sdy-bd-server
 *   SDY_API_BASE=http://127.0.0.1:8097 node barcode-demo/test-integration.js
 * 后端不在时自动跳过（exit 0），不阻塞纯前端开发。
 * ===================================================================== */
'use strict';

const BdApi = require('./bd-api.js');

const BASE = process.env.SDY_API_BASE || 'http://127.0.0.1:8093';
const NEW_CODE = '699' + String(Date.now()).slice(-10);  // 联调专用：每跑一次换号，避免重复跑时撞「该条码已在商品库」

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) pass++;
  else { fail++; console.log('  ❌ ' + msg); }
}
function eq(got, want, msg) { ok(got === want, msg + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）'); }
function group(n) { console.log('\n▶ ' + n); }

(async function main() {
  console.log('=== 扫码台 ↔ Go 后端联调（' + BASE + '） ===');
  BdApi.reset();
  BdApi.configure({ base: BASE, timeoutMs: 3000 });

  let st;
  try {
    st = await BdApi.detect();
  } catch (e) {
    st = { online: false };
  }
  if (!st.online) {
    console.log('⏭  后端未启动，跳过联调（' + st.error + '）');
    process.exit(0);
  }
  ok(true, '后端已连接');

  group('1. 健康检查与模式');
  eq(st.mode, 'server', 'mode=server');
  eq(st.cloudConfigured, false, '未配 BARCODE_APPCODE → cloudConfigured=false');

  group('2. 商品库镜像（服务端为真源）');
  const ps = await BdApi.listProducts();
  ok(ps.length >= 6, '种子商品至少 6 条（联调库可能已被追加建档），实际 ' + ps.length);
  const coke = ps.find(p => p.code === '6901234567892');
  ok(!!coke, '应含可口可乐 6901234567892');
  eq(coke.name, '可口可乐', '名称来自服务端');
  eq(coke.salePrice, 2.5, '售价 2.5');
  ok(typeof coke.stock === 'number' && coke.stock >= 0, '库存为数字');
  // 联调库可能已被真实下单/改数动过，故只记基线、不断言等于种子值
  const cokeStock = coke.stock;
  eq(coke.unit, '罐', '单位 罐');
  ok(coke.server === true, '镜像项标记 server=true');

  group('3. 条码字典层（扫码台能看到库里数据）');
  const lib = await BdApi.listLib(200);
  ok(lib.length >= 6, '字典层至少有 6 条（建档即沉淀），实际 ' + lib.length);
  const libCoke = lib.find(e => e.code === '6901234567892');
  ok(!!libCoke, '字典层应含可口可乐');
  eq(libCoke.source, 'product', '来源标注为建档沉淀');
  eq(libCoke.status, 'normal', '状态正常（可建档）');
  const limited = await BdApi.listLib(3);
  eq(limited.length, 3, 'limit=3 生效');

  group('4. 解析链（服务端执行，APPCODE 不在页面）');
  let r = await BdApi.resolveForDemo('6901234567892');
  eq(r.source, 'product', '已建档码 → 档案层命中');
  eq(r.product.name, '可口可乐', '档案命中带出名称');
  eq(r.product.salePrice, 2.5, '档案命中带出价格（非云端价）');
  eq(r.product.stock, cokeStock, '档案命中带出库存（与商品库一致）');

  r = await BdApi.resolveForDemo('6901234567892'.slice(0, 12) + '0'); // 未建档且形如条码
  eq(r.source, 'cloud_error', '未配 APPCODE → 纯本地模式（cloud_error）');
  ok(r.msg.indexOf('云端未配置') >= 0, '错误说明应提示服务端未配 APPCODE，实际 ' + r.msg);

  group('5. 建档写服务端（人工确认后）');
  let created = null, err5 = '';
  try {
    created = await BdApi.createProduct({
      code: NEW_CODE, name: '联调测试商品（可删）', brand: '测试', spec: '500ml',
      category: '饮料', costPrice: '3.5', salePrice: '5.5', unit: '瓶', stock: '12'
    });
  } catch (e) { err5 = e.message; }
  eq(err5, '', '建档请求不应报错：' + err5);
  created = created || {};   // 建档失败时后续断言给出可读结果而不是 TypeError
  eq(created.code, NEW_CODE, '返回服务端商品条码');
  eq(created.salePrice, 5.5, '售价按人工填写写入');
  eq(created.stock, 12, '期初库存按人工填写写入');
  eq(created.syncStatus, '待同步', '新建档 → 待同步牵牛花');

  r = await BdApi.resolveForDemo(NEW_CODE);
  eq(r.source, 'product', '建档后立刻能从档案层命中');
  eq(r.product.salePrice, 5.5, '命中即带人工填的价格');

  const lib2 = await BdApi.listLib(200);
  const newLib = lib2.find(e => e.code === NEW_CODE);
  ok(!!newLib, '建档应同时沉淀字典层');
  eq(newLib.source, 'product', '新字典项来源 product');

  let dup = '';
  try { await BdApi.createProduct({ code: NEW_CODE, name: '重复建档' }); } catch (e) { dup = e.message; }
  ok(dup.indexOf('已在商品库') >= 0, '重复建档应被拦下，实际 ' + dup);

  group('6. 离线降级');
  BdApi.configure({ base: 'http://127.0.0.1:9' });           // 保留真 fetch，但指向死端口
  const bad = await BdApi.detect();
  eq(bad.online, false, '后端不可达 → online=false');
  eq(bad.mode, 'local', '退回本地演示模式');
  ok(bad.label.indexOf('本地演示') >= 0, '胶囊文案为本地演示');

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILED') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('联调异常：', e); process.exit(1); });

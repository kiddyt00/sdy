'use strict';
/* 核心链路自动化测试（Node 环境，不依赖浏览器）
 * 运行：node test-core.js
 * 覆盖：product/lib/cloud/none 四级命中、回填、防重调、配额、熔断、建档闭环
 */
const assert = require('assert');
const DemoApp = require('./app.js');
const T = DemoApp._test;

(async () => {
  // ---------- ① 商品库命中（永不调云端） ----------
  T.reset();
  DemoApp.seedData();
  let r = await DemoApp.resolve('6901234567892');
  assert.strictEqual(r.source, 'product', '商品库应命中');
  assert.ok(r.product.salePrice > 0, '商品库应含售价');
  assert.strictEqual(DemoApp._state.usage.count, 0, '商品库命中不消耗云端配额');

  // ---------- ② 条码库字典命中（不调云端） ----------
  r = await DemoApp.resolve('6902083884567');
  assert.strictEqual(r.source, 'lib', '条码库字典应命中');
  assert.strictEqual(r.entry.status, 'normal');

  // ---------- ③ 云端新码 → 回填条码库 → 二次命中本地 ----------
  const u0 = DemoApp._state.usage.count;
  r = await DemoApp.resolve('6901028076768');
  assert.strictEqual(r.source, 'cloud', '双库未命中应调云端');
  assert.strictEqual(DemoApp._state.usage.count, u0 + 1, '云端调用应 +1');
  const libEntry = DemoApp._state.lib.find(x => x.code === '6901028076768');
  assert.ok(libEntry && libEntry.status === 'normal' && libEntry.source === 'cloud', '云端结果应回填条码库');

  const u1 = DemoApp._state.usage.count;
  r = await DemoApp.resolve('6901028076768');
  assert.strictEqual(r.source, 'lib', '回填后二次扫码应命中本地条码库');
  assert.strictEqual(DemoApp._state.usage.count, u1, '二次扫码不再调云端');

  // ---------- ④ 查无（种子标记 + 云端查无 → 记标记后不重复调） ----------
  r = await DemoApp.resolve('6900000000000');
  assert.strictEqual(r.source, 'none', '查无标记有效期内应直接返回查无');

  const u2 = DemoApp._state.usage.count;
  r = await DemoApp.resolve('6904321000999');
  assert.strictEqual(r.source, 'none', '云端查无应返回查无');
  assert.strictEqual(DemoApp._state.usage.count, u2 + 1);
  const nf = DemoApp._state.lib.find(x => x.code === '6904321000999');
  assert.ok(nf && nf.status === 'not_found' && nf.notFoundUntil > Date.now(), '应记录查无标记(TTL)');

  const u3 = DemoApp._state.usage.count;
  r = await DemoApp.resolve('6904321000999');
  assert.strictEqual(r.source, 'none');
  assert.strictEqual(DemoApp._state.usage.count, u3, '查无标记有效期内不重复调云端');

  // ---------- ⑤ 建档闭环 ----------
  DemoApp.createProduct({ code: '6904321000999', name: '测试商品', brand: 'T', spec: '1件', costPrice: 1, salePrice: 2, unit: '件', stock: 10 });
  r = await DemoApp.resolve('6904321000999');
  assert.strictEqual(r.source, 'product', '建档后应商品库命中');
  assert.strictEqual(r.product.salePrice, 2);

  // ---------- ⑥ 配额 ----------
  T.reset(); DemoApp.seedData();
  T.setSettings({ quota: 2 });
  await DemoApp.resolve('6901010000001');
  await DemoApp.resolve('6901010000002');
  r = await DemoApp.resolve('6901010000003');
  assert.strictEqual(r.source, 'quota', '配额用尽应拦截');
  assert.strictEqual(DemoApp._state.usage.count, 2);

  // ---------- ⑦ 失败熔断 ----------
  T.reset(); DemoApp.seedData();
  T.setSettings({ failSim: true });
  const srcs = [];
  for (let i = 0; i < 6; i++) srcs.push((await DemoApp.resolve('690111000000' + i)).source);
  assert.strictEqual(srcs[4], 'cloud_error', '第5次应为 cloud_error（实际 ' + srcs[4] + '）');
  assert.strictEqual(srcs[5], 'blocked', '熔断后应直接 blocked（实际 ' + srcs[5] + '）');
  assert.ok(DemoApp._state.circuitUntil > Date.now(), '应记录当日熔断截止');

  // ---------- 校验工具 ----------
  assert.strictEqual(T.isValid('6901234567892'), true);   // 13位 EAN-13
  assert.strictEqual(T.isValid('690123456789'), true);    // 12位 UPC-A
  assert.strictEqual(T.isValid('12345'), false);          // 5位 非法
  assert.strictEqual(T.isValid('690a1234567892'), false); // 含字母 非法
  assert.strictEqual(T.normCode(' 690 123 456 7892 '), '6901234567892');

  console.log('ALL TESTS PASSED ✔  (sources: ' + srcs.join(',') + ')');
})().catch(e => { console.error('TEST FAILED:', e.message); process.exit(1); });

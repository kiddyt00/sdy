/* =====================================================================
 * barcode-demo/test-api.js —— 扫码台后端通道（bd-api.js）离线/在线双路径测试
 * 运行：node barcode-demo/test-api.js
 * 纯假 fetch，不需要真后端；真后端联调见 test-integration.js
 * ===================================================================== */
'use strict';

const BdApi = require('./bd-api.js');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.log('  ❌ ' + msg); }
}
function eq(got, want, msg) { ok(got === want, msg + '（期望 ' + JSON.stringify(want) + '，实际 ' + JSON.stringify(got) + '）'); }
function group(name) { console.log('\n▶ ' + name); }

function installLS() {
  const mem = {};
  global.localStorage = {
    getItem: k => (k in mem ? mem[k] : null),
    setItem: (k, v) => { mem[k] = String(v); },
    removeItem: k => { delete mem[k]; }
  };
  return mem;
}

function makeFetch(routes) {
  const calls = [];
  const fn = async (url, opts) => {
    const method = (opts && opts.method) || 'GET';
    calls.push({ method, url, body: opts && opts.body ? JSON.parse(opts.body) : null });
    for (const r of routes) {
      if ((r.method || 'GET') === method && url.indexOf(r.match) >= 0) {
        if (r.throw) throw new Error(r.throw);
        return { ok: r.status ? r.status < 400 : true, status: r.status || 200, json: async () => r.body };
      }
    }
    throw new Error('no route: ' + method + ' ' + url);
  };
  fn.calls = calls;
  return fn;
}

(async function main() {
  console.log('=== barcode-demo 后端通道测试（bd-api.js） ===');

  /* ---------------- 1. 探测：后端不在 ---------------- */
  group('1. 探测 · 后端未启动 → 自动退回本地演示');
  installLS();
  BdApi.reset();
  BdApi.configure({ base: 'http://127.0.0.1:8093', fetchImpl: makeFetch([{ match: '/healthz', throw: 'ECONNREFUSED' }]), timeoutMs: 500 });
  let st = await BdApi.detect();
  eq(st.online, false, '离线时 online 应为 false');
  eq(st.mode, 'local', '离线 mode 应为 local');
  ok(st.label.indexOf('本地演示') >= 0, '离线胶囊文案应为「本地演示」，实际 ' + st.label);
  ok(st.error.indexOf('无法连接后端') >= 0, '离线应记录可读错误，实际 ' + st.error);
  eq(BdApi.online(), false, 'online() 与状态一致');

  /* ---------------- 2. 探测：后端在线 ---------------- */
  group('2. 探测 · 后端在线 → 解析/建档交给服务端');
  const f2 = makeFetch([{ match: '/healthz', body: { ok: true, circuitOpen: false, cloudFails: 0, cloudConfigured: true } }]);
  BdApi.configure({ fetchImpl: f2, base: 'http://127.0.0.1:8093/' });
  st = await BdApi.detect();
  eq(st.online, true, '在线时 online 应为 true');
  eq(st.mode, 'server', '在线 mode 应为 server');
  eq(st.cloudConfigured, true, 'cloudConfigured 应透传 healthz');
  ok(st.label.indexOf('后端已连接') >= 0, '在线胶囊文案应为「后端已连接」，实际 ' + st.label);
  ok(st.detail.indexOf('APPCODE 只在服务端') >= 0, '在线说明应点明 APPCODE 只在服务端，实际 ' + st.detail);
  eq(f2.calls[0].url, 'http://127.0.0.1:8093/healthz', 'base 结尾斜杠应被规整（不能出现 //healthz）');
  eq(BdApi.base(), 'http://127.0.0.1:8093', 'base() 应去掉结尾斜杠');

  /* ---------------- 3. 解析链结果映射 ---------------- */
  group('3. resolveForDemo · 服务端解析结果 → 扫码台展示结构');
  let f = makeFetch([
    { match: '/api/barcode/resolve', body: { code: '6901234567892', found: true, name: '可口可乐', spec: '330ml 罐装', source: 'product' } },
    { match: '/api/products?keyword=', body: { items: [{ code: '6901234567892', name: '可口可乐', spec: '330ml 罐装', brand: '可口可乐', unit: '罐', salePrice: 2.5, costPrice: 2.2, stock: 117, syncStatus: 'pending', createdAt: '2026-10-10T10:00:00+08:00' }], total: 1 } }
  ]);
  BdApi.configure({ fetchImpl: f, base: '' });
  let r = await BdApi.resolveForDemo('6901234567892');
  eq(r.source, 'product', '档案命中 → source=product');
  eq(r.server, true, '结果应标记 server=true');
  eq(r.product.salePrice, 2.5, '价格取自服务端档案（不填 0）');
  eq(r.product.stock, 117, '库存取自服务端档案');
  eq(r.product.syncStatus, '待同步', 'syncStatus=pending → 待同步');
  ok(r.product.createdAt > 0, 'createdAt 应转成毫秒时间戳');

  f = makeFetch([
    { match: '/api/barcode/resolve', body: { code: '6901234567892', found: true, name: '可口可乐', spec: '330ml', source: 'product' } },
    { match: '/api/products?keyword=', body: { items: [], total: 0 } }
  ]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6901234567892');
  eq(r.source, 'product', '档案在库但明细查不到时仍按 product 展示');
  eq(r.product.salePrice, 0, '拿不到明细时价格回 0（绝不用云端价顶替）');

  f = makeFetch([{ match: '/api/barcode/resolve', body: { code: '6902083884567', found: true, name: '东方树叶 乌龙茶', spec: '500ml', source: 'lib' } }]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6902083884567');
  eq(r.source, 'lib', '字典命中 → source=lib');
  eq(r.entry.name, '东方树叶 乌龙茶', '字典项名称透传');
  eq(r.entry.status, 'normal', '字典命中可建档');

  f = makeFetch([{ match: '/api/barcode/resolve', body: { code: '6901028076768', found: true, name: '康师傅红烧牛肉面', spec: '桶装 104g', source: 'cloud' } }]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6901028076768');
  eq(r.source, 'cloud', '云端查到 → source=cloud（已回填字典）');
  eq(r.entry.source, 'cloud', '字典来源标记为云端');

  const in89 = new Date(Date.now() + 89 * 86400000).toISOString();
  f = makeFetch([{ match: '/api/barcode/resolve', body: { code: '6900000000000', found: false, source: 'not_found', expiresAt: in89 } }]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6900000000000');
  eq(r.source, 'none', '查无 → source=none');
  eq(r.negative, true, '查无应带 negative 标记');
  eq(r.remainDays, 89, '剩余天数由服务端 expiresAt 算出');

  f = makeFetch([{ match: '/api/barcode/resolve', body: { code: '6904321000999', found: false, source: 'blocked', error: '云端查询已熔断（连续失败过多），今日不再调用，可手动建档' } }]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6904321000999');
  eq(r.source, 'blocked', '熔断 → source=blocked');
  ok(r.msg.indexOf('熔断') >= 0, '熔断应带服务端原话，实际 ' + r.msg);

  f = makeFetch([{ match: '/api/barcode/resolve', body: { code: '6904321000999', found: false, source: 'cloud_error', error: '云端未配置（纯本地模式）' } }]);
  BdApi.configure({ fetchImpl: f });
  r = await BdApi.resolveForDemo('6904321000999');
  eq(r.source, 'cloud_error', '未配 APPCODE → source=cloud_error');
  ok(r.msg.indexOf('云端未配置') >= 0, '错误信息应透传');

  /* ---------------- 4. 建档写服务端 ---------------- */
  group('4. createProduct · 人工确认后写服务端（商品档案 + 字典层）');
  f = makeFetch([
    { match: '/api/products?keyword=', body: { items: [], total: 0 } },
    { match: '/api/products', method: 'POST', body: { code: '6999999999999', name: '测试商品', salePrice: 9.9, syncStatus: 'pending' } }
  ]);
  BdApi.configure({ fetchImpl: f });
  const created = await BdApi.createProduct({ code: '6999999999999', name: '测试商品', salePrice: '9.9', spec: '500ml' });
  const post = f.calls.find(c => c.method === 'POST');
  ok(!!post, '应发出 POST /api/products');
  eq(post.url, '/api/products', '建档 POST 到 /api/products');
  eq(post.body.syncStatus, 'pending', '新建档标记待同步牵牛花');
  eq(post.body.unit, '件', '未填单位时默认「件」');
  eq(post.body.salePrice, 9.9, '字符串价格应转数字');
  eq(post.body.stock, 0, '未填库存应为 0（绝不自动填）');
  eq(created.code, '6999999999999', '建档返回服务端商品');
  eq(created.server, true, '返回商品标记 server=true');

  f = makeFetch([
    { match: '/api/products?keyword=', body: { items: [{ code: '6901234567892', name: '可口可乐' }], total: 1 } }
  ]);
  BdApi.configure({ fetchImpl: f });
  let dupErr = '';
  try { await BdApi.createProduct({ code: '6901234567892', name: '重复' }); } catch (e) { dupErr = e.message; }
  ok(dupErr.indexOf('已在商品库') >= 0, '重复建档应被拦下，实际 ' + dupErr);
  eq(f.calls.filter(c => c.method === 'POST').length, 0, '重复建档不应发出 POST');

  f = makeFetch([
    { match: '/api/products?keyword=', body: { items: [], total: 0 } },
    { match: '/api/products', method: 'POST', status: 400, body: { error: '条码不能为空' } }
  ]);
  BdApi.configure({ fetchImpl: f });
  let srvErr = '';
  try { await BdApi.createProduct({ code: '6900000000001', name: 'x' }); } catch (e) { srvErr = e.message; }
  eq(srvErr, '条码不能为空', '服务端 400 的 error 原文应直出（不吞错）');

  /* ---------------- 5. 列表映射与 base 优先级 ---------------- */
  group('5. 列表映射 · 商品库/条码字典镜像 + base 优先级');
  f = makeFetch([
    { match: '/api/products?keyword=', body: { items: [], total: 0 } },
    { match: '/api/products', body: { items: [
      { code: '6901', name: '可乐', salePrice: 2.5, stock: 3, unit: '罐', syncStatus: 'synced' },
      { code: '6902', name: '雪碧', salePrice: 2.5, stock: 0, unit: '罐', syncStatus: 'pending' }
    ], total: 2 } },
    { match: '/api/barcode/lib', body: { items: [
      { code: '6901', name: '可乐', spec: '330ml', source: 'product', status: 'found', hits: 7, updatedAt: '2026-10-10T10:00:00+08:00' },
      { code: '6900000000000', source: 'cloud', status: 'not_found', hits: 1, expiresAt: in89 }
    ], total: 2 } }
  ]);
  BdApi.configure({ fetchImpl: f });
  const ps = await BdApi.listProducts();
  eq(ps.length, 2, '商品镜像 2 条');
  eq(ps[0].syncStatus, '已同步', 'synced → 已同步');
  eq(ps[1].syncStatus, '待同步', 'pending → 待同步');
  const lib = await BdApi.listLib(300);
  eq(f.calls.filter(c => c.url.indexOf('/api/barcode/lib?limit=300') === 0).length, 1, 'limit 应透传到字典接口');
  eq(lib[0].status, 'normal', 'found → normal（可建档）');
  eq(lib[0].source, 'product', '字典来源 product（建档沉淀）');
  eq(lib[1].status, 'not_found', 'not_found 标记保留');
  ok(lib[1].notFoundUntil > Date.now(), '查无标记到期时间应转成毫秒');

  installLS();
  BdApi.reset();
  global.window = { SDY_API_BASE: 'http://window-host:8093' };
  eq(BdApi.base(), 'http://window-host:8093', '无 localStorage 时取 window.SDY_API_BASE');
  BdApi.setBase('http://ls-host:8093');
  eq(BdApi.base(), 'http://ls-host:8093', 'localStorage 优先于 window');
  BdApi.configure({ base: 'http://cfg-host:8093' });
  eq(BdApi.base(), 'http://cfg-host:8093', 'configure(base) 优先级最高');
  BdApi.setBase('');
  BdApi.configure({ base: '' });
  eq(BdApi.base(), 'http://window-host:8093', 'setBase("") 应清空并回落到 window');
  delete global.window;

  console.log('\n' + (fail === 0 ? '✅ ALL PASS' : '❌ FAILED') + '：' + pass + ' 通过 / ' + fail + ' 失败');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('测试异常：', e); process.exit(1); });

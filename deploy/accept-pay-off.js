#!/usr/bin/env node
/**
 * 「微信支付未开通」模式下的端到端契约验收：真后端 + 假微信登录 + 假微信支付（旁观者）。
 *
 * 用法：node deploy/accept-pay-off.js              （自己起进程，跑完自己清理）
 *      SDY_BIN=/tmp/sdy-payoff node deploy/accept-pay-off.js
 *
 * 这是本轮修的一个**真实生产缺陷**的回归测试：以前支付没配置时，扫单 goroutine 照样会把
 * 正常订单在 15 分钟后自动取消并回补库存，导致店铺停摆。本脚本把 15 分钟压成「1 秒有效期 +
 * 1 秒扫单间隔」，等 5 秒以上（扫单跑了好几轮）后证明订单**没有被误杀**。
 *
 * 覆盖：① 未配置支付仍能启动 + /api/settings 的 payEnabled 严格 false 且 8 个平铺键一个不少 /
 *      ② 未开通 ≠ 不能下单（201 / payExpireAt=0 / 真扣库存）/
 *      ③ **不误杀**（核心：等 5 秒扫单数轮，订单仍 pending、库存不回补）/
 *      ④⑤⑥ prepay / pay-notify / refund-notify 未配置一律 503 + 固定文案 /
 *      ⑦ 线下 mark-paid 兜底 + paid 筛选口径不受支付开关影响 /
 *      ⑧ 取消已付款单仍成功，refundState=fail + refundError 文案 /
 *      ⑨ 前端「未开通」分支的静态契约（三端一致：取不到配置 = 未开通）/
 *      ⑩ 假微信支付服务全程**一次 /v3 请求都没收到**（未配置就绝不联系微信支付）。
 *
 * 设计说明：
 * - 本脚本刻意**一个 WXPAY_* 都不配**（这就是被验收的场景），只配小程序登录要用的
 *   WX_APPID / WX_SECRET / WX_API_BASE。子进程环境里还会主动剔除任何继承来的 WXPAY_*，
 *   保证「未开通」是真的未开通。
 * - 端口与 accept-pay.js 错开，两个脚本可以同时跑：
 *   API = PAYOFF_API_PORT(默认 8096)，假支付 = PAYOFF_FAKE_PORT(默认 8090)，假微信 = PAYOFF_WX_PORT(默认 8091)。
 * - 假支付服务只做「旁观者」：验证期间它不该收到任何 /v3 调用（§⑩ 的零请求断言）。
 * - 只用 Node/Go 标准能力（http/child_process/fs），不新增任何依赖。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BIN = process.env.SDY_BIN || '/tmp/sdy-payoff';
const API_PORT = Number(process.env.PAYOFF_API_PORT || 8096);
const FAKE_PORT = Number(process.env.PAYOFF_FAKE_PORT || 8090);
const WX_PORT = Number(process.env.PAYOFF_WX_PORT || 8091);
const BASE = 'http://127.0.0.1:' + API_PORT;
const FAKE = 'http://127.0.0.1:' + FAKE_PORT;
const RUN = 'POFF' + String(Date.now()).slice(-6);
const PHONE_A = '13800009101';
const PHONE_B = '13800009102';

// 服务端固定文案（逐字来自 server/cmd/server/pay.go:78 与 server/cmd/server/pay.go:528）
const PAY_NOT_CONFIGURED = '微信支付未配置（服务端缺少商户号 / 证书 / APIv3 密钥）';
const REFUND_NOT_CONFIGURED = '微信支付未配置，无法自动退款（请到微信商户平台手工退款）';

let PASS = 0, FAIL = 0;
const FAILED = [];
const kids = [];
let TMP = '';

function section(t) { console.log('\n===== ' + t + ' ====='); }
function ok(cond, name, got) {
  if (cond) { PASS++; console.log('  ✔ ' + name); }
  else { FAIL++; FAILED.push(name); console.log('  ✘ ' + name + (got === undefined ? '' : '   → ' + JSON.stringify(got))); }
}
function info(msg) { console.log('  · ' + msg); }

async function json(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = null; }
  return { status: res.status, body, text, headers: res.headers };
}

// 服务端接口（可带身份头；管理员用 X-Admin，灰度档即放行）
async function api(method, p, body, headers) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  const init = { method, headers: h };
  if (body !== undefined && body !== null) init.body = JSON.stringify(body);
  return json(BASE + p, init);
}
const admin = () => ({ 'X-Admin': '1' });

function waitPort(url, tries) {
  return new Promise((resolve) => {
    let n = 0;
    const tick = async () => {
      n++;
      try { const r = await fetch(url); if (r.status < 500) return resolve(true); } catch (e) { /* 还没起来 */ }
      if (n >= (tries || 60)) return resolve(false);
      setTimeout(tick, 300);
    };
    tick();
  });
}

// 子进程日志里的密钥行一律不许外放（假密钥也不破例）。
const looksSecret = (line) => /WXPAY_|PRIVATE KEY|apiV3Key/i.test(line);

function startKid(name, args, env, onLine) {
  // 第一个参数是 .js → 用 node 跑；否则当成可执行文件直接跑（服务端 Go 二进制）。
  const isJS = /\.js$/.test(args[0]);
  const cmd = isJS ? process.execPath : args[0];
  const argv = isJS ? args : args.slice(1);
  const child = spawn(cmd, argv, {
    cwd: ROOT, env: Object.assign({}, process.env, env || {}), stdio: ['ignore', 'pipe', 'pipe'],
  });
  kids.push(child);
  let buf = '';
  const eat = (chunk) => {
    buf += String(chunk);
    const lines = buf.split('\n');
    buf = lines.pop();
    lines.forEach((l) => {
      if (onLine) onLine(l);
      if (process.env.PAYOFF_VERBOSE && !looksSecret(l)) process.stdout.write('[' + name + '] ' + l + '\n');
    });
  };
  child.stdout.on('data', eat);
  child.stderr.on('data', eat);
  return child;
}

function cleanup() {
  kids.forEach((c) => { try { c.kill('SIGKILL'); } catch (e) { /* 已退出 */ } });
  if (TMP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* 忽略 */ } }
}
process.on('exit', cleanup);
process.on('SIGINT', () => { cleanup(); process.exit(130); });

(async () => {
  console.log('未开通支付安全回归验收 → ' + BASE + '（假支付旁观 ' + FAKE + '，假微信 http://127.0.0.1:' + WX_PORT + '）');
  if (!fs.existsSync(BIN)) {
    console.log('找不到服务端二进制 ' + BIN + '（先 go build，或用 SDY_BIN= 指定）');
    process.exit(3);
  }

  // ⓪ 环境准备：起假支付（旁观）、假微信登录，起一个**不配任何 WXPAY_\*** 的临时后端
  section('⓪ 环境准备（一个 WXPAY_* 都不配）');
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdy-payoff-'));

  // 假支付服务只当「旁观者」：本脚本不会把 WXPAY_API_BASE 指过来，它应当一次 /v3 请求都收不到。
  let fakeReady = null, fakeFailed = '';
  startKid('fake-wxpay', [path.join(ROOT, 'deploy', 'fake-wxpay.js'),
    '--port=' + FAKE_PORT, '--keydir=' + path.join(TMP, 'fakepay')],
  null, (line) => {
    if (/EADDRINUSE|启动失败/.test(line)) fakeFailed = line.trim();
    const m = line.match(/FAKE_WXPAY_READY\s+(\{.*\})/);
    if (m) { try { fakeReady = JSON.parse(m[1]); } catch (e) { /* 忽略 */ } }
  });
  const fakeUp = await waitPort(FAKE + '/__state', 40);
  ok(fakeUp && fakeReady && !fakeFailed, '假微信支付服务已就绪（本脚本只让它旁观，不接后端）',
    { up: fakeUp, readyLine: !!fakeReady, err: fakeFailed || undefined });
  if (!fakeUp || fakeFailed) {
    console.log('假支付服务没起来。若提示端口被占用，请先腾出 ' + FAKE_PORT + '/tcp（PAYOFF_FAKE_PORT= 可换端口）后重跑。');
    return finish();
  }

  // 假微信登录（服务端要 openid → 手机号 才有顾客身份）
  startKid('fake-wx', [path.join(ROOT, 'deploy', 'fake-wx.js'), String(WX_PORT)]);
  const wxReady = await waitPort('http://127.0.0.1:' + WX_PORT + '/', 20);
  info('假微信登录服务就绪：' + wxReady);

  // 关键：把继承来的 WXPAY_* 全部剔除 —— 否则「未配置支付」这个场景就假了。
  const childEnv = Object.assign({}, process.env);
  const leaked = Object.keys(childEnv).filter((k) => /^WXPAY_/.test(k));
  leaked.forEach((k) => { delete childEnv[k]; });
  ok(leaked.length === 0, '进程环境里没有需要剔除的 WXPAY_*（本场景本就未配置）', leaked.join(','));

  const dbPath = path.join(TMP, 'payoff.db');
  const apiLogs = [];
  startKid('sdy-api', [BIN], Object.assign(childEnv, {
    ADDR: '127.0.0.1:' + API_PORT,
    DB_PATH: dbPath,
    STATIC_DIR: path.join(ROOT, 'web'),
    WX_APPID: 'wx_pay_test',
    WX_SECRET: 'sec_pay_test',
    WX_API_BASE: 'http://127.0.0.1:' + WX_PORT,
    // 刻意不配任何 WXPAY_*：这就是被验收的场景。
    // 把「15 分钟有效期」压成 1 秒、扫单 1 秒一轮，让误杀（如果有）在几秒内现形。
    PAY_EXPIRE_SECONDS: '1',
    PAY_SWEEP_INTERVAL: '1s',
  }), (l) => apiLogs.push(l));
  const apiReady = await waitPort(BASE + '/healthz', 60);
  ok(apiReady, '临时后端已就绪（未配置支付）', apiReady);
  if (!apiReady) { console.log('后端没起来，检查日志（PAYOFF_VERBOSE=1 看子进程输出）'); return finish(); }

  // ① 未配置支付仍能启动 + /api/settings 契约
  section('① 未配置支付仍能启动 + /api/settings（payEnabled 严格 false、8 个平铺键一个不少）');
  const hz = await api('GET', '/healthz');
  ok(hz.status === 200 && hz.body && hz.body.ok === true, '/healthz 200 且 ok=true', { s: hz.status, b: hz.body && hz.body.ok });
  ok(apiLogs.some((l) => /微信支付未启用/.test(l)), '启动日志如实记录「微信支付未启用」（按未配置起服务，不阻止启动）',
    apiLogs.filter((l) => /微信支付/.test(l))[0]);
  const st0 = await api('GET', '/api/settings');
  ok(st0.status === 200, 'GET /api/settings 200', st0.status);
  const cfg = st0.body || {};
  ok(Object.prototype.hasOwnProperty.call(cfg, 'payEnabled') && typeof cfg.payEnabled === 'boolean' && cfg.payEnabled === false,
    'payEnabled 严格布尔 false（不是 undefined / "false" / 0）', cfg.payEnabled);
  const FLAT_KEYS = ['name', 'phone', 'address', 'footer', 'lowStock', 'minOrder', 'deliveryFee', 'minFree'];
  const missing = FLAT_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(cfg, k));
  ok(missing.length === 0, '8 个既有平铺键一个不少', missing);
  ok(typeof cfg.name === 'string' && typeof cfg.phone === 'string' && typeof cfg.address === 'string' && typeof cfg.footer === 'string',
    '门店抬头四键仍是字符串', { name: typeof cfg.name, phone: typeof cfg.phone, address: typeof cfg.address, footer: typeof cfg.footer });
  ok(['lowStock', 'minOrder', 'deliveryFee', 'minFree'].every((k) => typeof cfg[k] === 'number' && isFinite(cfg[k])),
    '规则四键仍是数字', { lowStock: cfg.lowStock, minOrder: cfg.minOrder, deliveryFee: cfg.deliveryFee, minFree: cfg.minFree });

  // ② 未开通 ≠ 不能下单
  section('② 未开通支付 ≠ 不能下单（201 / payExpireAt=0 / 真扣库存）');
  const P = { A: RUN + 'A', B: RUN + 'B' };
  const mk = (code, name, price, stock) => ({ code, name, brand: '验收', spec: '500ml', category: '未开通验收',
    img: '', costPrice: 1, salePrice: price, wholesalePrice: price, refPrice: 0, unit: '瓶', stock, isWholesale: false });
  ok((await api('POST', '/api/products', mk(P.A, RUN + '未开通甲', 6, 20), admin())).status === 200, '建档 A');
  const loginA = await api('POST', '/api/wx/login', { code: 'poffA', phone: PHONE_A });
  ok(loginA.status === 200 && loginA.body && loginA.body.openid, '假微信登录拿到 openid', loginA.status);
  const openA = loginA.body && loginA.body.openid;

  const prodBefore = ((await api('GET', '/api/products')).body || {}).items || [];
  const stockBefore = (prodBefore.find((p) => p.code === P.A) || {}).stock;
  const created = await api('POST', '/api/orders', {
    customerName: RUN + '未开通甲', phone: PHONE_A, deliveryType: 'pickup',
    items: [{ code: P.A, qty: 2 }], clientToken: RUN + '-t1',
  }, { 'X-Wx-Openid': openA || '' });
  ok(created.status === 201, '下单成功（201）', created.status);
  const o1 = created.body || {};
  ok(o1.paid === false, '新订单 paid 严格 false', o1.paid);
  ok(o1.status === 'pending', '新订单 status=pending', o1.status);
  ok(o1.payExpireAt === 0, '未开通支付时 payExpireAt 恰为 0（不开未付倒计时，不进扫单候选）', o1.payExpireAt);
  const prodAfter = ((await api('GET', '/api/products')).body || {}).items || [];
  const stockAfterOrder = (prodAfter.find((p) => p.code === P.A) || {}).stock;
  ok(typeof stockBefore === 'number' && stockAfterOrder === stockBefore - 2,
    '下单真的扣了库存（前后差 = 购买量 2）', { before: stockBefore, after: stockAfterOrder });

  // ③ 核心：不误杀
  section('③ 不误杀（核心）：1 秒有效期 + 1 秒扫单，等 5 秒以上仍 pending、库存不回补');
  ok(apiLogs.some((l) => /间隔 1s/.test(l) && /未付有效期 1 秒/.test(l)),
    '扫单 goroutine 以 1s 间隔、1 秒有效期真的启动了', apiLogs.filter((l) => /扫单/.test(l))[0]);
  info('等待 5.2 秒（PAY_SWEEP_INTERVAL=1s → 扫单至少跑 3 轮）…');
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, 5200));
  const waitedMs = Date.now() - t0;
  ok(waitedMs >= 5000, '确实等了至少 5 秒（扫单至少 3 轮）', waitedMs);
  const swept = await api('GET', '/api/orders/' + o1.id, null, admin());
  ok(swept.status === 200 && swept.body && swept.body.status === 'pending',
    '过期窗口过去后订单仍 pending（没有被扫单误杀）', swept.body && swept.body.status);
  ok(swept.body && swept.body.paid === false, '订单仍未被标记已付款', swept.body && swept.body.paid);
  ok(swept.body && swept.body.payExpireAt === 0, 'payExpireAt 全程保持 0（扫单候选要求 >0，天然不会命中）', swept.body && swept.body.payExpireAt);
  const afterWait = ((await api('GET', '/api/products')).body || {}).items || [];
  const stockAfterWait = (afterWait.find((p) => p.code === P.A) || {}).stock;
  ok(stockAfterWait === stockAfterOrder, '库存没有被回补（扫单没把这一单当超时单处理）', { afterOrder: stockAfterOrder, afterWait: stockAfterWait });
  ok(!apiLogs.some((l) => /超时未付自动取消/.test(l)),
    '扫单日志里没有出现过「超时未付自动取消」（支付未开通时每轮直接跳过）',
    apiLogs.filter((l) => /超时未付自动取消/.test(l))[0]);

  // ④ 发起支付 → 503 + 固定文案
  section('④ POST /api/pay/prepay → 503 + 固定文案');
  const pre = await api('POST', '/api/pay/prepay', { orderId: o1.id }, { 'X-Wx-Openid': openA || '' });
  ok(pre.status === 503, 'prepay 回 503（未配置支付）', pre.status + ' ' + (pre.text || '').slice(0, 120));
  ok(pre.body && pre.body.error === PAY_NOT_CONFIGURED, 'prepay error 与固定文案整串全等', pre.body && pre.body.error);

  // ⑤ 支付回调 → 503 + code=FAIL
  section('⑤ POST /api/pay/notify → 503 + code=FAIL + 固定文案');
  const pn = await api('POST', '/api/pay/notify', { id: 'x', resource: { ciphertext: 'x', nonce: 'n', associated_data: 'transaction' } }, {
    'Wechatpay-Timestamp': String(Math.floor(Date.now() / 1000)), 'Wechatpay-Nonce': 'n1',
    'Wechatpay-Signature': 'AAAA', 'Wechatpay-Serial': 'BBBB',
  });
  ok(pn.status === 503, '支付回调回 503（未配置支付，绝不 500）', pn.status);
  ok(pn.body && pn.body.code === 'FAIL', '支付回调 code=FAIL', pn.body && pn.body.code);
  ok(pn.body && pn.body.message === PAY_NOT_CONFIGURED, '支付回调 message 与固定文案整串全等', pn.body && pn.body.message);

  // ⑥ 退款回调 → 503 + code=FAIL
  section('⑥ POST /api/pay/refund-notify → 503 + code=FAIL + 固定文案');
  const rn = await api('POST', '/api/pay/refund-notify', { id: 'x', resource: { ciphertext: 'x', nonce: 'n', associated_data: 'refund' } }, {
    'Wechatpay-Timestamp': String(Math.floor(Date.now() / 1000)), 'Wechatpay-Nonce': 'n1',
    'Wechatpay-Signature': 'AAAA', 'Wechatpay-Serial': 'BBBB',
  });
  ok(rn.status === 503, '退款回调回 503', rn.status);
  ok(rn.body && rn.body.code === 'FAIL', '退款回调 code=FAIL', rn.body && rn.body.code);
  ok(rn.body && rn.body.message === PAY_NOT_CONFIGURED, '退款回调 message 与固定文案整串全等', rn.body && rn.body.message);

  // ⑦ 线下收款兜底 + paid 口径
  section('⑦ 线下收款兜底（mark-paid）与 paid 筛选口径不受支付开关影响');
  ok((await api('POST', '/api/products', mk(P.B, RUN + '未开通乙', 3, 20), admin())).status === 200, '建档 B');
  const o2 = (await api('POST', '/api/orders', {
    customerName: RUN + '未开通乙', phone: PHONE_B, deliveryType: 'pickup',
    items: [{ code: P.B, qty: 1 }], clientToken: RUN + '-t2',
  }, { 'X-Phone': PHONE_B })).body;
  ok(!!(o2 && o2.id && o2.paid === false), '第二张未付款单已创建', o2 && { id: o2.id, paid: o2.paid });
  const mp = await api('POST', '/api/orders/' + o1.id + '/mark-paid', { note: '现金' }, admin());
  ok(mp.status === 200, '管理员 mark-paid → 200', mp.status + ' ' + (mp.text || '').slice(0, 120));
  const o1paid = await api('GET', '/api/orders/' + o1.id, null, admin());
  ok(o1paid.body && o1paid.body.paid === true, 'mark-paid 后订单已付款', o1paid.body && o1paid.body.paid);
  const ids = (r) => (((r.body || {}).items) || []).map((o) => o.id);
  const paidList = await api('GET', '/api/orders?paid=1&limit=200', null, admin());
  const unpaidList = await api('GET', '/api/orders?paid=0&limit=200', null, admin());
  ok(ids(paidList).indexOf(o1.id) >= 0, 'paid=1 含刚标记已付款的单', { o1: ids(paidList).indexOf(o1.id) });
  ok(ids(unpaidList).indexOf(o1.id) < 0, 'paid=0 不含已付款单', { o1: ids(unpaidList).indexOf(o1.id) });
  ok(ids(unpaidList).indexOf(o2.id) >= 0 && ids(paidList).indexOf(o2.id) < 0, 'paid=0/1 对未付款单的分流同样正确',
    { unpaidO2: ids(unpaidList).indexOf(o2.id), paidO2: ids(paidList).indexOf(o2.id) });
  ok((paidList.body && paidList.body.items || []).every((o) => o.paid === true), 'paid=1 结果里没有漏网的未付款单');

  // ⑧ 取消已付款单仍成功 + 退款失败如实落库
  section('⑧ 取消已付款单：取消仍成功，refundState=fail + 明确的退款提示');
  const cancel = await api('POST', '/api/orders/' + o1.id + '/cancel', { reason: '顾客不要了' }, admin());
  ok(cancel.status === 200, '取消已付款单成功（不因为支付没开通就禁止取消）', cancel.status + ' ' + (cancel.text || '').slice(0, 160));
  ok(cancel.body && cancel.body.status === 'cancelled', '取消响应里订单 status=cancelled', cancel.body && cancel.body.status);
  ok(cancel.body && cancel.body.refundState === 'fail', '取消响应里 refundState=fail（不是空值）', cancel.body && cancel.body.refundState);
  ok(cancel.body && cancel.body.refundError === REFUND_NOT_CONFIGURED,
    '取消响应带回 refundError 提示（服务端 pay.go:528 的固定文案）', cancel.body && cancel.body.refundError);
  const o1c = await api('GET', '/api/orders/' + o1.id, null, admin());
  ok(o1c.body && o1c.body.status === 'cancelled', '详情里订单已取消', o1c.body && o1c.body.status);
  ok(o1c.body && o1c.body.refundState === 'fail', '详情里 refundState=fail 已落库（可追溯）', o1c.body && o1c.body.refundState);
  ok(o1c.body && o1c.body.refundId === '', '未自动退款时 refundId 保持空（没有假造微信退款单号）', o1c.body && o1c.body.refundId);

  // ⑨ 前端「未开通」契约的静态校验
  section('⑨ 前端「未开通」契约静态扫描（取不到配置 = 未开通）');
  const src = (p) => { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (e) { return ''; } };
  const miniApiText = src('miniprogram/utils/api.js');
  const miniRulesText = src('miniprogram/utils/rules.js');
  const mallText = src('web/mall.js');
  const sdyApiText = src('web/sdy-api.js');
  const mallAdminText = src('web/mall-admin.js');
  const FILES = {
    'miniprogram/utils/api.js': miniApiText, 'miniprogram/utils/rules.js': miniRulesText,
    'web/mall.js': mallText, 'web/sdy-api.js': sdyApiText, 'web/mall-admin.js': mallAdminText,
  };
  const emptyFiles = Object.keys(FILES).filter((f) => FILES[f].length === 0);
  ok(emptyFiles.length === 0, '五份前端源码都可读', emptyFiles);

  const POS = [];
  const has = (name, text, re) => { POS.push(re); ok(re.test(text), name, re.test(text) ? undefined : String(re)); };
  has('小程序 api.js：连不上后端时 state.payEnabled 显式置 false', miniApiText, /state\.payEnabled\s*=\s*false/);
  has('小程序 api.js：状态初值 payEnabled: false', miniApiText, /payEnabled:\s*false/);
  has('小程序 api.js：applySettings 只认 v.payEnabled === true', miniApiText,
    /state\.payEnabled\s*=\s*!!\(v && v\.payEnabled === true\)/);
  has('小程序 api.js：payEnabled() 只认 state.payEnabled === true', miniApiText, /return state\.payEnabled === true/);
  has('小程序 rules.js：payEnabledFlag 只认 o.payEnabled === true', miniRulesText, /o\.payEnabled === true/);
  has('小程序 rules.js：未开通时 pending 只给 cancel 不给 pay', miniRulesText,
    /payEnabledFlag\(o\)\s*\?\s*\['pay', 'cancel'\]\s*:\s*\['cancel'\]/);
  has('小程序 rules.js：pending 文案在未开通时回落「待备货」', miniRulesText,
    /\(!paidFlag\(obj\) && payEnabledFlag\(obj\)\)\s*\?\s*'待付款'\s*:\s*'待备货'/);
  has('Web mall.js：payOn 只认 x.payEnabled === true', mallText, /payOn = \(x\.payEnabled === true\);/);
  has('Web mall.js：resetSettings 复位为 payOn = false', mallText, /payOn = false;/);
  has('Web mall.js：payEnabled() 只认 payOn === true', mallText, /function payEnabled\(\) \{ return payOn === true; \}/);
  has('Web mall.js：pending 文案在未开通时回落「待备货」', mallText,
    /\(isPaid\(o\) \|\| !payEnabled\(\)\) \?\s*'待备货'\s*:\s*'待付款'/);
  has('Web sdy-api.js：缓存初值 let payEnabled_ = false', sdyApiText, /let payEnabled_ = false;/);
  has('Web sdy-api.js：sync 里只认 cfgS.payEnabled === true', sdyApiText,
    /payEnabled_ = \(cfgS && cfgS\.payEnabled === true\);/);
  has('Web sdy-api.js：getSettings 里只认 s.payEnabled === true', sdyApiText,
    /payEnabled_ = \(s && s\.payEnabled === true\);/);
  has('Web sdy-api.js：兜底只认 payEnabled_ === true', sdyApiText, /return payEnabled_ === true;/);
  has('Web sdy-api.js：复位写回 false', sdyApiText, /payEnabled_ = false;/);
  has('Web mall-admin.js：取不到 = 未开通（fallback 返回 false）', mallAdminText, /return false;\s*\/\/ 取不到 = 未开通/);
  has('Web mall-admin.js：MallCore.payEnabled() 只认 === true', mallAdminText, /MallCore\.payEnabled\(\) === true/);
  has('Web mall-admin.js：pending 文案在未开通时回落「待备货」', mallAdminText,
    /\(isPaid\(o\) \|\| !payEnabled\(\)\) \?\s*'待备货'\s*:\s*'待付款'/);

  // 「能真的失败」自证：上面每条正则对空串都必须不匹配（否则就是恒真的空断言）。
  const trivial = POS.filter((re) => re.test(''));
  ok(trivial.length === 0, '所有正向正则都不是恒真（空串不匹配，断言能真的失败）', trivial.map(String));
  // 反向：不许出现把字符串/数字/对象当开通的宽松比较。
  //
  // 判定分两步，否则会两头不讨好：
  //   ① 先把**合规收口** `X.payEnabled === true` 整块挖掉（`stripClosed`）——
  //      现网所有赋值右侧都是「带 === true 收口」的，不挖掉就会把它们误判成宽松写法；
  //   ② 在挖过的文本上找仍然引用 `payEnabled` 的赋值。右侧允许 `!!`、`(`、`s && ` 这类
  //      前缀，但**不许跨过 `)` / `,` / `;` / 换行**——否则 `typeof m.payEnabled === 'function')
  //      return m.payEnabled() === true;` 这种一行里有两个引用的正常代码会被假命中。
  const allFront = miniApiText + '\n' + miniRulesText + '\n' + mallText + '\n' + sdyApiText + '\n' + mallAdminText;
  const stripClosed = (s) => s.replace(/[A-Za-z_$][\w.$]*\.payEnabled\s*===\s*true/g, 'TRUE');
  const loose = /payEnabled\s*==\s*['"]true['"]|payEnabled_?\s*=\s*(?:!!)?\s*\(?[^;,\n()]*\bpayEnabled\b/;
  const looseHit = stripClosed(allFront).match(loose);
  ok(!looseHit, '三端没有「字符串比较 / 直接拿原始字段当布尔」的宽松写法（只能 === true 收口）',
    looseHit ? looseHit[0] : undefined);
  // 反向正则的「能真的失败」自证：拿三段真实的坏写法喂它（都先过 stripClosed，与上面的判定同一口径），
  // 必须全部命中；喂现网代码必须干净（上面那条断言）。
  const looseBad = [
    'state.payEnabled = v.payEnabled;',
    'payEnabled_ = (s && s.payEnabled);',
    "if (cfg.payEnabled == 'true') {}"
  ];
  const looseMissed = looseBad.filter((s) => !loose.test(stripClosed(s)));
  // 同时自证「不会把合规写法误判成坏写法」：这两段现网真实存在的收口写法喂进去必须干净。
  const looseFalseAlarm = [
    'state.payEnabled = !!(v && v.payEnabled === true)',
    'payEnabled_ = (cfgS && cfgS.payEnabled === true);'
  ].filter((s) => loose.test(stripClosed(s)));
  ok(looseMissed.length === 0 && looseFalseAlarm.length === 0,
    '反向正则不是恒假、也不误伤合规收口（喂坏写法必须命中，喂三个 === true 收口必须干净）',
    looseMissed.length || looseFalseAlarm.length ? { looseMissed, looseFalseAlarm } : undefined);

  // ⑩ 假支付旁观：未配置就绝不联系微信支付
  section('⑩ 假微信支付服务旁观：全程零 /v3 请求');
  const fst = await json(FAKE + '/__state');
  const reqs = (fst.body && fst.body.requests) || [];
  ok(reqs.length === 0, '验收期间假支付服务一次 /v3 请求都没收到（未配置 = 一次都不联系微信支付）',
    reqs.map((r) => r.path));
  ok(fst.body && Object.keys(fst.body.orders || {}).length === 0 && Object.keys(fst.body.refunds || {}).length === 0,
    '假支付侧没有 prepay / 退款单据', { orders: Object.keys((fst.body && fst.body.orders) || {}), refunds: Object.keys((fst.body && fst.body.refunds) || {}) });
  info('订单 ' + o1.id + '（核心单，qty=2，库存 ' + stockBefore + ' → ' + stockAfterOrder + ' → ' + stockAfterWait + '）');

  return finish();
})().catch((e) => {
  console.log('\n脚本异常：' + (e && e.stack || e));
  FAIL++;
  return finish(1);
});

function finish(force) {
  console.log('\n==================== 汇总 ====================');
  console.log('  通过 ' + PASS + ' 项 / 失败 ' + FAIL + ' 项');
  if (FAILED.length) FAILED.forEach((n) => console.log('  ✘ ' + n));
  console.log('=============================================');
  cleanup();
  process.exit(force || (FAIL ? 1 : 0));
}

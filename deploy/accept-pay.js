#!/usr/bin/env node
/**
 * 支付轮（0.9.0）微信支付端到端验收：真后端 + 假微信支付服务 + 假微信登录。
 *
 * 用法：node deploy/accept-pay.js            （自己起三个进程，跑完自己清理）
 *      SDY_BIN=/tmp/sdy-verify-server node deploy/accept-pay.js
 *
 * 覆盖：下单即待付款 / prepay 金额与前端参数 / 伪造回调必拒 / 真回调置已付 /
 *      重复回调幂等 / 金额不符必须拒绝 / paid 筛选 / 标记已收款 / 取消已付款单触发退款 /
 *      退款回调 / 过期未付自动取消并回补库存 / 跨端补 openid。
 *
 * 设计说明：
 * - 假支付服务（deploy/fake-wxpay.js）会校验服务端请求签名（用商户公钥），
 *   所以「服务端签名是否正确」是被真验的，不是自说自话。
 * - 平台证书由假服务生成并通过 GET /__pubkey 暴露，本脚本落盘后交给服务端验签用。
 * - 过期自动取消用 PAY_EXPIRE_SECONDS=5 / PAY_SWEEP_INTERVAL=1s 起临时后端，真的等它扫。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const BIN = process.env.SDY_BIN || '/tmp/sdy-verify-server';
const API_PORT = Number(process.env.PAY_API_PORT || 8095);
const FAKE_PORT = Number(process.env.PAY_FAKE_PORT || 8098);
const WX_PORT = Number(process.env.PAY_WX_PORT || 8099);
const BASE = 'http://127.0.0.1:' + API_PORT;
const FAKE = 'http://127.0.0.1:' + FAKE_PORT;
const RUN = 'PAY' + String(Date.now()).slice(-6);
const PHONE_A = '13800009001';
const PHONE_B = '13800009002';

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
    lines.forEach((l) => { if (onLine) onLine(l); });
    if (process.env.PAY_VERBOSE) process.stdout.write('[' + name + '] ' + chunk);
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
  console.log('支付轮支付端到端验收 → ' + BASE + '（假支付 ' + FAKE + '，假微信 ' + 'http://127.0.0.1:' + WX_PORT + '）');
  if (!fs.existsSync(BIN)) {
    console.log('找不到服务端二进制 ' + BIN + '（先 go build，或用 SDY_BIN= 指定）');
    process.exit(3);
  }

  // ⓪ 起假支付 + 生成测试密钥 + 起临时后端
  section('⓪ 环境准备');
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'sdy-pay-'));
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const merchantKeyPath = path.join(TMP, 'merchant_priv.pem');
  const merchantPubPath = path.join(TMP, 'merchant_pub.pem');
  fs.writeFileSync(merchantKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  fs.writeFileSync(merchantPubPath, publicKey.export({ type: 'spki', format: 'pem' }));

  let fakeReady = null, fakeFailed = '';
  startKid('fake-wxpay', [path.join(ROOT, 'deploy', 'fake-wxpay.js'), '--port=' + FAKE_PORT,
    '--merchant-key=' + merchantKeyPath, '--api-v3-key=0123456789abcdef0123456789abcdef',
    // appid/mchid 必须与服务端环境变量一致，否则回调会被服务端按「appid/mchid 不符」拒掉
    '--appid=wx_pay_test', '--mchid=1900000109', '--notify-url=' + BASE + '/api/pay/notify'],
  null, (line) => {
    if (/EADDRINUSE|启动失败/.test(line)) fakeFailed = line.trim();
    const m = line.match(/FAKE_WXPAY_READY\s+(\{.*\})/);
    if (m) { try { fakeReady = JSON.parse(m[1]); } catch (e) { /* 忽略 */ } }
  });
  const ready = await waitPort(FAKE + '/__state', 40);
  ok(ready && fakeReady && !fakeFailed, '假微信支付服务已就绪（本脚本自己起的那个）',
    { ready, readyLine: !!fakeReady, err: fakeFailed || undefined });
  if (!ready || !fakeReady || fakeFailed) {
    console.log('假支付服务没起来。若提示端口被占用，请先腾出 ' + FAKE_PORT + '/tcp（PAY_FAKE_PORT= 可换端口）后重跑。');
    return finish();
  }
  const pub = await json(FAKE + '/__pubkey');
  const platformCertPath = path.join(TMP, 'platform_cert.pem');
  fs.writeFileSync(platformCertPath, pub.text);
  ok(pub.status === 200 && /BEGIN CERTIFICATE|BEGIN PUBLIC KEY/.test(pub.text), '拿到平台证书（用于服务端回调验签）', pub.status);
  // 商户公钥也给假服务一份（除了 --merchant-key 之外的双保险）
  await json(FAKE + '/__merchant_pubkey', { method: 'POST', body: fs.readFileSync(merchantPubPath, 'utf8') });

  // 假微信登录（服务端要 openid → 手机号 才有顾客身份）
  startKid('fake-wx', [path.join(ROOT, 'deploy', 'fake-wx.js'), String(WX_PORT)]);
  const wxReady = await waitPort('http://127.0.0.1:' + WX_PORT + '/', 20);
  info('假微信登录服务就绪：' + wxReady);

  const apiV3Key = (fakeReady && fakeReady.apiV3Key) || '0123456789abcdef0123456789abcdef';
  const dbPath = path.join(TMP, 'pay.db');
  startKid('sdy-api', [BIN], {
    ADDR: '127.0.0.1:' + API_PORT,
    DB_PATH: dbPath,
    STATIC_DIR: path.join(ROOT, 'web'),
    WX_APPID: 'wx_pay_test',
    WX_SECRET: 'sec_pay_test',
    WX_API_BASE: 'http://127.0.0.1:' + WX_PORT,
    WXPAY_MCHID: '1900000109',
    WXPAY_SERIAL_NO: (fakeReady && fakeReady.serialNo) || '0123456789ABCDEF0123456789ABCDEF01234567',
    WXPAY_PRIVATE_KEY_PATH: merchantKeyPath,
    WXPAY_API_V3_KEY: apiV3Key,
    WXPAY_PLATFORM_CERT_PATH: platformCertPath,
    WXPAY_API_BASE: FAKE,
    WXPAY_NOTIFY_URL: BASE + '/api/pay/notify',
    PAY_EXPIRE_SECONDS: '5',
    PAY_SWEEP_INTERVAL: '1s',
  });
  const apiReady = await waitPort(BASE + '/healthz', 60);
  ok(apiReady, '临时后端已就绪（已配置支付）', apiReady);
  if (!apiReady) { console.log('后端没起来，检查日志（PAY_VERBOSE=1 看子进程输出）'); return finish(); }

  // ① 建档、下单即「待付款」
  section('① 下单即待付款（未付款订单产生倒计时）');
  const P = { A: RUN + 'A', B: RUN + 'B' };
  const mk = (code, name, price, stock) => ({ code, name, brand: '验收', spec: '500ml', category: '支付验收',
    img: '', costPrice: 1, salePrice: price, wholesalePrice: price, refPrice: 0, unit: '瓶', stock, isWholesale: false });
  ok((await api('POST', '/api/products', mk(P.A, RUN + '支付甲', 6, 20), admin())).status === 200, '建档 A');
  ok((await api('POST', '/api/products', mk(P.B, RUN + '支付乙', 3, 20), admin())).status === 200, '建档 B');
  const loginA = await api('POST', '/api/wx/login', { code: 'payA', phone: PHONE_A });
  ok(loginA.status === 200 && loginA.body && loginA.body.openid, '假微信登录拿到 openid', loginA.status);
  const openA = loginA.body && loginA.body.openid;

  const created = await api('POST', '/api/orders', {
    customerName: RUN + '支付甲', phone: PHONE_A, deliveryType: 'pickup',
    items: [{ code: P.A, qty: 2 }], clientToken: RUN + '-t1',
  }, { 'X-Wx-Openid': openA || '' });
  ok(created.status === 201, '下单成功（201）', created.status);
  const o1 = created.body || {};
  ok(o1.paid === false || o1.paid === undefined, '新订单 paid 不是 true', o1.paid);
  ok(typeof o1.payExpireAt === 'number' && o1.payExpireAt > Math.floor(Date.now() / 1000), '新订单带未付倒计时 payExpireAt', o1.payExpireAt);
  ok(!('openid' in o1), '订单 JSON 不泄露 openid', Object.keys(o1).filter((k) => k === 'openid'));
  const expectFen = Math.round(Number(o1.total) * 100);
  info('订单 ' + o1.id + ' 合计 ' + o1.total + ' 元 = ' + expectFen + ' 分');

  // ② prepay：金额整数分 + 前端支付参数 + 幂等复用
  section('② prepay（服务端签名下单）');
  const pre1 = await api('POST', '/api/pay/prepay', { orderId: o1.id }, { 'X-Wx-Openid': openA || '' });
  ok(pre1.status === 200, 'prepay 200', pre1.status + ' ' + (pre1.text || '').slice(0, 120));
  const pp = (pre1.body && pre1.body.payParams) || {};
  ok(pre1.body && pre1.body.amountFen === expectFen, 'amountFen = 订单金额（整数分）', pre1.body && pre1.body.amountFen);
  ok(['timeStamp', 'nonceStr', 'package', 'signType', 'paySign'].every((k) => pp[k]), 'payParams 五要素齐全', Object.keys(pp));
  ok(pp.signType === 'RSA', 'signType=RSA（小程序 JSAPI）', pp.signType);
  ok(String(pp.package || '').indexOf('prepay_id=') === 0, 'package 是 prepay_id=…', pp.package);
  ok(pre1.body && pre1.body.expireAt > Math.floor(Date.now() / 1000), 'expireAt 在未来', pre1.body && pre1.body.expireAt);
  const pre2 = await api('POST', '/api/pay/prepay', { orderId: o1.id }, { 'X-Wx-Openid': openA || '' });
  ok(pre2.status === 200 && pre2.body && pre2.body.payParams && pre2.body.payParams.package === pp.package,
    '重复 prepay 复用同一个 prepay_id（不重复下单）', { a: pp.package, b: pre2.body && pre2.body.payParams && pre2.body.payParams.package });
  let st = (await json(FAKE + '/__state')).body || {};
  const jsapiCalls = ((st.requests || []).filter((r) => String(r.path || '').indexOf('/v3/pay/transactions/jsapi') >= 0));
  ok(jsapiCalls.length === 1 && jsapiCalls.every((r) => r.signatureOk === true), '假服务只收到 1 次 jsapi 下单且服务端签名被验通过', jsapiCalls.map((r) => r.signatureOk));

  // ③ 伪造回调必须被拒
  section('③ 伪造回调必拒（不验签 = 谁都能白拿货）');
  const forged = await api('POST', '/api/pay/notify', { id: 'fake', resource: { ciphertext: 'x' } }, {
    'Wechatpay-Timestamp': String(Math.floor(Date.now() / 1000)), 'Wechatpay-Nonce': 'n1',
    'Wechatpay-Signature': 'AAAA', 'Wechatpay-Serial': 'BBBB',
  });
  ok(forged.status === 401 || forged.status === 400, '伪造回调被拒（401/400，不是 200）', forged.status);
  ok(forged.status < 500, '伪造回调不引发 500', forged.status);
  const afterForged = await api('GET', '/api/orders/' + o1.id, null, { 'X-Wx-Openid': openA || '' });
  ok(afterForged.body && afterForged.body.paid === false, '伪造回调后订单仍未付款', afterForged.body && afterForged.body.paid);

  // ④ 真回调 → 已付款
  section('④ 真回调（假服务加密 + 签名）→ 订单已付款');
  const fakeInit = await json(FAKE + '/__state');
  ok(fakeInit.body && fakeInit.body.orders && fakeInit.body.orders[o1.id], '假服务记下了这单的 prepay', Object.keys((fakeInit.body && fakeInit.body.orders) || {}));
  const payOk = await json(FAKE + '/__pay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outTradeNo: o1.id, mode: 'ok' }) });
  ok(payOk.status === 200 && payOk.body && payOk.body.ok === true, '假服务成功投递回调', payOk.status + ' ' + (payOk.text || '').slice(0, 160));
  ok(payOk.body && payOk.body.httpStatus === 200, '服务端对真回调回 200（不是 4xx/5xx）', payOk.body && payOk.body.httpStatus);
  ok(payOk.body && /SUCCESS/.test(String(payOk.body.respBody || '')), '回调响应体含 SUCCESS', payOk.body && payOk.body.respBody);
  const paid = await api('GET', '/api/orders/' + o1.id, null, { 'X-Wx-Openid': openA || '' });
  ok(paid.body && paid.body.paid === true, '订单已置为已付款', paid.body && paid.body.paid);
  ok(paid.body && paid.body.paidAt, 'paidAt 已写入', paid.body && paid.body.paidAt);
  const txn = paid.body && paid.body.transactionId;
  ok(!!txn, 'transactionId 已写入', txn);

  // ⑤ 重复回调幂等
  section('⑤ 重复回调幂等（微信会重试）');
  const again = await json(FAKE + '/__pay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outTradeNo: o1.id, mode: 'ok' }) });
  ok(again.status === 200 && again.body && again.body.httpStatus === 200, '重复回调仍回 200 SUCCESS', again.body && again.body.httpStatus);
  const afterAgain = await api('GET', '/api/orders/' + o1.id, null, { 'X-Wx-Openid': openA || '' });
  ok(afterAgain.body && afterAgain.body.transactionId === txn, 'transactionId 未被重复回调改写', afterAgain.body && afterAgain.body.transactionId);
  ok(afterAgain.body && afterAgain.body.paidAt === paid.body.paidAt, 'paidAt 未被重复回调改写', afterAgain.body && afterAgain.body.paidAt);

  // ⑥ 金额不符必须拒绝
  section('⑥ 金额不符 → 拒绝且订单不变（防伪造/防串单）');
  const o2 = (await api('POST', '/api/orders', { customerName: RUN + '支付乙', phone: PHONE_A, deliveryType: 'pickup',
    items: [{ code: P.B, qty: 4 }], clientToken: RUN + '-t2' }, { 'X-Wx-Openid': openA || '' })).body;
  await api('POST', '/api/pay/prepay', { orderId: o2.id }, { 'X-Wx-Openid': openA || '' });
  const bad = await json(FAKE + '/__pay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outTradeNo: o2.id, mode: 'fail-amount' }) });
  ok(bad.body && bad.body.httpStatus >= 400 && bad.body.httpStatus < 500, '金额不符时服务端回 4xx（让微信重试，不是 500）', bad.body && bad.body.httpStatus);
  const o2after = await api('GET', '/api/orders/' + o2.id, null, admin());
  ok(o2after.body && o2after.body.paid === false, '金额不符的订单不得变成已付款', o2after.body && o2after.body.paid);
  ok(o2after.body && !o2after.body.transactionId, '金额不符的订单不得写入 transactionId', o2after.body && o2after.body.transactionId);

  // ⑦ paid 筛选
  section('⑦ 订单 paid 筛选（后台「待收款」口径）');
  const unpaid = await api('GET', '/api/orders?paid=0&limit=200', null, admin());
  const paidList = await api('GET', '/api/orders?paid=1&limit=200', null, admin());
  const ids = (r) => ((r.body && r.body.items) || []).map((o) => o.id);
  ok(ids(unpaid).indexOf(o2.id) >= 0 && ids(unpaid).indexOf(o1.id) < 0, 'paid=0 只含未付款单', { o1: ids(unpaid).indexOf(o1.id), o2: ids(unpaid).indexOf(o2.id) });
  ok(ids(paidList).indexOf(o1.id) >= 0 && ids(paidList).indexOf(o2.id) < 0, 'paid=1 只含已付款单', { o1: ids(paidList).indexOf(o1.id), o2: ids(paidList).indexOf(o2.id) });
  ok((unpaid.body && unpaid.body.items || []).every((o) => o.paid === false), 'paid=0 结果里没有漏网的已付款单');

  // ⑧ 标记已收款（现金兜底）
  section('⑧ 标记已收款（线下现金兜底）');
  const mp1 = await api('POST', '/api/orders/' + o2.id + '/mark-paid', { note: '现金' }, admin());
  ok(mp1.status === 200, 'mark-paid 200', mp1.status + ' ' + (mp1.text || '').slice(0, 120));
  const mp2 = await api('POST', '/api/orders/' + o2.id + '/mark-paid', { note: '现金' }, admin());
  ok(mp2.status === 200, '重复 mark-paid 幂等（不报错）', mp2.status);
  const o2mp = await api('GET', '/api/orders/' + o2.id, null, admin());
  ok(o2mp.body && o2mp.body.paid === true, '标记后订单已付款', o2mp.body && o2mp.body.paid);

  // ⑨ 取消已付款单 → 退款
  section('⑨ 取消已付款单触发退款 + 退款回调');
  const cancel = await api('POST', '/api/orders/' + o1.id + '/cancel', { reason: '顾客不要了' }, admin());
  ok(cancel.status === 200 || cancel.status === 201, '取消已付款单成功', cancel.status + ' ' + (cancel.text || '').slice(0, 120));
  const o1c = await api('GET', '/api/orders/' + o1.id, null, admin());
  ok(o1c.body && o1c.body.status === 'cancelled', '订单已取消', o1c.body && o1c.body.status);
  ok(o1c.body && ['processing', 'success', 'fail'].indexOf(o1c.body.refundState) >= 0, 'refundState 有明确取值（不许空着骗人）', o1c.body && o1c.body.refundState);
  st = (await json(FAKE + '/__state')).body || {};
  const refundNos = Object.keys(st.refunds || {});
  ok(refundNos.length >= 1, '假服务收到退款请求', refundNos);
  ok(refundNos.some((n) => n.indexOf(o1.id) >= 0), '退款单号含原订单号（可对账）', refundNos);
  const refundCalls = (st.requests || []).filter((r) => String(r.path || '').indexOf('/v3/refund/domestic/refunds') >= 0);
  ok(refundCalls.length >= 1 && refundCalls.every((r) => r.signatureOk === true), '退款请求签名被验通过', refundCalls.map((r) => r.signatureOk));
  if (refundNos.length) {
    await json(FAKE + '/__refund-notify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outRefundNo: refundNos[0], mode: 'ok' }) });
    const o1r = await api('GET', '/api/orders/' + o1.id, null, admin());
    ok(o1r.body && o1r.body.refundState === 'success', '退款回调后 refundState=success', o1r.body && o1r.body.refundState);
    ok(o1r.body && o1r.body.refundId, 'refundId 已写入（可用于对账）', o1r.body && o1r.body.refundId);
  }

  // ⑩ 过期未付自动取消 + 回补库存
  section('⑩ 15 分钟未付自动取消（本脚本用 5 秒 + 1 秒扫单真验）');
  P.C = RUN + 'C';
  await api('POST', '/api/products', mk(P.C, RUN + '支付丙', 4, 9), admin());
  const beforeC = (await api('GET', '/api/products/' + P.C)).body;
  const o3 = (await api('POST', '/api/orders', { customerName: RUN + '支付丙', phone: PHONE_A, deliveryType: 'pickup',
    items: [{ code: P.C, qty: 3 }], clientToken: RUN + '-t3' }, admin())).body;
  const afterOrder = (await api('GET', '/api/products/' + P.C)).body;
  ok(beforeC && afterOrder && afterOrder.stock === beforeC.stock - 3, '下单先真扣库存（9 → 6）', { b: beforeC && beforeC.stock, a: afterOrder && afterOrder.stock });
  info('等待扫单（最多 12 秒）…');
  let swept = null;
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const cur = await api('GET', '/api/orders/' + o3.id, null, admin());
    if (cur.body && cur.body.status === 'cancelled') { swept = cur.body; break; }
  }
  ok(!!swept, '未付款订单到期后被自动取消', swept && swept.status);
  const afterSweep = (await api('GET', '/api/products/' + P.C)).body;
  ok(afterSweep && afterSweep.stock === beforeC.stock, '取消后库存回补到原值', { expect: beforeC && beforeC.stock, got: afterSweep && afterSweep.stock });
  const logs = await api('GET', '/api/stocklog?limit=100', null, admin());
  const timeoutLog = ((logs.body && logs.body.items) || []).filter((l) => l.kind === 'pay_timeout' && String(l.code) === P.C);
  ok(timeoutLog.length >= 1, '库存流水记录了 pay_timeout（可追溯）', timeoutLog.length);

  // ⑪ 跨端补 openid（网页下单 → 小程序支付）
  section('⑪ 跨端补 openid（网页下单的顾客能在小程序付同一单）');
  const webOrder = (await api('POST', '/api/orders', { customerName: RUN + '网页客', phone: PHONE_A, deliveryType: 'pickup',
    items: [{ code: P.A, qty: 1 }], clientToken: RUN + '-t4' }, { 'X-Phone': PHONE_A })).body;
  ok(webOrder && webOrder.paid === false, '网页下单（纯手机号身份）产生的单是待付款', webOrder && webOrder.paid);
  const prePhone = await api('POST', '/api/pay/prepay', { orderId: webOrder.id }, { 'X-Phone': PHONE_A });
  ok(prePhone.status === 400, '纯网页身份（无 openid）不能发起支付 → 400', prePhone.status);
  const preOther = await api('POST', '/api/pay/prepay', { orderId: webOrder.id }, { 'X-Wx-Openid': 'o_pay_stranger' });
  ok(preOther.status === 400 || preOther.status === 403, '陌生 openid 不能替别人付 → 400/403', preOther.status);
  const preCross = await api('POST', '/api/pay/prepay', { orderId: webOrder.id }, { 'X-Wx-Openid': openA || '' });
  ok(preCross.status === 200, '同一手机号的微信登录可以付这一单（补写 openid）', preCross.status + ' ' + (preCross.text || '').slice(0, 120));
  const crossPaid = await json(FAKE + '/__pay', { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outTradeNo: webOrder.id, mode: 'ok' }) });
  ok(crossPaid.body && crossPaid.body.httpStatus === 200, '跨端支付的真正回调也成功（端到端闭环）', crossPaid.body && crossPaid.body.httpStatus);

  // ⑫ 未付款单不进备货队列（契约层面）
  section('⑫ 未付款单不得混进备货队列');
  const prep = await api('GET', '/api/orders?status=pending&paid=1&limit=200', null, admin());
  ok((prep.body && prep.body.items || []).every((o) => o.paid === true), '「待备货」查询（pending+paid=1）里没有未付款单');
  const nopay = await api('GET', '/api/orders?status=pending&paid=0&limit=200', null, admin());
  ok((nopay.body && nopay.body.items || []).every((o) => o.paid === false), '「待付款」查询（pending+paid=0）里没有已付款单');

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

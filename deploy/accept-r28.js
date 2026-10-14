#!/usr/bin/env node
/* =====================================================================
 * 第 28 轮端到端验收（纯 Node，零依赖）
 *
 * 用法：node deploy/accept-r28.js [base]        # 默认 http://127.0.0.1:8093
 *       ADMIN_PASSWORD=<服务端口令> node deploy/accept-r28.js [base]   # 严格档
 *
 * 前置：
 *   - 一个临时后端（`bash deploy/verify-all.sh` 会自动起；也可手动起）。
 *   - 服务端未设置 SEED_DEMO（默认关）时库里没有商品，本脚本会自建；
 *     若库里已有商品，只在极少断言上受影响（`total` 用的是「≥」而不是「=」）。
 *
 * 覆盖 `docs/迭代路线图-第27~31轮.md` **第八节**的验收项：
 *   ① 商品排序：default / hot / price_asc / price_desc / stock_desc，未知值 400
 *   ② 分页：total 是过滤后总数、hasMore 正确、limit>200 夹到 200、负数 400
 *   ③ 价格排序按顾客有效价（批发顾客看到的顺序与零售顾客不同）
 *   ④ 热销聚合：近 30 天订单销量降序，**没销量的商品排在后面而不是被排除**
 *   ⑤ /api/products/hot：默认 8、最大 20
 *   ⑥ /api/products/alternatives：同分类优先、排除自身与缺货、不重复、缺省不报错
 *   ⑦ 订单筛选 q / status / date / type（+ 非法日期 400）
 *   ⑧ 顾客身份下筛选只能在本人订单内再筛（拿别人的手机号 + 别人名字的 q 筛不到）
 *   ⑨ CSV 导出：前三字节 EF BB BF、12 列、RFC4180 转义、Content-Disposition
 *
 * 退出码 = 失败项数（0 = 全绿）。所有判定都打印实测原值，便于事后追。
 * ===================================================================== */
'use strict';

const BASE = (process.argv[2] || 'http://127.0.0.1:8093').replace(/\/+$/, '');
const PASSWORD = process.env.ADMIN_PASSWORD || '';

let pass = 0, fail = 0;
const failures = [];
const warnings = [];
function warn(msg) { warnings.push(msg); console.log('  ⚠ ' + msg); }
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ✘ ' + msg + (extra !== undefined ? '  ← 实测：' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n■ ' + t); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
// 身份：严格档要管理员 Cookie；灰度档（未设 ADMIN_PASSWORD）服务端一律放行，但请求仍带 X-Admin 以走管理端分支
let COOKIE = '';
let STRICT = !!PASSWORD;

async function api(method, path, body, headers, opts) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (COOKIE && !(opts && opts.noAuth)) h.cookie = COOKIE;
  // noAuth：只有「真要以顾客身份请求」的断言才用（严格档下带管理员 Cookie/X-Admin 会按管理员解析，看得到全店订单）
  if ((COOKIE || STRICT) && !(opts && opts.noAuth)) h['X-Admin'] = '1';
  const opt = { method: method, headers: h };
  if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
  let res, text = '';
  try {
    res = await fetch(BASE + path, opt);
    text = await res.text();
  } catch (e) {
    return { status: 0, json: null, text: 'NETWORK: ' + e.message, headers: null };
  }
  let json = null;
  try { json = JSON.parse(text); } catch (e) { json = null; }
  let sc = '';
  try {
    const arr = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    sc = (arr && arr.length) ? arr[0] : (res.headers.get('set-cookie') || '');
  } catch (e) { sc = ''; }
  return { status: res.status, json: json, text: text, cookie: sc, headers: res.headers };
}

// CSV 要按字节看 BOM，所以单独一个取字节的入口
async function apiBin(path, headers) {
  const h = Object.assign({}, headers || {});
  if (COOKIE) h.cookie = COOKIE;
  if (COOKIE || STRICT) h['X-Admin'] = '1';
  try {
    const res = await fetch(BASE + path, { headers: h });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      status: res.status,
      bytes: buf,
      text: buf.toString('utf8'),
      ctype: res.headers.get('content-type') || '',
      cdisp: res.headers.get('content-disposition') || ''
    };
  } catch (e) {
    return { status: 0, bytes: Buffer.alloc(0), text: 'NETWORK: ' + e.message, ctype: '', cdisp: '' };
  }
}

// 本轮标记：让脚本可以反复对同一个库跑（幂等），不会把断言撑破
const RUN = 'R28' + Date.now().toString(36).slice(-4).toUpperCase();
const PHONE_A = '13800000301';        // 销售单（甲）
const PHONE_B = '13800000302';        // 销售单（乙）
const PHONE_F1 = '13800000201';       // 筛选单：自提 / 待备货
const PHONE_F2 = '13800000202';       // 筛选单：配送 / 配送中
const PHONE_WS = '13800000999';       // 批发顾客（只用来算有效价排序）

// 商品编码（固定，便于复用）
const P = {
  A: '6900000000001',  // 销量 5、零售 10、批发 9、库存 5   饮料
  B: '6900000000002',  // 销量 1、零售 5、批发 7、库存 30    饮料
  C: '6900000000003',  // 销量 5、零售 20、批发 0.5、库存 8  零食
  D: '6900000000004',  // 销量 0、零售 3、批发 0、库存 100   零食
  E: '6900000000005'   // 销量 0、零售 4、批发 0、库存 0     饮料（缺货）
};

function prod(code, name, category, salePrice, wholesalePrice, stock) {
  return { code: code, name: name, brand: '验收', spec: '500ml', category: category, img: '',
    costPrice: 1, salePrice: salePrice, wholesalePrice: wholesalePrice, refPrice: 0,
    unit: '瓶', stock: stock, isWholesale: false };
}

(async () => {
  console.log('第 28 轮端到端验收 → ' + BASE + (STRICT ? '（严格档）' : '（灰度档）'));

  // ⓪ 连通性与鉴权通道
  section('⓪ 连通性 / 鉴权通道');
  const health = await api('GET', '/healthz');
  ok(health.status === 200, '后端 /healthz 200', health.status);
  if (STRICT) {
    const login = await api('POST', '/api/admin/login', { password: PASSWORD }, null, { noAuth: true });
    if (login.status !== 200 || !login.cookie) {
      console.log('\n严格档登录失败（' + login.status + '）：请确认 ADMIN_PASSWORD 与服务端口令一致。');
      process.exit(2);
    }
    COOKIE = String(login.cookie).split(';')[0];
    ok(true, '管理员登录成功并拿到 Cookie');
  } else {
    warn('未设置 ADMIN_PASSWORD = 灰度档：管理端接口（含 CSV 导出）无身份也能调，与第 27 轮 6.2 缺口同源，第 30 轮统一收口。');
  }
  const probe = await api('POST', '/api/products', prod(P.A, RUN + 'AAA可乐', '饮料', 10, 9, 5));
  if (probe.status === 401) {
    console.log('\n服务端已开启鉴权（401）。请用 ADMIN_PASSWORD=<服务端口令> 重跑本脚本。');
    process.exit(2);
  }
  ok(probe.status === 200 || probe.status === 201, '建档接口可用（管理员身份）', probe.status);

  // 建 5 个商品：3 个有销量、1 个无销量、1 个缺货
  const rest = [
    prod(P.B, RUN + 'BBB矿泉水', '饮料', 5, 7, 30),
    prod(P.C, RUN + 'CCC薯片', '零食', 20, 0.5, 8),
    prod(P.D, RUN + 'DDD无销量饼干', '零食', 3, 0, 100),
    prod(P.E, RUN + 'EEE缺货汽水', '饮料', 4, 0, 0)
  ];
  for (const p of rest) {
    const r = await api('POST', '/api/products', p);
    ok(r.status === 200 || r.status === 201, '建档 ' + p.name, r.status);
  }
  // 全部上架（顾客端只看上架商品）
  const onsale = await api('POST', '/api/products/onsale', { codes: Object.values(P), onSale: true });
  ok(onsale.status === 200, '五个商品全部上架', onsale.status);

  // 造销量：A×3+B×1、A×2+C×5 → A=5、C=5、B=1；下面两张筛选单各含 D×1 → D=2；E=0（无销量）
  const o1 = await api('POST', '/api/orders', { customerName: RUN + '销量甲', phone: PHONE_A,
    deliveryType: 'pickup', items: [{ code: P.A, qty: 3 }, { code: P.B, qty: 1 }] });
  const o2 = await api('POST', '/api/orders', { customerName: RUN + '销量乙', phone: PHONE_B,
    deliveryType: 'pickup', items: [{ code: P.A, qty: 2 }, { code: P.C, qty: 5 }] });
  ok((o1.status === 201 || o1.status === 200) && (o2.status === 201 || o2.status === 200), '造两笔销量订单（A=5、C=5、B=1）', [o1.status, o2.status]);

  // 筛选用的两笔单：甲=自提/待备货；乙=配送/配送中；甲的名字里塞逗号与引号（验 CSV 转义）
  const nameComma = RUN + '筛选甲, "特别"';
  const f1 = await api('POST', '/api/orders', { customerName: nameComma, phone: PHONE_F1,
    deliveryType: 'pickup', address: '一号路 1 号, 2 单元', items: [{ code: P.D, qty: 1 }] });
  const f2 = await api('POST', '/api/orders', { customerName: RUN + '筛选乙', phone: PHONE_F2,
    deliveryType: 'delivery', address: '二号路 2 号', items: [{ code: P.D, qty: 1 }] });
  ok((f1.status === 201 || f1.status === 200) && (f2.status === 201 || f2.status === 200), '造两笔筛选订单（自提待备货 / 配送）。', [f1.status, f2.status]);
  const F1 = (f1.json && f1.json.id) || '';
  const F2 = (f2.json && f2.json.id) || '';
  const adv = await api('POST', '/api/orders/' + F2 + '/advance', { to: 'delivering' });
  ok(adv.status === 200, '把乙推进到配送中（管理端）', adv.status);

  // 批发顾客（有效价排序用）
  const ws = await api('POST', '/api/customers/tier', { phone: PHONE_WS, tier: 'wholesale' });
  ok(ws.status === 200, '设置批发顾客 ' + PHONE_WS, ws.status);

  // ① 排序
  section('① 商品排序（default / hot / price_asc / price_desc / stock_desc）');
  const base = '&onSale=1&limit=200';
  const dflt = await api('GET', '/api/products?keyword=' + encodeURIComponent(RUN) + base);
  ok(dflt.status === 200 && Array.isArray(dflt.json.items), 'sort=default 正常返回', dflt.status);
  const codes = (r) => (r.json && Array.isArray(r.json.items) ? r.json.items : []).map(x => x.code);
  const arr = (r) => (r.json && Array.isArray(r.json.items) ? r.json.items : []);

  const pa = await api('GET', '/api/products?keyword=' + encodeURIComponent(RUN) + base + '&sort=price_asc');
  const paseq = codes(pa).filter(c => [P.A, P.B, P.C, P.D, P.E].indexOf(c) >= 0);
  ok(eq(paseq, [P.D, P.E, P.B, P.A, P.C]), '零售 price_asc = D(3) E(4) B(5) A(10) C(20)', paseq);
  const pd = await api('GET', '/api/products?keyword=' + encodeURIComponent(RUN) + base + '&sort=price_desc');
  ok(eq(codes(pd).filter(c => [P.A, P.B, P.C].indexOf(c) >= 0), [P.C, P.A, P.B]), '零售 price_desc = C A B', codes(pd));
  const sd = await api('GET', '/api/products?keyword=' + encodeURIComponent(RUN) + base + '&sort=stock_desc');
  const sdc = codes(sd);
  ok(sdc.indexOf(P.D) >= 0 && sdc.indexOf(P.B) >= 0 && sdc.indexOf(P.E) >= 0
    && sdc.indexOf(P.D) < sdc.indexOf(P.B) && sdc.indexOf(P.B) < sdc.indexOf(P.E),
    'stock_desc = 库存 D(98) 在 B(29) 前、B 在 E(0) 前', sdc);

  const bad = await api('GET', '/api/products?sort=hotness');
  ok(bad.status === 400 && /排序方式/.test(bad.text), '未知 sort → 400 且提示「排序方式」', { s: bad.status, t: bad.text.slice(0, 80) });
  const negL = await api('GET', '/api/products?limit=-1');
  ok(negL.status === 400, 'limit=-1 → 400', negL.status);
  const negO = await api('GET', '/api/products?offset=-1');
  ok(negO.status === 400, 'offset=-1 → 400', negO.status);

  // ② 分页
  section('② 分页与 total 语义');
  const pg = await api('GET', '/api/products?onSale=1&limit=2&offset=0');
  ok(pg.status === 200 && pg.json.items.length === 2, 'limit=2 只回 2 条', pg.json && pg.json.items.length);
  ok(typeof pg.json.total === 'number' && pg.json.total >= 5, 'total 是过滤后总数（≥5），不是当前页条数', pg.json.total);
  ok(pg.json.hasMore === true && pg.json.limit === 2 && pg.json.offset === 0, 'hasMore=true 且回显 limit/offset', { h: pg.json.hasMore, l: pg.json.limit, o: pg.json.offset });
  const pgBig = await api('GET', '/api/products?onSale=1&limit=500');
  ok(pgBig.json.limit === 200, 'limit=500 被夹到 200', pgBig.json.limit);
  const last = await api('GET', '/api/products?onSale=1&limit=2&offset=5000');
  ok(arr(last).length === 0 && last.json && last.json.hasMore === false, 'offset 超出范围 → 空列表且 hasMore=false', { n: arr(last).length, h: last.json && last.json.hasMore });

  // ③ 有效价排序
  section('③ 价格排序按顾客有效价（批发顾客看到的顺序与零售不同）');
  const wseq = await api('GET', '/api/products?keyword=' + encodeURIComponent(RUN) + base + '&sort=price_asc&phone=' + PHONE_WS);
  const wcodes = codes(wseq).filter(c => [P.A, P.B, P.C].indexOf(c) >= 0);
  ok(eq(wcodes, [P.C, P.B, P.A]), '批发 price_asc = C(0.5) B(7) A(9)（与零售顺序不同即为按有效价排）', wcodes);
  ok(wseq.json.tier === 'wholesale', '响应 tier=wholesale', wseq.json.tier);

  // ④⑤ 热销
  section('④⑤ 热销聚合与 /api/products/hot');
  const hot = await api('GET', '/api/products/hot?limit=20');
  const hc = codes(hot);
  ok(hc.indexOf(P.A) >= 0 && hc.indexOf(P.C) >= 0, '热销含 A 与 C（销量各 5）', hc);
  ok(hc.indexOf(P.A) >= 0 && hc.indexOf(P.C) >= 0 && hc.indexOf(P.A) < hc.indexOf(P.C), '销量并列 A(5)=C(5) 时按名称升序 → A 在前', hc);
  ok(hc.indexOf(P.C) >= 0 && hc.indexOf(P.D) >= 0 && hc.indexOf(P.D) < hc.indexOf(P.B),
    'D(销量2) 排在 B(销量1) 前，说明是按下单量降序', hc);
  ok(hc.indexOf(P.B) >= 0 && hc.indexOf(P.E) >= 0 && hc.indexOf(P.B) < hc.indexOf(P.E),
    'E(无销量 0) 排在最后而不是被排除', hc);
  const hotDef = await api('GET', '/api/products/hot');
  ok(arr(hotDef).length <= 8, 'hot 默认不超过 8 条', arr(hotDef).length);
  const hot20 = await api('GET', '/api/products/hot?limit=999');
  ok(arr(hot20).length <= 20, 'hot 最大 20 条', arr(hot20).length);

  // ⑥ 替代推荐
  section('⑥ /api/products/alternatives 缺货替代推荐');
  const alt = await api('GET', '/api/products/alternatives?code=' + P.A + '&limit=20');
  const ac = codes(alt);
  ok(alt.status === 200 && ac.indexOf(P.A) < 0, '排除自身', ac);
  ok(ac.indexOf(P.E) < 0, '排除缺货商品（E 库存 0）', ac);
  ok(new Set(ac).size === ac.length, '不重复', ac);
  ok(ac.indexOf(P.B) >= 0 && ac.indexOf(P.C) >= 0 && ac.indexOf(P.B) < ac.indexOf(P.C), '同分类（饮料 B）优先于跨分类（零食 C）', ac);
  const altNo = await api('GET', '/api/products/alternatives?code=不存在&limit=5');
  ok(altNo.status === 200 && arr(altNo).length === 0, '商品不存在 → 200 空列表（不是 400）', { s: altNo.status, n: arr(altNo).length });
  const altMiss = await api('GET', '/api/products/alternatives');
  ok(altMiss.status === 200 && arr(altMiss).length === 0, '缺 code 参数 → 200 空列表', altMiss.status);

  // ⑦ 订单筛选
  section('⑦ 订单筛选 q / status / date / type');
  const mk = RUN + '筛选';
  const q1 = await api('GET', '/api/orders?q=' + encodeURIComponent(RUN + '筛选甲'));
  ok(q1.status === 200 && q1.json.total === 1 && q1.json.items[0].id === F1, 'q=名字甲 → 只回 1 单且是 F1', { t: q1.json.total, id: q1.json.items && q1.json.items[0] && q1.json.items[0].id });
  const q2 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk));
  ok(q2.json.total === 2, 'q=筛选（模糊）→ 2 单', q2.json.total);
  const q3 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk) + '&status=delivering');
  ok(q3.json.total === 1 && q3.json.items[0].id === F2, 'q + status=delivering → 只回 F2', { t: q3.json.total, id: q3.json.items && q3.json.items[0] && q3.json.items[0].id });
  const q4 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk) + '&status=pending,delivering');
  ok(q4.json.total === 2, 'status 支持逗号多值', q4.json.total);
  const q5 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk) + '&type=pickup');
  ok(q5.json.total === 1 && q5.json.items[0].id === F1, 'type=pickup → 只回自提单', q5.json.total);
  const today = new Date();
  const ymd = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0');
  const q6 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk) + '&date=' + ymd);
  ok(q6.json.total === 2, 'date=今天 → 2 单', q6.json.total);
  const q7 = await api('GET', '/api/orders?q=' + encodeURIComponent(mk) + '&date=1999-01-01');
  ok(q7.json.total === 0, 'date=1999-01-01 → 0 单', q7.json.total);
  const q8 = await api('GET', '/api/orders?date=2026-13-99');
  ok(q8.status === 400 && /日期格式/.test(q8.text), '非法日期 → 400 且提示「日期格式」', { s: q8.status, t: q8.text.slice(0, 80) });

  // ⑧ 顾客身份下筛选不得越权
  section('⑧ 顾客身份下筛选只能在本人订单内再筛');
  // 这两条必须真的以顾客身份发（noAuth）：否则严格档带管理员身份会看到全店订单，断言就假失败了
  const c1 = await api('GET', '/api/orders?phone=' + PHONE_F2 + '&q=' + encodeURIComponent(RUN + '筛选甲'), undefined, undefined, { noAuth: true });
  ok(c1.status === 200 && c1.json.total === 0, '乙的手机号 + 甲的 q → 0 单（筛不到别人的单）', { s: c1.status, t: c1.json && c1.json.total });
  const c2 = await api('GET', '/api/orders?phone=' + PHONE_F2 + '&q=' + encodeURIComponent(mk), undefined, undefined, { noAuth: true });
  ok(c2.json.total === 1 && c2.json.items[0].id === F2, '乙的手机号 + 模糊 q → 只有自己的 1 单', c2.json && c2.json.total);

  // ⑨ CSV 导出
  section('⑨ CSV 导出（BOM / 12 列 / RFC4180 转义）');
  const csv = await apiBin('/api/orders/export.csv?q=' + encodeURIComponent(mk));
  ok(csv.status === 200, '导出接口 200', csv.status);
  ok(csv.bytes[0] === 0xEF && csv.bytes[1] === 0xBB && csv.bytes[2] === 0xBF, '前三字节是 EF BB BF（Excel 不乱码）', Array.from(csv.bytes.slice(0, 3)));
  ok(/text\/csv/i.test(csv.ctype), 'Content-Type 是 text/csv', csv.ctype);
  ok(/attachment/.test(csv.cdisp) && /orders-\d{8}-\d{4}\.csv/.test(csv.cdisp), 'Content-Disposition 是附件且文件名符合 orders-YYYYMMDD-HHMM.csv', csv.cdisp);
  const body = csv.text.replace(/^\uFEFF/, '').trim();
  const lines = body.split(/\r?\n/);
  ok(lines[0] === '订单号,下单时间,状态,顾客,手机号,配送方式,商品明细,件数,商品金额,配送费,合计,备注', '表头 12 列顺序固定', lines[0]);
  // 逐行按 RFC4180 解析，验证「名字里有逗号与引号」的行仍然是 12 列
  function parseCSV(line) {
    const out = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') { inQ = false; }
        else { cur += ch; }
      } else if (ch === '"') { inQ = true; }
      else if (ch === ',') { out.push(cur); cur = ''; }
      else { cur += ch; }
    }
    out.push(cur);
    return out;
  }
  const dataLines = lines.slice(1).filter(l => l.trim() !== '');
  ok(dataLines.length === 2, '导出 2 行数据（与筛选一致）', dataLines.length);
  const rowF1 = dataLines.map(parseCSV).find(cols => cols[0] === F1);
  ok(!!rowF1, '能按订单号找到 F1 那一行', dataLines.map(l => parseCSV(l)[0]));
  if (rowF1) {
    ok(rowF1.length === 12, '含逗号/引号/换行的顾客名那一行仍是 12 列', rowF1.length);
    ok(rowF1[3] === RUN + '筛选甲, "特别"', '顾客名里的逗号与引号被正确还原', rowF1[3]);
    ok(/D.*×1/.test(rowF1[6]) || rowF1[6].indexOf('×1') > 0, '明细列是「商品名×数量;」形状', rowF1[6]);
    ok(rowF1[6].slice(-1) === ';', '明细列以 ; 结尾', rowF1[6]);
  }
  const csv1 = await apiBin('/api/orders/export.csv?q=' + encodeURIComponent(mk) + '&limit=1');
  const l1 = csv1.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/).slice(1).filter(l => l.trim() !== '');
  ok(l1.length === 1, 'limit=1 → 只导 1 行数据', l1.length);
  if (STRICT) {
    // CSV 里是全店订单 + 顾客手机号，是这一轮最敏感的一个出口：严格档必须拦住裸请求
    const bareCsv = await fetch(BASE + '/api/orders/export.csv?limit=1');
    ok(bareCsv.status === 401, '严格档：不带管理员 Cookie 导出 CSV → 401（订单含顾客手机号，不能裸奔）', bareCsv.status);
    const bareList = await fetch(BASE + '/api/orders?limit=1');
    ok(bareList.status === 400 || bareList.status === 401, '严格档：不带身份读订单列表 → 400/401（不裸奔）', bareList.status);
  }

  // ⑩ 三端契约逐字一致（静态扫描源码，防「某个端把 price_desc 写成 pricedesc」这类静默分叉）
  section('⑩ 三端排序契约逐字一致（静态扫描）');
  const fs = require('fs');
  const path = require('path');
  const root = path.join(__dirname, '..');
  const src = (p) => { try { return fs.readFileSync(path.join(root, p), 'utf8'); } catch (e) { return ''; } };
  const miniText = ['miniprogram/pages/category/category.js', 'miniprogram/pages/category/category.wxml',
    'miniprogram/pages/search/search.js', 'miniprogram/pages/search/search.wxml',
    'miniprogram/pages/index/index.js', 'miniprogram/pages/goods/goods.js',
    'miniprogram/utils/api.js', 'miniprogram/utils/rules.js'].map(src).join('\n');
  // Web 端可能把排序放在新文件里，所以扫整个 web/ 目录（排除测试与后台两文件），新文件自动纳入
  const webFiles = (() => { try { return fs.readdirSync(path.join(root, 'web')); } catch (e) { return []; } })()
    .filter(f => /\.(js|html)$/.test(f) && !/^test-/.test(f) && f !== 'admin.html' && f !== 'mall-admin.js');
  const webText = webFiles.map(f => src('web/' + f)).join('\n');
  ok(miniText.length > 0 && webText.length > 0, '两端源码可读', { mini: miniText.length, web: webText.length });
  const VALS = ['default', 'hot', 'price_asc', 'price_desc'];
  const quoted = (t, v) => t.indexOf("'" + v + "'") >= 0 || t.indexOf('"' + v + '"') >= 0;
  ok(VALS.every(v => quoted(miniText, v)), '小程序端四个排序值拼写一致（default/hot/price_asc/price_desc）', VALS.filter(v => !quoted(miniText, v)));
  ok(VALS.every(v => quoted(webText, v)), 'Web 端四个排序值拼写一致', VALS.filter(v => !quoted(webText, v)));
  const LABELS = ['综合', '销量', '价格'];
  ok(LABELS.every(l => miniText.indexOf(l) >= 0), '小程序端文案含 综合/销量/价格', LABELS.filter(l => miniText.indexOf(l) < 0));
  ok(LABELS.every(l => webText.indexOf(l) >= 0), 'Web 端文案含 综合/销量/价格', LABELS.filter(l => webText.indexOf(l) < 0));
  const badVariant = /(priceAsc|pricedesc|priceDesc|priceDsc|sale_asc|sale_desc|hot_asc)/;
  ok(!badVariant.test(miniText), '小程序端没有排序值的变体拼写', (miniText.match(badVariant) || [])[0]);
  ok(!badVariant.test(webText), 'Web 端没有排序值的变体拼写', (webText.match(badVariant) || [])[0]);
  ok(/debounce|防抖/i.test(miniText) && miniText.indexOf('300') >= 0, '小程序端搜索防抖 300ms', null);
  ok(/debounce|防抖/i.test(webText) && webText.indexOf('300') >= 0, 'Web 端搜索防抖 300ms', null);

  // 汇总
  if (warnings.length) {
    console.log('\n警告（不是失败，但别忽略）：');
    warnings.forEach((w, i) => console.log('  ' + (i + 1) + '. ' + w));
  }
  if (failures.length) {
    console.log('\n失败清单：');
    failures.forEach((f, i) => console.log('  ' + (i + 1) + '. ' + f));
  }
  console.log('\n========================================');
  console.log('通过 ' + pass + ' 项 / 失败 ' + fail + ' 项');
  process.exit(fail ? 1 : 0);
})().catch(e => {
  console.log('\n验收脚本自身崩了：' + (e && e.stack || e));
  console.log('通过 ' + pass + ' 项 / 失败 ' + (fail + 1) + ' 项');
  process.exit(1);
});

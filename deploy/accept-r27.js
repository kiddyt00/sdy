#!/usr/bin/env node
/* =====================================================================
 * 第 27 轮端到端验收（纯 Node，零依赖）
 *
 * 用法：node deploy/accept-r27.js [base]        # 默认 http://127.0.0.1:8093
 *
 * 前置：
 *   - 一个**干净的临时后端**（`bash deploy/verify-all.sh` 会自动起；也可手动起，
 *     必须带 WX_API_BASE 指向 deploy/fake-wx.js，否则员工身份那一段会 503）。
 *   - 服务端未设置 SEED_DEMO（默认关），所以启动时商品库是空的。
 *
 * 覆盖 `docs/迭代路线图-第27~31轮.md` 第五节的验收项：
 *   ① 三端规则同判（web/pricing.js · miniprogram/utils/rules.js · 状态文案）
 *   ② 空库不播种（SEED_DEMO 默认关）
 *   ③ 订单归属（无身份 400 / A 的列表不含 B / A 的单对 B 是 404）
 *   ④ advance 无员工令牌 403；顾客可用 done 确认收货
 *   ⑤ 下单幂等（同 clientToken 只扣一次库存）
 *   ⑥ 库存原子（超量 400 且库存不变）
 *   ⑦ 取消回补（库存回原位 + stock_log 有回补流水）
 *   ⑧ 地址簿钥匙（无 / 错 key 读不到，对 key 读得到）
 *   ⑨ settings 下发 lowStock / minOrder
 *   ⑩ 员工令牌（登录发令牌 → /api/staff/* 可读 → 员工能推进订单）
 *   ⑪ 配送费边界 29.99 / 29.995 / 30.00 三端同判
 *
 * 退出码 = 失败项数（0 = 全绿）。所有判定都打印实测原值，便于事后追。
 * ===================================================================== */
'use strict';

const BASE = (process.argv[2] || 'http://127.0.0.1:8093').replace(/\/+$/, '');
const webPricing = require('../web/pricing.js');
const webMall = require('../web/mall.js');
const miniRules = require('../miniprogram/utils/rules.js');

let pass = 0, fail = 0;
const failures = [];
// 警告：不是失败，但必须让读日志的人看见（例如「灰度模式下这一档保护其实没生效」）
const warnings = [];
function warn(msg) { warnings.push(msg); console.log('  ⚠ ' + msg); }
// 鉴权通道模式：true = 已设 ADMIN_PASSWORD（严格）；false = 灰度（管理端放行）
// 第 27 轮生产**故意**跑灰度：一开口令，员工小程序的三条写路径（入库/建档/上下架）
// 会全部 401（requireAdmin 不认员工令牌），而后台又没有登录页。（详见路线图第 30 轮）
let STRICT = false;
function ok(cond, msg, extra) {
  if (cond) { pass++; console.log('  ✔ ' + msg); }
  else { fail++; failures.push(msg); console.log('  ✘ ' + msg + (extra !== undefined ? '  ← 实测：' + JSON.stringify(extra) : '')); }
}
function section(t) { console.log('\n■ ' + t); }
function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

// 管理端 Cookie 罐：严格模式下 ⓪b 登录一次，之后所有请求自动带上；
// 需要验证「无身份会被拒」的用例用 { noAuth: true } 显式不带 Cookie。
let COOKIE = '';

async function api(method, path, body, headers, opts) {
  const h = Object.assign({ 'content-type': 'application/json' }, headers || {});
  if (COOKIE && !(opts && opts.noAuth)) h.cookie = COOKIE;
  // 管理端身份要在服务端被**显式声明**（identity.go adminMarked）：管理后台与顾客页
  // 共用一个浏览器的 Cookie，服务端不能「带了 Cookie 就当管理员」。
  if (COOKIE && opts && opts.admin) h['X-Admin'] = '1';
  const opt = { method: method, headers: h };
  if (body !== undefined && body !== null) opt.body = JSON.stringify(body);
  let res, text = '';
  try {
    res = await fetch(BASE + path, opt);
    text = await res.text();
  } catch (e) {
    return { status: 0, json: null, text: 'NETWORK: ' + e.message };
  }
  let sc = '';
  try { const arr = res.headers.getSetCookie ? res.headers.getSetCookie() : []; sc = arr && arr.length ? arr[0] : (res.headers.get('set-cookie') || ''); } catch (e) { sc = ''; }
  const m = sc && /^(sdy_admin=[^;]*)/.exec(sc);
  if (m) COOKIE = m[1];
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (e) { json = null; }
  return { status: res.status, json: json, text: text };
}
const qs = o => Object.keys(o).filter(k => o[k] !== undefined && o[k] !== null && o[k] !== '')
  .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(o[k])).join('&');

(async function main() {
  const RUN = String(Date.now()).slice(-7);
  const P_A = 'T' + RUN + 'A', P_B = 'T' + RUN + 'B', P_C = 'T' + RUN + 'C';
  const PH_A = '139' + RUN, PH_B = '138' + RUN;

  console.log('第 27 轮验收 → ' + BASE + '   (run ' + RUN + ')');

  // ---------------------------------------------------------------- ⓪ 服务在跑
  section('⓪ 后端存活');
  {
    const h = await api('GET', '/healthz');
    ok(h.status === 200, 'GET /healthz → 200', h.status);
    if (h.status !== 200) { console.log('\n后端没起来，后面的用例没法跑。'); return finish(); }
    // 通道探测：/api/couriers 被 requireAdmin 罩住 —— 401 说明口令已设（严格模式），200 说明灰度放行。
    const probe = await api('GET', '/api/couriers');
    STRICT = probe.status === 401;
    console.log('  · 鉴权通道：' + (STRICT ? '已开启（ADMIN_PASSWORD 已设置）' : '灰度（未设 ADMIN_PASSWORD，管理端放行）'));
    if (!STRICT) {
      warn('灰度模式：无身份请求会被当成管理端放行 —— 无身份 GET /api/orders 能拿到全店订单、'
        + '无身份也能取消/推进任意订单。生产第 27 轮就是这一档（先发版后配置）。'
        + '归属过滤对**带身份**（openid/phone）和**带员工令牌**的请求是真生效的，'
        + '而小程序与 Web 顾客端真实发的请求都带身份；彻底关掉缺口要等第 30 轮同时交付'
        + '「requireAdmin 支持员工令牌」+「后台登录页」。');
    }
  }

  // ---------------------------------------------------------------- ⓪b 管理端鉴权通道
  section('⓪b 管理端鉴权通道（第 27 轮只交付通道；生产第 27 轮故意跑灰度）');
  {
    if (STRICT) {
      const wrong = await api('POST', '/api/admin/login', { password: 'definitely-not-the-password' }, null, { noAuth: true });
      ok(wrong.status === 401, '错口令登录 → 401', { status: wrong.status, body: wrong.text.slice(0, 100) });
      const pw = process.env.ADMIN_PASSWORD || '';
      if (!pw) {
        // 严格档下忘了带口令，会让后面 30 多项因为 401 连锁失败，看起来像一堆真 bug。
        // 与其给一屏假失败，不如直接停在这里说清楚。
        console.log('');
        console.log('‼ 服务端开着鉴权（ADMIN_PASSWORD 已设置），但本进程没有 ADMIN_PASSWORD 环境变量，');
        console.log('  后续所有需要管理权限的步骤都会 401。请用服务端同一个口令重跑：');
        console.log('    ADMIN_PASSWORD=<服务端口令> node deploy/accept-r27.js ' + BASE);
        process.exit(2);
      }
      const good = await api('POST', '/api/admin/login', { password: pw }, null, { noAuth: true });
      ok(good.status === 200 && !!COOKIE, '正确口令 → 200 并下发 sdy_admin Cookie', { status: good.status, cookie: COOKIE.slice(0, 18) + '…' });
      const gated = await api('GET', '/api/couriers');
      ok(gated.status === 200, '带 Cookie 访问被罩住的管理端点 → 200', gated.status);
      const bare = await api('GET', '/api/couriers', null, null, { noAuth: true });
      ok(bare.status === 401, '不带 Cookie 访问被罩住的管理端点 → 401', bare.status);
      const out = await api('POST', '/api/admin/logout');
      const afterOut = await api('GET', '/api/couriers', null, null, { noAuth: true });
      ok(out.status === 200 && afterOut.status === 401, '退出后 Cookie 立即失效（401）', { out: out.status, after: afterOut.status });
      // 退出会清掉 Cookie，后面 ⑩ 要用后台提权，重新登一次
      await api('POST', '/api/admin/login', { password: pw }, null, { noAuth: true });
    } else {
      const open = await api('GET', '/api/couriers');
      ok(open.status === 200, '灰度档：被罩住的管理端点此刻无需鉴权即可访问（已知缺口）', open.status);
    }
  }

  // ---------------------------------------------------------------- ① 三端规则同判
  section('① 三端规则同判（纯函数，不需要后端数据）');
  {
    const cases = [
      ['delivery', 29.99], ['delivery', 29.995], ['delivery', 30], ['delivery', 0],
      ['delivery', 10], ['pickup', 10], ['pickup', 100], ['drone', 10], ['', 50], [undefined, 50]
    ];
    let same = true, rows = [];
    cases.forEach(c => {
      const w = webPricing.deliveryFee(c[0], c[1]);
      const m = miniRules.deliveryFee(c[0], c[1]);
      rows.push(String(c[0]) + '/' + c[1] + ' web=' + w + ' mini=' + m);
      if (w !== m) same = false;
    });
    ok(same, '10 组配送费：web/pricing.js 与 miniprogram/utils/rules.js 逐组相同', rows);
    ok(webPricing.deliveryFee('delivery', 29.995) === 0 && webPricing.deliveryFee('delivery', 29.99) === 3
      && webPricing.deliveryFee('delivery', 30) === 0,
      '边界：29.99→3 元 / 29.995 先 round2 成 30.00→免 / 30.00→免',
      [webPricing.deliveryFee('delivery', 29.99), webPricing.deliveryFee('delivery', 29.995), webPricing.deliveryFee('delivery', 30)]);
    // 未知配送方式按 delivery 计费（不是免费、也不是抛错）
    ok(webPricing.deliveryFee('drone', 10) === 3 && miniRules.deliveryFee('drone', 10) === 3,
      '未知配送方式按 delivery 计费（不抛错、不白送）');
    // minFree<=0 = 不免运费
    ok(webPricing.deliveryFee('delivery', 999, { minFree: 0 }) === 3 && miniRules.deliveryFee('delivery', 999, { minFree: 0 }) === 3,
      'minFree<=0 表示「不开启满额免配送」（不是全免）');
    // 有效价：非零售等级 + 批发价>0 → 批发价
    const priceCases = [[['retail', 10, 8], 10], [['wholesale', 10, 8], 8], [['vip', 10, 8], 8],
      [['wholesale', 10, 0], 10], [['boss', 10, 8], 10]];
    let priceSame = true;
    priceCases.forEach(c => {
      const w = webPricing.effectivePrice(c[0][0], c[0][1], c[0][2]);
      if (w !== c[1]) priceSame = false;
    });
    ok(priceSame, '5 组有效价：未知等级归 retail、批发价 0 → 用零售价', priceCases.map(c => c[0][0] + '→' + webPricing.effectivePrice(c[0][0], c[0][1], c[0][2])));
    // 状态文案
    const CANON = { pending: '待备货', delivering: '配送中', ready: '待取货', done: '已完成', cancelled: '已取消' };
    let labelOk = true, bad = [];
    Object.keys(CANON).forEach(k => {
      const m = miniRules.STATUS_LABELS && miniRules.STATUS_LABELS[k];
      const w = webMall.STATUS_META && webMall.STATUS_META[k] && webMall.STATUS_META[k].label;
      if (m !== CANON[k]) { labelOk = false; bad.push('mini ' + k + '=' + m); }
      if (w !== CANON[k]) { labelOk = false; bad.push('web ' + k + '=' + w); }
    });
    ok(labelOk, '五档状态文案三端逐字相同（小程序 / Web 商城）', bad);
  }

  // ---------------------------------------------------------------- ② 空库不播种
  section('② 空库不播种（SEED_DEMO 默认关）');
  {
    const r = await api('GET', '/api/products?limit=5');
    const items = (r.json && r.json.items) || [];
    const demo = items.filter(p => p.isDemo || p.is_demo);
    ok(r.status === 200 && items.length === 0, '干净的库里 GET /api/products 为空（没有拿演示商品顶数）', { status: r.status, n: items.length });
    ok(demo.length === 0, '即使有数据也不带 isDemo 的才算正式商品', demo.length);
  }

  // ---------------------------------------------------------------- 建测试商品
  section('备料：建 3 个测试商品');
  {
    const mk = async (code, name, salePrice, stock, wholesalePrice) => {
      const r = await api('POST', '/api/products', {
        code: code, name: name, brand: '验收', spec: '测试', category: '验收测试',
        img: '', costPrice: 1, salePrice: salePrice, wholesalePrice: wholesalePrice || 0,
        refPrice: 0, unit: '件', stock: stock, isWholesale: false
      });
      ok(r.status === 200 || r.status === 201, '建商品 ' + name + '（' + code + '）→ ' + r.status, r.text.slice(0, 120));
    };
    await mk(P_A, '验收·免运费边界A', 29.99, 10);
    await mk(P_B, '验收·边界B', 5.999, 10);
    await mk(P_C, '验收·批发价C', 15, 10, 12);
    const c = await api('GET', '/api/products/' + P_C + '?phone=' + PH_A);
    ok(c.status === 200 && Number(c.json && c.json.salePrice) === 15 && Number(c.json && c.json.wholesalePrice) === 12,
      '详情回读：零售 15 / 批发 12 都在', c.json && { salePrice: c.json.salePrice, wholesalePrice: c.json.wholesalePrice });
  }

  // ---------------------------------------------------------------- ③ 订单归属
  section('③ 订单归属（第 27 轮核心）');
  let orderA = null;
  {
    const noId = await api('GET', '/api/orders', null, null, { noAuth: true });
    if (STRICT) {
      ok(noId.status === 400 && /缺少身份/.test(noId.text), '无身份 GET /api/orders → 400 缺少身份（改动前是 200 + 全店订单）',
        { status: noId.status, body: noId.text.slice(0, 160) });
    } else {
      // 灰度档：这一条同时起两个作用 —— 记录已知缺口，并确认我们**没有**顺手破坏管理端
      // （老板的后台是「无身份/带 Cookie」的全店视角，必须照常能列全店单）。
      const n = ((noId.json && noId.json.items) || []).length;
      ok(noId.status === 200,
        '灰度档：无身份 GET /api/orders → 200 管理端全店视角（此刻库里有 ' + n + ' 单；已知缺口，第 30 轮关闭）',
        { status: noId.status, n: n, body: noId.text.slice(0, 100) });
    }

    const r1 = await api('POST', '/api/orders', {
      customerName: '验收顾客A', phone: PH_A, address: '验收地址 A 1 号', deliveryType: 'delivery',
      items: [{ code: P_A, qty: 1 }], clientToken: 'tok-' + RUN + '-1'
    });
    ok(r1.status === 201 && r1.json && r1.json.id, '顾客 A 下第 1 单（29.99 元商品）→ 201', r1.text.slice(0, 200));
    orderA = r1.json;
    ok(orderA && Number(orderA.deliveryFee) === 3 && Number(orderA.total) === 32.99,
      '后端算出的运费/合计 与 web·mini 同判：29.99 → 运费 3 / 合计 32.99',
      orderA && { deliveryFee: orderA.deliveryFee, subtotal: orderA.subtotal, total: orderA.total });

    const listA = await api('GET', '/api/orders?' + qs({ phone: PH_A }));
    ok(listA.status === 200 && (listA.json.items || []).every(o => o.phone === PH_A),
      '按 phone 只回本人订单（' + ((listA.json && listA.json.items) || []).length + ' 单）',
      (listA.json && listA.json.items || []).map(o => o.phone));

    const listB = await api('GET', '/api/orders?' + qs({ phone: PH_B }));
    ok(listB.status === 200 && ((listB.json && listB.json.items) || []).length === 0,
      '顾客 B 的列表看不到顾客 A 的单', listB.json);

    const detailB = await api('GET', '/api/orders/' + orderA.id + '?' + qs({ phone: PH_B }));
    ok(detailB.status === 404, '顾客 B 按单号直接查顾客 A 的单 → 404（不泄露存在性）', { status: detailB.status, body: detailB.text.slice(0, 160) });

    const detailA = await api('GET', '/api/orders/' + orderA.id + '?' + qs({ phone: PH_A }));
    ok(detailA.status === 200 && detailA.json && detailA.json.id === orderA.id, '顾客 A 查自己的单 → 200', detailA.status);

    const pg = await api('GET', '/api/orders?' + qs({ phone: PH_A, limit: 1, offset: 0 }));
    ok(pg.status === 200 && Array.isArray(pg.json.items) && pg.json.items.length === 1 && typeof pg.json.total === 'number' && pg.json.total >= 1,
      '分页生效：limit=1 只回 1 条，total 是符合条件总数（不是当前页条数）',
      pg.json && { n: pg.json.items.length, total: pg.json.total });
  }

  // ---------------------------------------------------------------- ④ advance 权限
  section('④ 订单推进权限（advance）');
  {
    const noTok = await api('POST', '/api/orders/' + orderA.id + '/advance', { to: 'delivering' }, null, { noAuth: true });
    if (STRICT) {
      ok(noTok.status === 403 && /只有店主/.test(noTok.text), '无员工令牌推进到「配送中」→ 403 只有店主可以推进订单状态',
        { status: noTok.status, body: noTok.text.slice(0, 160) });
    } else {
      // 灰度档：无身份=管理端放行，所以这里会**真的**把 orderA 推到「配送中」。
      // 记下这一点，下面 done 那步就是「配送中 → 已完成」，不是「待备货 → 已完成」。
      ok(noTok.status === 200 && noTok.json && noTok.json.status === 'delivering',
        '灰度档：无令牌推进 → 200（无身份按管理端放行，已知缺口）', { status: noTok.status, body: noTok.text.slice(0, 120) });
    }
    if (STRICT) {
      // 严格模式下上面那条被 403 挡下、orderA 还停在「待备货」，而顾客只能 done（确认收货），
      // 从待备货直接 done 是状态机不允许的 409。这里用管理端（Cookie + X-Admin 声明）
      // 把它推到「配送中」，再验证归属人的「确认收货」没被鉴权打死。
      const adm = await api('POST', '/api/orders/' + orderA.id + '/advance', { to: 'delivering' }, null, { admin: true });
      ok(adm.status === 200 && adm.json && adm.json.status === 'delivering',
        '管理端把订单推到「配送中」（为「确认收货」准备前置状态）', { status: adm.status, body: adm.text.slice(0, 120) });
    }

    const done = await api('POST', '/api/orders/' + orderA.id + '/advance?' + qs({ phone: PH_A }), { to: 'done' });
    ok(done.status === 200 && done.json && done.json.status === 'done',
      '归属人可用 done 确认收货（R25 的「确认收货」不能被鉴权打死）', { status: done.status, body: done.text.slice(0, 160) });
  }

  // ---------------------------------------------------------------- ⑤ 幂等
  section('⑤ 下单幂等（clientToken）');
  {
    const before = (await api('GET', '/api/products/' + P_B)).json;
    const body = { customerName: '验收顾客A', phone: PH_A, address: '验收地址 A 1 号', deliveryType: 'delivery', items: [{ code: P_B, qty: 5 }], clientToken: 'tok-' + RUN + '-2' };
    const first = await api('POST', '/api/orders', body);
    const mid = (await api('GET', '/api/products/' + P_B)).json;
    const again = await api('POST', '/api/orders', body);
    const after = (await api('GET', '/api/products/' + P_B)).json;
    ok(first.status === 201 && Number(first.json.deliveryFee) === 0 && Number(first.json.subtotal) === 30,
      '5 × 5.999 = 29.995 → 先进位到 30.00 → 免运费（合计 30）',
      first.json && { subtotal: first.json.subtotal, deliveryFee: first.json.deliveryFee });
    ok(Number(before.stock) - Number(mid.stock) === 5, '第一次下单扣 5 件库存：' + before.stock + ' → ' + mid.stock);
    ok(again.status === 200 || again.status === 201 ? (again.json && again.json.id === first.json.id) : false,
      '同一个 clientToken 再提交 → 返回原单（不新建订单）', { status: again.status, id: again.json && again.json.id, first: first.json.id });
    ok(again.json && (again.json.duplicated === true), '响应带 duplicated:true（前端据此提示「已提交过」）', again.json && again.json.duplicated);
    ok(Number(after.stock) === Number(mid.stock), '重复提交不再扣库存（' + mid.stock + ' → ' + after.stock + '）');
  }

  // ---------------------------------------------------------------- ⑥ 库存原子
  section('⑥ 库存原子（超卖窗口）');
  {
    const before = (await api('GET', '/api/products/' + P_A)).json;
    const r = await api('POST', '/api/orders', {
      customerName: '验收顾客A', phone: PH_A, address: '验收地址 A 1 号', deliveryType: 'delivery',
      items: [{ code: P_A, qty: 999 }], clientToken: 'tok-' + RUN + '-3'
    });
    const after = (await api('GET', '/api/products/' + P_A)).json;
    ok(r.status === 400 && /库存不足/.test(r.text), '超量下单 → 400 库存不足（不是超卖成功）', { status: r.status, body: r.text.slice(0, 160) });
    ok(Number(after.stock) === Number(before.stock), '失败订单不扣库存：' + before.stock + ' → ' + after.stock);
  }

  // ---------------------------------------------------------------- ⑦ 取消回补
  section('⑦ 取消订单回补库存 + 流水');
  {
    const before = (await api('GET', '/api/products/' + P_C)).json;
    const mk = await api('POST', '/api/orders', {
      customerName: '验收顾客A', phone: PH_A, address: '验收地址 A 1 号', deliveryType: 'delivery',
      items: [{ code: P_C, qty: 2 }], clientToken: 'tok-' + RUN + '-4'
    });
    const mid = (await api('GET', '/api/products/' + P_C)).json;
    const cx = await api('POST', '/api/orders/' + mk.json.id + '/cancel?' + qs({ phone: PH_A }), {});
    const after = (await api('GET', '/api/products/' + P_C)).json;
    ok(mk.status === 201 && Number(before.stock) - Number(mid.stock) === 2, '下单扣 2 件：' + before.stock + ' → ' + mid.stock);
    ok(cx.status === 200 && cx.json && cx.json.status === 'cancelled', '顾客取消自己的单 → 200 cancelled', { status: cx.status, body: cx.text.slice(0, 160) });
    ok(Number(after.stock) === Number(before.stock), '取消回补库存：' + mid.stock + ' → ' + after.stock + '（应回到 ' + before.stock + '）');
    const cx2 = await api('POST', '/api/orders/' + mk.json.id + '/cancel?' + qs({ phone: PH_A }), {});
    const after2 = (await api('GET', '/api/products/' + P_C)).json;
    ok(Number(after2.stock) === Number(before.stock), '重复取消不会二次回补（' + after2.stock + '）', { status: cx2.status });
    const log = await api('GET', '/api/stocklog?limit=50');
    const raw = log.json && (log.json.items || log.json);
    const items = Array.isArray(raw) ? raw : [];
    const back = items.filter(e => String(e.reason || '').indexOf('回补') > -1 || String(e.kind || '') === 'cancel_return');
    ok(back.length >= 1, 'stock_log 里有取消回补流水（审计可追）', items.slice(0, 3).map(e => e.kind + '/' + e.reason));
  }

  // ---------------------------------------------------------------- ⑧ 地址簿钥匙
  section('⑧ 地址簿能力钥匙');
  {
    const saved = await api('POST', '/api/addresses', { phone: PH_A, contact: '验收A', address: '验收地址 A 1 号', isDefault: true });
    const key = saved.json && (saved.json.key || saved.json.addrKey);
    ok(saved.status === 200 && typeof key === 'string' && /^[0-9a-f]{32}$/i.test(key),
      '保存地址返回 32 位 hex 钥匙（客户端存本地）', saved.json);
    const noKey = await api('GET', '/api/addresses?' + qs({ phone: PH_A }));
    ok(noKey.status === 200 && ((noKey.json && noKey.json.items) || []).length === 0,
      '只有手机号拿不到地址（光知道手机号不该能查别人收货地址）', noKey.json);
    const withKey = await api('GET', '/api/addresses?' + qs({ phone: PH_A, key: key }));
    ok(withKey.status === 200 && ((withKey.json && withKey.json.items) || []).length === 1,
      '带对钥匙 → 读到 1 条', withKey.json && { n: (withKey.json.items || []).length });
    const wrong = await api('GET', '/api/addresses?' + qs({ phone: PH_A, key: 'deadbeef'.repeat(4) }));
    ok(((wrong.json && wrong.json.items) || []).length === 0, '错钥匙 → 静默空（不报错也不给数据）', wrong.json);
    await api('DELETE', '/api/addresses/' + ((withKey.json.items[0] || {}).id) + '?' + qs({ phone: PH_A }), null);
    const still = await api('GET', '/api/addresses?' + qs({ phone: PH_A, key: key }));
    ok(((still.json && still.json.items) || []).length === 1, '不带钥匙删不掉（删除必须 phone+key 或员工令牌）', still.json && { n: (still.json.items || []).length });
  }

  // ---------------------------------------------------------------- ⑨ settings
  section('⑨ 运营参数下发（单一真源）');
  {
    const s = await api('GET', '/api/settings');
    ok(s.status === 200 && Number(s.json.lowStock) === 5, 'GET /api/settings 带 lowStock=5（三端不再各写一份硬编码 5）', s.json);
    ok(s.json && typeof s.json.minOrder === 'number', 'GET /api/settings 带 minOrder（起送价）', s.json && s.json.minOrder);
    ok(s.json && s.json.deliveryFee !== undefined && s.json.minFree !== undefined,
      'GET /api/settings 带 deliveryFee / minFree（第 31 轮「服务端单一真源」的落点）', s.json && { deliveryFee: s.json.deliveryFee, minFree: s.json.minFree });
  }

  // ---------------------------------------------------------------- ⑩ 员工令牌
  section('⑩ 员工身份（令牌 → /api/staff/* → 推进订单）');
  {
    const login1 = await api('POST', '/api/wx/login', { code: 'STAFF', role: 'staff' });
    ok(login1.status === 403, '还不是员工的微信号选「员工身份」登录 → 403（不能自己提权）', { status: login1.status, body: login1.text.slice(0, 160) });
    const openid = (login1.json && login1.json.openid) || (login1.status === 403 ? null : null);
    let oid = openid;
    if (!oid) {
      const asCust = await api('POST', '/api/wx/login', { code: 'STAFF' });
      oid = asCust.json && asCust.json.openid;
    }
    ok(!!oid, '先用顾客身份登录拿到 openid（' + oid + '）');
    const promote = await api('POST', '/api/wx/role', { openid: oid, role: 'staff' });
    ok(promote.status === 200, '老板在后台把角色改成员工 → 200', { status: promote.status, body: promote.text.slice(0, 160) });
    const login2 = await api('POST', '/api/wx/login', { code: 'STAFF', role: 'staff' });
    const token = login2.json && login2.json.staffToken;
    ok(login2.status === 200 && typeof token === 'string' && token.length >= 32, '员工身份登录成功并下发令牌', login2.json && { role: login2.json.role, len: (token || '').length });
    const ov = await api('GET', '/api/staff/overview', null, { 'X-Staff-Token': token });
    ok(ov.status === 200, '带令牌 GET /api/staff/overview → 200（聚合数据）', { status: ov.status, body: ov.text.slice(0, 120) });
    const ovBad = await api('GET', '/api/staff/overview', null, { 'X-Staff-Token': 'not-a-token' });
    ok(ovBad.status === 401, '假令牌 → 401（员工身份失效要重新登录）', ovBad.status);
    const all = await api('GET', '/api/orders?limit=200', null, { 'X-Staff-Token': token });
    ok(all.status === 200 && ((all.json && all.json.items) || []).length >= 1, '员工看得到全店订单（不必带 phone）', all.json && { n: (all.json.items || []).length });
    // 员工推进必须用一张**刚下单、还没被推进过**的单：④ 里 orderA 已经走到 done，
    // 状态机不允许从「已完成」再变回「配送中」，复用它会得到 409（脚本自己的坑）。
    const fresh = await api('POST', '/api/orders', {
      customerName: '验收顾客C', phone: PH_A, address: '验收地址 A 1 号', deliveryType: 'delivery',
      items: [{ code: P_C, qty: 3 }], clientToken: 'tok-' + RUN + '-staff'
    });
    const staffOrder = fresh.json && fresh.json.id;
    ok(fresh.status === 201 && !!staffOrder, '为员工推进准备一张新单（' + staffOrder + '）', { status: fresh.status, body: fresh.text.slice(0, 120) });
    const adv = await api('POST', '/api/orders/' + staffOrder + '/advance', { to: 'delivering' }, { 'X-Staff-Token': token });
    ok(adv.status === 200 && adv.json && adv.json.status === 'delivering', '员工把待备货订单推进到「配送中」→ 200（这就是员工专属的那一步）',
      { status: adv.status, body: adv.text.slice(0, 160) });
    const demote = await api('POST', '/api/wx/role', { openid: oid, role: 'customer' });
    const afterDemote = await api('GET', '/api/staff/overview', null, { 'X-Staff-Token': token });
    ok(demote.status === 200 && afterDemote.status === 401, '降回顾客后旧令牌立即失效（401）', { demote: demote.status, after: afterDemote.status });
  }

  finish();
})().catch(e => {
  console.log('\n验收脚本自身崩了：' + (e && e.stack || e));
  fail++;
  finish();
});

function finish() {
  // 失败清单先打、汇总后打：verify-all.sh 只截最后几行，汇总必须在末尾
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
}

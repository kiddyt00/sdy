// 真浏览器验「搜索防抖」：打开商城首页，在搜索框连打 5 个字符，用注入计数器数真实发出的商品列表请求。
// 第 28 轮验收清单第 5 条要求「实测只发 1 次请求」，静态扫描（accept-r28 ⑩）只能证明源码里有 300ms，
// 这个脚本证明运行时行为。
// 用法：node deploy/cdp-debounce.js <url> [每键间隔毫秒，默认 90]
// 退出码：0 = 连打 5 键只发 1 次请求且请求带完整关键词；1 = 不符合（或 CDP 连不上）
const { spawn } = require('child_process');
const url = process.argv[2];
const gapMs = Number(process.argv[3] || 90);
if (!url) { console.log('用法: node deploy/cdp-debounce.js <url> [每键间隔毫秒]'); process.exit(1); }
const PORT = 9600 + Math.floor(Math.random() * 100);
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-crash-reporter',
  '--disable-dev-shm-usage', '--window-size=1440,1400', '--user-data-dir=/tmp/cprof-deb-' + Date.now(),
  '--crash-dumps-dir=/tmp/crash', '--remote-debugging-port=' + PORT, 'about:blank',
], { env: { ...process.env, HOME: '/tmp/chome' }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 注入到页面「文档开始前」：拦 fetch / XHR，只数商品列表请求（/api/products?...，
// 不含 /api/products/hot、/alternatives、/{code} —— 那些是热销与详情）。
const COUNTER = `
(() => {
  const rec = { list: 0, urls: [] };
  window.__req = rec;
  const isList = (u) => typeof u === 'string' && /\\/api\\/products\\?/.test(u);
  const of = window.fetch;
  if (of) window.fetch = function (input) {
    const u = (typeof input === 'string') ? input : ((input && input.url) || '');
    if (isList(u)) { rec.list++; rec.urls.push(u); }
    return of.apply(this, arguments);
  };
  const oo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (m, u) {
    if (isList(u)) { rec.list++; rec.urls.push(u); }
    return oo.apply(this, arguments);
  };
})();
`;

(async () => {
  let page = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try {
      const j = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = j.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) break;
    } catch (e) { }
  }
  if (!page) { console.log('CDP 连不上（Chrome 没起来？）'); chrome.kill(); process.exit(1); }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0; const pending = new Map(); const events = [];
  const send = (method, params) => new Promise(res => { const mid = ++id; pending.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      events.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description.split('\n')[0] : d.text));
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable', {}); await send('Page.enable', {});
  await send('Page.addScriptToEvaluateOnNewDocument', { source: COUNTER });
  await send('Page.navigate', { url });
  await sleep(3000); // 等首页首屏自己那一轮商品请求发完

  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true });
    return r.result ? r.result.value : undefined;
  };
  // 注意：页面里的 Mall 是顶层 `const`（词法声明，不挂在 window 上），必须用 typeof 判断
  const has = await evalJs('!!document.getElementById("q") && (typeof Mall !== "undefined") && !!window.__req');
  if (!has) {
    console.log('页面没准备好（#q / Mall / 计数器缺一个）');
    ws.close(); chrome.kill(); process.exit(1);
  }
  const before = await evalJs('window.__req.list');
  const delay = await evalJs('String(Mall.debounce(function(){}, 300).delay)');
  // 连打 5 个字符：每敲一下都派发 input 事件（inline oninput="doSearch()"）
  const typed = ['可', '可口', '可口可', '可口可乐', '可口可乐 '];
  for (const t of typed) {
    await evalJs(`(() => { const q = document.getElementById("q"); q.value = ${JSON.stringify(t)}; q.dispatchEvent(new Event("input")); })()`);
    await sleep(gapMs);
  }
  await sleep(1300); // 等防抖窗口过去
  const after = await evalJs('window.__req.list');
  const urls = await evalJs('JSON.stringify(window.__req.urls.slice(-3))');
  const delta = after - before;
  const last = JSON.parse(urls || '[]').slice(-1)[0] || '';

  console.log('URL: ' + url);
  console.log('Mall.debounce 的延时: ' + delay + 'ms');
  console.log('连打 5 键期间发出的商品列表请求数: ' + delta + (delta === 1 ? '（1 = 防抖生效）' : '（应为 1）'));
  console.log('最后一次请求: ' + last);
  // 页面会把关键词 trim 掉再发（末尾那个空格不进 query），所以期望值同样用 trim 后的词
  const full = encodeURIComponent('可口可乐');
  const okAll = delay === '300' && delta === 1 && last.indexOf('keyword=' + full) >= 0;
  if (!okAll) events.push('DEBOUNCE: 期望「300ms + 只发 1 次 + 请求带完整关键词 ' + full + '」');

  // ── 第二段（第 28 轮契约 7.8 无结果分支）：搜一个必然搜不到的词，
  //    必须给「没找到「<词>」，换个词试试」+ 热销商品（/api/products/hot），且底部不出现「还有下一页」。
  const NOPE = 'zzzz买不到的东西';
  await evalJs(`(() => { const q = document.getElementById("q"); q.value = ${JSON.stringify(NOPE)}; q.dispatchEvent(new Event("input")); })()`);
  await sleep(1800); // 防抖 300ms + 请求往返 + 热销补画面
  const gridText = await evalJs('(document.getElementById("grid") || {}).innerText || ""');
  const hotTitle = await evalJs('(document.querySelector("#grid .hot-title") || {}).innerText || ""');
  const hotCards = await evalJs('document.querySelectorAll("#grid .pcard").length');
  const moreText = await evalJs('((document.getElementById("moreBar") || {}).innerText || "").trim()');
  const wantMsg = '没找到「' + NOPE + '」，换个词试试';
  const okEmpty = gridText.indexOf(wantMsg) >= 0 && hotCards >= 1 && hotCards <= 6 && moreText === '';
  if (!okEmpty) {
    events.push('EMPTY: 期望「' + wantMsg + '」+ 1~6 件热销 + 底部无分页条，实际 卡片数=' + hotCards + ' 底部=' + JSON.stringify(moreText));
  }
  const msgLine = (gridText.split('\n').filter(l => l.indexOf('没找到') >= 0)[0] || '').trim();
  console.log('无结果文案: ' + JSON.stringify(msgLine || gridText));
  console.log('热销标题: ' + JSON.stringify(hotTitle) + '，热销商品卡片数: ' + hotCards + '（1~6）');
  console.log('空结果时底部条: ' + JSON.stringify(moreText) + '（应为空，不误导「还有下一页」）');

  console.log(events.length ? events.join('\n') : '（运行时可验证：防抖 300ms/1 次 + 无结果文案与热销推荐）');
  ws.close(); chrome.kill();
  process.exit(okAll && okEmpty ? 0 : 1);
})();

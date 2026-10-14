// 用无头 Chrome（CDP）打开一个页面，抓「加载期 JS 异常 / console.error / 网络错误」，并回读关键全局变量。
// 本模型读不了截图，页面级验收只能靠这个脚本的数值与异常。
// 打开 /admin 时额外验第 28 轮验收第 3 条：点导出必须是**真浏览器下载**
// （Browser.setDownloadBehavior → 调 SdyApi.downloadOrdersCSV → 文件落盘 + UTF-8 BOM + 12 列）。
// 用法：node deploy/cdp-check.js <url> [等待毫秒，默认 2600]
// 退出码：0 = 无异常；1 = 有异常或 CDP 连不上（verify-all.sh 会把它当失败）
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const url = process.argv[2];
const waitMs = Number(process.argv[3] || 2600);
if (!url) { console.log('用法: node deploy/cdp-check.js <url> [等待毫秒]'); process.exit(1); }
const PORT = 9500 + Math.floor(Math.random() * 100);
const chrome = spawn('google-chrome', [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-crash-reporter',
  '--disable-dev-shm-usage', '--window-size=1440,1400', '--user-data-dir=/tmp/cprof-err-' + Date.now(),
  '--crash-dumps-dir=/tmp/crash', '--remote-debugging-port=' + PORT, 'about:blank',
], { env: { ...process.env, HOME: '/tmp/chome' }, stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      events.push('EXCEPTION: ' + (d.exception && d.exception.description ? d.exception.description.split('\n').slice(0, 3).join(' | ') : d.text) + '  @' + (d.url || '') + ':' + d.lineNumber);
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      events.push('CONSOLE.' + m.params.type + ': ' + m.params.args.map(a => a.value || a.description || '').join(' '));
    }
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
      events.push('LOG.' + m.params.entry.source + ': ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  await send('Runtime.enable', {}); await send('Log.enable', {}); await send('Page.enable', {});
  await send('Page.navigate', { url });
  await sleep(waitMs);
  const r = await send('Runtime.evaluate', {
    expression: '({Admin: typeof Admin, Mall: typeof Mall, Pricing: typeof Pricing, SdyApi: typeof SdyApi})',
    returnByValue: true,
  });
  console.log('URL: ' + url);
  console.log('globals: ' + JSON.stringify(r.result.value));
  // 页面永久白屏（脚本顶层报错）时，这些全局变量会全是 "undefined"
  const g = r.result.value || {};
  const broken = ['Admin', 'Mall', 'Pricing', 'SdyApi'].every(k => g[k] === 'undefined');
  if (broken) events.push('EXCEPTION: 页面脚本一个都没加载成功（可能整份脚本因顶层错误未执行）');

  // 第 28 轮验收第 3 条：后台「导出」必须是**真浏览器下载**（不是 JS 拼字符串弹窗）。
  // 只在 /admin 页跑；本脚本与 verify-all.sh 一样按灰度档（未设 ADMIN_PASSWORD）跑，故无 Cookie 也能导出。
  if (/\/admin\b/.test(url) && g.SdyApi !== 'undefined') {
    const DL = '/tmp/cdp-dl';
    fs.rmSync(DL, { recursive: true, force: true });
    fs.mkdirSync(DL, { recursive: true });
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL });
    const pr = await send('Runtime.evaluate', {
      expression: '(async () => { try { const r = await SdyApi.downloadOrdersCSV({}); return { ok: !!(r && r.ok), filename: (r && r.filename) || "" }; } catch (e) { return { err: String((e && e.message) || e) }; } })()',
      awaitPromise: true, returnByValue: true,
    });
    const v = (pr.result && pr.result.value) || {};
    await sleep(1800);
    const files = fs.existsSync(DL) ? fs.readdirSync(DL) : [];
    let bom = false, cols = 0;
    if (files.length) {
      const buf = fs.readFileSync(path.join(DL, files[0]));
      bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
      const firstLine = buf.toString('utf8', 3).split('\n')[0].replace(/\r$/, '');
      cols = firstLine ? firstLine.split(',').length : 0;
    }
    console.log('导出（真浏览器下载）: ' + JSON.stringify(v) + ' 落盘: ' + JSON.stringify(files) + ' BOM=' + bom + ' 列数=' + cols);
    if (v.err) events.push('EXPORT: 导出报错：' + v.err);
    else if (!/^orders-\d{8}-\d{4}\.csv$/.test(v.filename || '')) events.push('EXPORT: 文件名形状不对：' + v.filename);
    else if (!files.length) events.push('EXPORT: 没有落盘文件（浏览器没真正下载，可能只是拼字符串）');
    else if (!bom) events.push('EXPORT: 落盘 CSV 缺 UTF-8 BOM（Excel 会乱码）');
    else if (cols !== 12) events.push('EXPORT: 落盘 CSV 列数应为 12，实际 ' + cols);
  }

  console.log(events.length ? events.join('\n') : '（无异常 / 无 console 错误）');
  ws.close(); chrome.kill();
  process.exit(events.some(e => e.startsWith('EXCEPTION')) ? 1 : 0);
})();

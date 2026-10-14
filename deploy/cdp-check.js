// 用无头 Chrome（CDP）打开一个页面，抓「加载期 JS 异常 / console.error / 网络错误」，并回读关键全局变量。
// 本模型读不了截图，页面级验收只能靠这个脚本的数值与异常。
// 用法：node deploy/cdp-check.js <url> [等待毫秒，默认 2600]
// 退出码：0 = 无异常；1 = 有异常或 CDP 连不上（verify-all.sh 会把它当失败）
const { spawn } = require('child_process');
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
  console.log(events.length ? events.join('\n') : '（无异常 / 无 console 错误）');
  ws.close(); chrome.kill();
  process.exit(events.some(e => e.startsWith('EXCEPTION')) ? 1 : 0);
})();

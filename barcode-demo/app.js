/* =====================================================================
 * 条码双库 Demo —— 商品库(product) + 本地条码库(barcode_lib) + 云端兜底
 * 对应《独立小程序商城 · 细节讨论记录》§2.7 设计方案
 * 纯浏览器运行：localStorage 存储三库数据，无需后端即可演示完整链路。
 * 云端 Provider 抽象：Mock（内置样例数据）/ 阿里云市场（真实 API）。
 * ===================================================================== */
'use strict';

const DemoApp = (() => {

  // ---------------- 后端通道（bd-api.js） ----------------
  // 后端在线 → 解析链与建档都在服务端执行（APPCODE 只在服务端）；离线 → 纯浏览器演示。
  const api = (typeof BdApi !== 'undefined' && BdApi) ? BdApi
    : (typeof require === 'function' ? (function () { try { return require('./bd-api.js'); } catch (e) { return null; } })() : null);
  const apiOnline = () => !!(api && api.online());

  // ---------------- 常量与存储 ----------------
  const LS = {
    products: 'bd_products',
    lib: 'bd_barcodeLib',
    log: 'bd_scanLog',
    settings: 'bd_settings',
    usage: 'bd_usage'
  };
  const DEFAULT_SETTINGS = {
    provider: 'mock',        // 'mock' | 'ali'
    appcode: '',             // 阿里云市场 APPCODE（仅存本地，勿提交仓库）
    gateway: 'https://gscode.market.alicloudapi.com/getBarcode', // 云市场分配的真实网关完整地址（含路径）
    quota: 200,              // 套餐每日可调用次数（演示默认 200）
    ttlDays: 90,             // 查无标记 TTL（天）
    failSim: false           // 云端失败模拟（演示熔断用）
  };

  // 运行态（浏览器内从 localStorage 装载；Node 测试用 _resetForTest 重置）
  let state = {
    products: [],
    lib: [],
    log: [],
    settings: Object.assign({}, DEFAULT_SETTINGS),
    usage: { date: todayKey(), count: 0, fails: 0 },
    codeLock: new Map(),     // 同码去重锁：code -> Promise
    cloudChain: Promise.resolve(), // 全局串行队列
    lastFailSeq: 0,          // 连续失败计数
    circuitUntil: 0          // 熔断截止时间戳（当日 24:00）
  };

  // ---------------- 工具函数 ----------------
  function todayKey(d) {
    const t = d || new Date();
    return t.getFullYear() + '-' + String(t.getMonth() + 1).padStart(2, '0') + '-' + String(t.getDate()).padStart(2, '0');
  }
  function endOfTodayTs() {
    const d = new Date();
    d.setHours(23, 59, 59, 999);
    return d.getTime();
  }
  function normCode(code) {
    return String(code || '').replace(/\s+/g, '').trim();
  }
  function isValid(code) {
    return /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(code);
  }
  function nowTs() { return Date.now(); }
  function fmtTime(ts) {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', { hour12: false });
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ---------------- 存储读写 ----------------
  function loadLS(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw == null) return fallback;
      return JSON.parse(raw);
    } catch (e) { return fallback; }
  }
  function saveLS(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {}
  }
  function loadState() {
    state.products = loadLS(LS.products, []);
    state.lib = loadLS(LS.lib, []);
    state.log = loadLS(LS.log, []);
    state.settings = Object.assign({}, DEFAULT_SETTINGS, loadLS(LS.settings, {}));
    const u = loadLS(LS.usage, null);
    state.usage = (u && u.date === todayKey()) ? u : { date: todayKey(), count: 0, fails: 0 };
  }
  function persist() {
    saveLS(LS.products, state.products);
    saveLS(LS.lib, state.lib);
    saveLS(LS.log, state.log);
    saveLS(LS.settings, state.settings);
    saveLS(LS.usage, state.usage);
  }
  function logScan(entry) {
    state.log.unshift(entry);
    if (state.log.length > 300) state.log.length = 300;
  }
  function usageToday() {
    if (state.usage.date !== todayKey()) state.usage = { date: todayKey(), count: 0, fails: 0 };
    return state.usage;
  }

  // ---------------- 演示种子数据 ----------------
  const MOCK_CLOUD = [
    { code: '6901028076768', name: '康师傅红烧牛肉面', brand: '康师傅', spec: '桶装 104g', category: '方便食品', img: '' },
    { code: '6923467890123', name: '双汇王中王火腿肠', brand: '双汇', spec: '60g', category: '肉制品', img: '' },
    { code: '6902106053351', name: '乐事薯片 原味', brand: '乐事', spec: '70g', category: '休闲零食', img: '' },
    { code: '6938166920785', name: '示例商品（云市场调试条码）', brand: '示例', spec: '标准装', category: '示例', img: '' },
    { code: '6925303725941', name: '旺旺雪饼', brand: '旺旺', spec: '84g', category: '休闲零食', img: '' },
    { code: '6903258965412', name: '金龙鱼调和油', brand: '金龙鱼', spec: '5L', category: '粮油', img: '' },
    { code: '6907992100029', name: '养乐多', brand: '养乐多', spec: '100ml×5 板', category: '乳饮', img: '' },
    { code: '6901001100113', name: '青岛啤酒', brand: '青岛', spec: '500ml 罐', category: '酒水', img: '' },
    { code: '6901668000001', name: '大白兔奶糖', brand: '大白兔', spec: '227g', category: '休闲零食', img: '' },
    { code: '6907992751797', name: '伊利纯牛奶', brand: '伊利', spec: '250ml', category: '乳饮', img: '' },
    { code: '6928806000128', name: '海飞丝洗发水', brand: '海飞丝', spec: '200ml', category: '个护', img: '' },
    { code: '6902083884567', name: '东方树叶 乌龙茶', brand: '农夫山泉', spec: '500ml', category: '饮料', img: '' }
  ];
  function seedData() {
    const now = nowTs();
    state.products = [
      { code: '6901234567892', name: '可口可乐', brand: '可口可乐', spec: '330ml 罐装', category: '饮料', img: '', costPrice: 1.8, salePrice: 2.5, unit: '罐', stock: 120, syncStatus: '已同步', createdAt: now },
      { code: '6902083881234', name: '农夫山泉', brand: '农夫山泉', spec: '550ml', category: '饮料', img: '', costPrice: 1.1, salePrice: 1.8, unit: '瓶', stock: 200, syncStatus: '已同步', createdAt: now },
      { code: '6921168509256', name: '心相印抽纸', brand: '心相印', spec: '3层100抽', category: '纸品', img: '', costPrice: 3.2, salePrice: 4.5, unit: '包', stock: 60, syncStatus: '待同步', createdAt: now }
    ];
    state.lib = [
      { code: '6902083884567', name: '东方树叶 乌龙茶', brand: '农夫山泉', spec: '500ml', img: '', source: 'migrate', status: 'normal', foundAt: now, notFoundUntil: 0 },
      { code: '6903148000019', name: '海天酱油', brand: '海天', spec: '500ml', img: '', source: 'cloud', status: 'normal', foundAt: now, notFoundUntil: 0 },
      { code: '6900000000000', name: '', brand: '', spec: '', img: '', source: 'cloud', status: 'not_found', foundAt: now, notFoundUntil: now + 90 * 86400000 }
    ];
    state.log = [];
    state.usage = { date: todayKey(), count: 0, fails: 0 };
    state.lastFailSeq = 0;
    state.circuitUntil = 0;
    persist();
  }
  // 手机扫码演示用的预置码（覆盖四级命中场景）
  const DEMO_CODES = [
    { label: '① 已建档商品（本地·永不调云端）', code: '6901234567892' },
    { label: '② 条码库字典（本地·未建档）', code: '6902083884567' },
    { label: '③ 云端新码（双库未命中→查云端→回填条码库）', code: '6901028076768' },
    { label: '④ 云端查无（记查无标记 TTL 90 天）', code: '6900000000000' },
    { label: '⑤ 完全未知码（查云端→也无数据→查无）', code: '6904321000999' }
  ];

  // =====================================================================
  // 云端 Provider
  // =====================================================================
  async function mockCloud(code) {
    await new Promise(r => setTimeout(r, 200 + Math.random() * 250)); // 模拟网络延迟
    if (state.settings.failSim) throw new Error('模拟云端故障（已开启失败模拟）');
    const hit = MOCK_CLOUD.find(x => x.code === code);
    if (hit) return { found: true, data: hit };
    return { found: false, data: null };
  }
  async function aliCloud(code) {
    const s = state.settings;
    if (!s.appcode) throw new Error('未配置 APPCODE（设置→云端 Provider 选阿里云并填入 APPCODE）');
    if (!s.gateway || s.gateway.indexOf('<market-gateway>') >= 0) throw new Error('未配置真实网关地址（云市场控制台获取）');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const sep = s.gateway.indexOf('?') >= 0 ? '&' : '?';
      const resp = await fetch(s.gateway.replace(/\/+$/, '') + sep + 'Code=' + encodeURIComponent(code), {
        headers: { Authorization: 'APPCODE ' + s.appcode },
        signal: ctrl.signal
      });
      if (!resp.ok) throw new Error('HTTP ' + resp.status + '（400参数/401鉴权/404地址/429限流/5xx故障）');
      const json = await resp.json();
      // 真实接口（珠海云际 getBarcode）：HTTP 200 + status:"200"=查到；status:"400"=查无（同样消耗配额）
      if (String(json.status) === '400') return { found: false, data: null };
      if (String(json.status) !== '200') return { found: false, data: null };
      if (!json.ItemName) return { found: false, data: null };
      return { found: true, data: {
        code: json.Barcode || code,
        name: json.ItemName,
        brand: json.BrandName || '',
        spec: json.ItemSpecification || '',
        category: json.ItemClassName || '',
        img: (json.Image && json.Image[0] && json.Image[0].Imageurl) || ''
      } };
    } finally {
      clearTimeout(timer);
    }
  }
  function cloudProvider() {
    return state.settings.provider === 'ali' ? aliCloud : mockCloud;
  }

  // =====================================================================
  // 核心：resolve 三级链路（可独立测试的纯逻辑入口）
  // =====================================================================
  /**
   * 解析一个条码，走 product → barcode_lib → 云端 三级链路。
   * @param {string} code 条码字符串
   * @returns {Promise<object>} result：{source, code, ...}
   *   source: invalid|product|lib|none|cloud|quota|blocked|cloud_error
   */
  async function resolve(code) {
    code = normCode(code);
    if (!code) return { source: 'invalid', code, msg: '条码为空' };
    if (!isValid(code)) return { source: 'invalid', code, msg: '条码格式不合法（需 8/12/13/14 位数字）' };
    const now = nowTs();

    // ⓪ 后端在线：三级链路由 Go 服务执行（配额/熔断/TTL 都在服务端），页面只展示
    if (apiOnline()) {
      try {
        const r = await api.resolveForDemo(code);
        logScan({ code, time: now, source: r.source, detail: '服务端解析 —— ' + serverDetail(r) });
        await syncMirror('lib');   // 命中次数/查无标记在服务端变了，刷新字典镜像
        persist();
        return r;
      } catch (e) {
        logScan({ code, time: now, source: 'cloud_error', detail: '服务端解析失败：' + e.message });
        persist();
        return { source: 'cloud_error', code, msg: '后端解析失败：' + e.message };
      }
    }

    // ① 商品库（档案层）——命中即完整详情，永不调云端
    const p = state.products.find(x => x.code === code);
    if (p) {
      logScan({ code, time: now, source: 'product', detail: '商品库命中：' + p.name });
      persist();
      return { source: 'product', code, product: p };
    }

    // ② 本地条码库（字典层）
    const e = state.lib.find(x => x.code === code);
    if (e) {
      if (e.status === 'normal') {
        logScan({ code, time: now, source: 'lib', detail: '条码库字典命中：' + e.name });
        persist();
        return { source: 'lib', code, entry: e };
      }
      if (e.status === 'not_found' && e.notFoundUntil > now) {
        const remainDays = Math.max(1, Math.ceil((e.notFoundUntil - now) / 86400000));
        logScan({ code, time: now, source: 'none', detail: '查无标记（剩余 ' + remainDays + ' 天）' });
        persist();
        return { source: 'none', code, entry: e, remainDays, negative: true };
      }
      // 查无标记已过期 → 允许重新查云端
    }

    // ③ 云端（限频 + 去重锁 + 串行 + 配额 + 熔断）
    const u = usageToday();
    if (now < state.circuitUntil) {
      logScan({ code, time: now, source: 'blocked', detail: '云端熔断中（连续失败5次，当日禁用）' });
      persist();
      return { source: 'blocked', code, msg: '云端已熔断（当日禁用），请先手工建档' };
    }
    if (u.count >= state.settings.quota) {
      logScan({ code, time: now, source: 'quota', detail: '套餐配额已用完' });
      persist();
      return { source: 'quota', code, msg: '今日套餐配额已用完，请到设置调整或明日再试' };
    }

    // 同码并发合并：1 秒内同一码只放行一次云端调用
    if (state.codeLock.has(code)) {
      const inflight = state.codeLock.get(code);
      logScan({ code, time: now, source: 'throttled', detail: '同码并发合并：等待进行中的查询' });
      persist();
      return await inflight;
    }

    const task = (async () => {
      let result;
      const prev = state.cloudChain;
      state.cloudChain = prev.then(async () => { result = await cloudCall(code, now); });
      await state.cloudChain.catch(() => {});
      return result;
    })();
    state.codeLock.set(code, task);
    try {
      return await task;
    } finally {
      state.codeLock.delete(code);
    }
  }

  // 服务端解析结果的人类可读说明（日志/展示用）
  function serverDetail(r) {
    switch (r.source) {
      case 'product': return '商品库命中（服务端档案）';
      case 'lib': return '条码字典命中（服务端已沉淀）';
      case 'cloud': return '云端查到 → 已永久回填字典层';
      case 'none': return '云端查无 → 已记查无标记' + (r.remainDays ? '（剩余 ' + r.remainDays + ' 天）' : '');
      case 'blocked': return '云端熔断（当日不再调用）：' + (r.msg || '');
      case 'cloud_error': return '云端调用失败：' + (r.msg || '');
      default: return r.msg || '条码不合法';
    }
  }

  // 把服务端数据拉回本地做镜像（只读展示；后端始终是真源）
  async function syncMirror(what) {
    if (!apiOnline()) return;
    try {
      const jobs = [];
      if (what !== 'lib') jobs.push(api.listProducts().then(list => { state.products = list; }));
      if (what !== 'products') jobs.push(api.listLib(300).then(list => { state.lib = list; }));
      await Promise.all(jobs);
      persist();
    } catch (e) { /* 后端抖动时保留本地镜像，不打断扫码 */ }
  }

  // 实际云端调用（计数 + 重试1次 + 熔断累计）
  async function cloudCall(code, ts) {
    const u = usageToday();
    u.count += 1;                       // 每次实际调用扣一次配额
    u.fails = 0;
    const provider = cloudProvider();
    let resp = null, err = null;
    try {
      resp = await provider(code);      // 第 1 次
    } catch (e1) {
      err = e1;
      try { resp = await provider(code); } // 重试 1 次
      catch (e2) { err = e2; }
    }
    if (resp) {
      if (resp.found) {
        state.lastFailSeq = 0;
        const entry = {
          code, name: resp.data.name, brand: resp.data.brand || '', spec: resp.data.spec || '',
          img: resp.data.img || '', category: resp.data.category || '',
          source: 'cloud', status: 'normal', foundAt: ts, notFoundUntil: 0
        };
        upsertLib(entry);
        logScan({ code, time: ts, source: 'cloud', detail: '云端查到 → 已回填本地条码库：' + entry.name });
        persist();
        return { source: 'cloud', code, entry };
      }
      // 查无：记标记，不视为故障
      state.lastFailSeq = 0;
      const entry = {
        code, name: '', brand: '', spec: '', img: '', source: 'cloud', status: 'not_found',
        foundAt: ts, notFoundUntil: ts + state.settings.ttlDays * 86400000
      };
      upsertLib(entry);
      const remainDays = state.settings.ttlDays;
      logScan({ code, time: ts, source: 'none', detail: '云端查无 → 已记查无标记（TTL ' + remainDays + ' 天）' });
      persist();
      return { source: 'none', code, entry, remainDays, negative: true };
    }
    // 失败：连续 5 次熔断当日
    state.lastFailSeq += 1;
    if (state.lastFailSeq >= 5) {
      state.circuitUntil = endOfTodayTs();
      state.lastFailSeq = 0;
      logScan({ code, time: ts, source: 'blocked', detail: '连续失败 5 次，触发熔断（当日禁用云端）' });
    } else {
      logScan({ code, time: ts, source: 'cloud_error', detail: '云端调用失败（' + (err ? err.message : '未知') + '）' });
    }
    persist();
    return { source: 'cloud_error', code, msg: (err ? err.message : '云端调用失败') };
  }

  function upsertLib(entry) {
    const i = state.lib.findIndex(x => x.code === entry.code);
    if (i >= 0) state.lib[i] = entry; else state.lib.push(entry);
  }

  // ---------------- 建档 ----------------
  function createProduct(fields) {
    const now = nowTs();
    const p = {
      code: normCode(fields.code), name: fields.name, brand: fields.brand || '',
      spec: fields.spec || '', category: fields.category || '', img: fields.img || '',
      costPrice: Number(fields.costPrice) || 0, salePrice: Number(fields.salePrice) || 0,
      unit: fields.unit || '件', stock: Number(fields.stock) || 0,
      syncStatus: '待同步', createdAt: now
    };
    if (!p.code || !p.name) throw new Error('条码与名称必填');
    if (state.products.some(x => x.code === p.code)) throw new Error('该条码已在商品库，请勿重复建档');
    // 建档的同时，确保条码库有对应字典项（来源标 manual，若原先无记录）
    if (!state.lib.some(x => x.code === p.code)) {
      state.lib.push({ code: p.code, name: p.name, brand: p.brand, spec: p.spec, img: p.img, source: 'manual', status: 'normal', foundAt: now, notFoundUntil: 0 });
    } else {
      const e = state.lib.find(x => x.code === p.code);
      if (e.status === 'not_found') { e.status = 'normal'; e.name = p.name; e.brand = p.brand; e.spec = p.spec; e.notFoundUntil = 0; }
    }
    state.products.push(p);
    logScan({ code: p.code, time: now, source: 'create', detail: '建档：' + p.name });
    persist();
    return p;
  }
  function deleteProduct(code) {
    // 接了后端不许在演示页删档：删除会与牵牛花对账口径不一致
    if (apiOnline()) {
      toast('已接后端：演示用的「删除」不可用（删档会影响对账口径），请在商品库改数或下架', 'err');
      return false;
    }
    state.products = state.products.filter(x => x.code !== code);
    persist();
    return true;
  }

  // 人工确认后的建档入库（在线＝写服务端；离线＝写本地演示数据）
  async function saveProduct(fields) {
    if (apiOnline()) {
      const p = await api.createProduct(fields);
      await syncMirror('all');
      logScan({ code: p.code, time: nowTs(), source: 'create', detail: '建档（服务端）：' + p.name });
      persist();
      return p;
    }
    return createProduct(fields);
  }

  // =====================================================================
  // UI
  // =====================================================================
  const $ = sel => document.querySelector(sel);
  let lastResult = null;

  function el(tag, cls, html) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function toast(msg, type) {
    let t = $('#toast');
    if (!t) { t = el('div', 'toast'); t.id = 'toast'; document.body.appendChild(t); }
    t.textContent = msg;
    t.className = 'toast ' + (type || 'info');
    clearTimeout(t._timer);
    t._timer = setTimeout(() => { t.className = 'toast hide'; }, 2600);
  }

  const SOURCE_META = {
    product:  { text: '商品库命中', cls: 'badge-green', note: '完整档案（含价格/库存），永不调云端' },
    lib:      { text: '条码库字典命中', cls: 'badge-blue', note: '基础信息，未建档 → 可一键建档' },
    cloud:    { text: '云端查到·已回填条码库', cls: 'badge-purple', note: '候选仅供参考，建档需人工确认' },
    none:     { text: '查无', cls: 'badge-gray', note: '已记查无标记（TTL 90 天），可手工建档' },
    quota:    { text: '配额用尽', cls: 'badge-orange', note: '' },
    throttled:{ text: '并发合并', cls: 'badge-gray', note: '' },
    create:   { text: '建档', cls: 'badge-green', note: '' },
    blocked:  { text: '云端熔断', cls: 'badge-orange', note: '' },
    cloud_error: { text: '云端调用失败', cls: 'badge-orange', note: '' },
    invalid:  { text: '条码不合法', cls: 'badge-red', note: '' }
  };

  function renderResult(r) {
    const box = $('#result');
    box.innerHTML = '';
    const meta = SOURCE_META[r.source] || { text: r.source, cls: '', note: '' };
    const head = el('div', 'result-head');
    head.appendChild(el('span', 'code-lg', esc(r.code)));
    head.appendChild(el('span', 'badge ' + meta.cls, meta.text));
    if (meta.note) head.appendChild(el('div', 'note', meta.note));
    box.appendChild(head);

    if (r.source === 'product' || r.source === 'lib' || r.source === 'cloud') {
      const src = r.source === 'product' ? r.product : r.entry;
      const rows = [
        ['名称', src.name], ['品牌', src.brand || '—'], ['规格', src.spec || '—'],
        ['分类', src.category || (r.source === 'product' ? r.product.category : '—')]
      ];
      if (r.source === 'product') rows.push(['进价/售价', '¥' + r.product.costPrice + ' / ¥' + r.product.salePrice], ['库存', r.product.stock + ' ' + r.product.unit], ['同步状态', r.product.syncStatus]);
      if (r.source === 'lib') rows.push(['来源', { cloud: '云端回填', migrate: '迁移沉淀', manual: '手工建档' }[src.source] || src.source], ['建档状态', '<span class="hl">未建档</span>']);
      if (r.source === 'cloud') rows.push(['来源', '云端候选（尚未建档）'], ['数据可信度', '需人工核对']);
      const table = el('table', 'kv');
      rows.forEach(([k, v]) => { const tr = el('tr'); tr.appendChild(el('td', 'k', k)); tr.appendChild(el('td', '', v)); table.appendChild(tr); });
      box.appendChild(table);

      const actions = el('div', 'actions');
      if (r.source === 'product') {
        const tip = el('div', 'note', '扫码只读，不改库存。库存一律手动调整（到货/盘点时在商品库改数）。');
        actions.appendChild(tip);
      }
      if (r.source === 'lib' || r.source === 'cloud') {
        const src = r.source === 'cloud' ? r.entry : r.entry;
        const b = el('button', 'btn primary', '一键建档（带出基础信息）');
        b.onclick = () => openForm(src);
        actions.appendChild(b);
        const b2 = el('button', 'btn ghost', '先看说明');
        b2.onclick = () => toast('云端数据只做候选，价格/库存以自家为准', 'info');
        actions.appendChild(b2);
      }
      box.appendChild(actions);
    } else if (r.source === 'none') {
      const remain = r.remainDays != null ? r.remainDays
        : (r.entry && r.entry.notFoundUntil ? Math.ceil((r.entry.notFoundUntil - nowTs()) / 86400000) : '—');
      box.appendChild(el('div', 'note warn', '云端也无此条码数据；已记「查无」标记，' + remain + ' 天内不再重复查云端。' + (r.server ? '（服务端标记，全店共享）' : '')));
      const b = el('button', 'btn primary', '手工建档');
      b.onclick = () => openForm({ code: r.code });
      box.appendChild(el('div', 'actions')).appendChild(b);
    } else if (r.source === 'quota' || r.source === 'blocked' || r.source === 'cloud_error') {
      box.appendChild(el('div', 'note warn', r.msg || ''));
      if (r.source === 'cloud_error') {
        const b = el('button', 'btn', '改用手工建档');
        b.onclick = () => openForm({ code: r.code });
        box.appendChild(el('div', 'actions')).appendChild(b);
      }
    } else if (r.source === 'invalid') {
      box.appendChild(el('div', 'note warn', r.msg));
    }
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // 建档弹窗
  function openForm(src) {
    const modal = el('div', 'modal-mask');
    const card = el('div', 'modal');
    card.innerHTML =
      '<h3>人工确认建档 → 商品库</h3>' +
      '<div class="note">条码：<b>' + esc(src.code || '') + '</b>' + (src.source ? '（条码库来源：' + { cloud: '云端回填', migrate: '迁移沉淀', manual: '手工', product: '建档沉淀', lib: '字典' }[src.source] || src.source : '手工建档') + '）</div>' +
      '<label>名称 *<input id="f_name" value="' + esc(src.name || '') + '"></label>' +
      '<label>品牌 <input id="f_brand" value="' + esc(src.brand || '') + '"></label>' +
      '<label>规格 <input id="f_spec" value="' + esc(src.spec || '') + '"></label>' +
      '<div class="row2"><label>分类 <input id="f_category" value="' + esc(src.category || '') + '"></label>' +
      '<label>单位 <input id="f_unit" value="件"></label></div>' +
      '<div class="row2"><label>进价(元) <input id="f_cost" type="number" value="0"></label>' +
      '<label>售价(元) <input id="f_sale" type="number" value="0"></label></div>' +
      '<label>期初库存 <input id="f_stock" type="number" value="0"></label>' +
      '<div class="note warn">云端数据仅作候选：请人工核对名称/规格；价格与库存用自家值，绝不自动填云端值。库存仅手动填写/调整（扫码不改库存）。</div>' +
      '<div class="actions"><button class="btn ghost" id="f_cancel">取消</button><button class="btn primary" id="f_save">确认建档</button></div>';
    const save = async () => {
      try {
        const p = await saveProduct({
          code: src.code || '', name: $('#f_name').value.trim(), brand: $('#f_brand').value.trim(),
          spec: $('#f_spec').value.trim(), category: $('#f_category').value.trim(),
          unit: $('#f_unit').value.trim(), costPrice: $('#f_cost').value, salePrice: $('#f_sale').value,
          stock: $('#f_stock').value
        });
        modal.remove();
        toast('建档成功：' + p.name + (apiOnline() ? '（已写入服务端商品库 + 条码字典）' : '（待同步牵牛花）'), 'ok');
        lastResult = resolve(p.code);
        lastResult.then(renderResult);
        renderTables();
      } catch (e) { toast(e.message, 'err'); }
    };
    card.querySelector('#f_save').onclick = save;
    card.querySelector('#f_cancel').onclick = () => modal.remove();
    modal.appendChild(card);
    modal.onclick = e => { if (e.target === modal) modal.remove(); };
    document.body.appendChild(modal);
    $('#f_name').focus();
  }

  // 用量看板（本地模式）+ 后端模式提示
  function renderHeader() {
    const u = usageToday();
    const pct = state.settings.quota ? Math.min(100, Math.round(u.count / state.settings.quota * 100)) : 0;
    const circuit = nowTs() < state.circuitUntil;
    $('#statCount').textContent = u.count;
    $('#statQuota').textContent = state.settings.quota;
    $('#statPct').style.width = pct + '%';
    $('#statPct').textContent = pct + '%';
    $('#statProvider').textContent = state.settings.provider === 'ali' ? '阿里云市场（真实）' : 'Mock（内置样例）';
    $('#statCircuit').style.display = circuit ? 'inline-block' : 'none';

    // 后端通道状态
    const st = api ? api.status() : { online: false, detail: '未加载 bd-api.js', label: '🟡 本地演示（离线可用）' };
    const badge = $('#modeBadge');
    if (badge) {
      badge.textContent = st.online ? st.label : '🟡 本地演示（后端未连接）';
      badge.style.background = st.online ? 'rgba(34,197,94,.35)' : 'rgba(251,191,36,.28)';
      badge.title = st.detail || '';
    }
    const cs = $('#cloudStats');
    if (cs) cs.style.display = st.online ? 'none' : 'flex';   // 服务端模式下配额/熔断由服务端管
    const note = $('#apiNote');
    if (note) {
      note.innerHTML = st.online
        ? '✅ 已连接后端 <b>' + esc(st.base || '同源') + '</b>：解析链与建档都由 Go 服务执行，APPCODE 只在服务端环境变量 <code>BARCODE_APPCODE</code> 里，本页面不持有任何密钥。'
          + (st.cloudConfigured ? '' : '<br>⚠️ 服务端未配 APPCODE → 云端查码不可用（纯本地模式，字典层仍会永久沉淀）。')
          + (st.circuitOpen ? '<br>⚠️ 服务端云端查询当日已熔断（连续失败 ' + st.cloudFails + ' 次）。' : '')
        : '未连接后端：当前为<b>纯浏览器演示</b>（Mock 云端 / proxy.py 转发）。生产环境一律由服务端调用，前端不持有 APPCODE。'
          + (st.detail ? '<br>探测结果：' + esc(st.detail) : '');
    }
  }

  // 管理视图表格
  function renderTables() {
    // 商品库
    const pt = $('#tblProducts');
    pt.innerHTML = '';
    if (!state.products.length) pt.appendChild(el('tr')).appendChild(el('td', '', '暂无商品（用扫码台建档）'));
    state.products.slice().sort((a, b) => a.code.localeCompare(b.code)).forEach(p => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', esc(p.code)));
      tr.appendChild(el('td', '', esc(p.name) + ' <span class="dim">' + esc(p.spec || '') + '</span>'));
      tr.appendChild(el('td', '', '¥' + p.salePrice));
      tr.appendChild(el('td', '', p.stock + ' ' + esc(p.unit || '')));
      tr.appendChild(el('td', '', esc(p.syncStatus || '')));
      const d = el('button', 'link-btn', '删');
      d.onclick = () => { if (deleteProduct(p.code)) { renderTables(); toast('已删除：' + p.name, 'info'); } };
      tr.appendChild(el('td', '')).appendChild(d);
      pt.appendChild(tr);
    });
    // 条码库
    const lt = $('#tblLib');
    lt.innerHTML = '';
    if (!state.lib.length) lt.appendChild(el('tr')).appendChild(el('td', '', '暂无字典项（扫描云端命中的条码会自动沉淀到这里）'));
    state.lib.slice().sort((a, b) => a.code.localeCompare(b.code)).forEach(e => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono', esc(e.code)));
      tr.appendChild(el('td', '', esc(e.name || '（查无记录）')));
      tr.appendChild(el('td', '', { cloud: '云端回填', migrate: '迁移沉淀', manual: '手工建档', product: '建档沉淀', lib: '字典' }[e.source] || e.source));
      if (e.status === 'not_found') {
        const remain = e.notFoundUntil ? Math.max(1, Math.ceil((e.notFoundUntil - nowTs()) / 86400000)) : null;
        tr.appendChild(el('td', '', '<span class="badge badge-gray">查无</span>' + (remain ? ' 剩余 ' + remain + ' 天' : '')));
      } else {
        tr.appendChild(el('td', '', '<span class="badge badge-blue">normal</span>'));
      }
      lt.appendChild(tr);
    });
    // 日志
    const lg = $('#tblLog');
    lg.innerHTML = '';
    if (!state.log.length) lg.appendChild(el('tr')).appendChild(el('td', '', '暂无扫码记录'));
    state.log.slice(0, 50).forEach(l => {
      const tr = el('tr');
      tr.appendChild(el('td', 'mono dim', fmtTime(l.time)));
      tr.appendChild(el('td', 'mono', esc(l.code)));
      const meta = SOURCE_META[l.source] || { text: l.source, cls: '' };
      tr.appendChild(el('td', '', '<span class="badge ' + meta.cls + '">' + meta.text + '</span>'));
      tr.appendChild(el('td', '', esc(l.detail || '')));
      lg.appendChild(tr);
    });
  }

  function switchTab(name) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    document.querySelectorAll('.pane').forEach(p => p.style.display = (p.id === 'pane-' + name) ? '' : 'none');
  }

  function bindUI() {
    // 扫码台
    const input = $('#scanInput');
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        doScan(input.value);
      }
    });
    $('#btnScan').onclick = () => doScan(input.value);
    // 示例码 = 一键试扫（等价模拟手机扫码 wx.scanCode）
    document.querySelectorAll('.chip').forEach(b => b.onclick = () => doScan(b.dataset.code, true));
    // Tabs
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    // 设置
    $('#setProvider').value = state.settings.provider;
    $('#setProvider').onchange = e => {
      state.settings.provider = e.target.value;
      persist(); renderHeader();
      toast('云端 Provider：' + (state.settings.provider === 'ali' ? '阿里云市场' : 'Mock'), 'info');
    };
    $('#setAppcode').value = state.settings.appcode;
    $('#setAppcode').onchange = e => { state.settings.appcode = e.target.value.trim(); persist(); };
    $('#setGateway').value = state.settings.gateway;
    $('#setGateway').onchange = e => { state.settings.gateway = e.target.value.trim(); persist(); };
    $('#setQuota').value = state.settings.quota;
    $('#setQuota').onchange = e => { state.settings.quota = Math.max(1, parseInt(e.target.value, 10) || 1); persist(); renderHeader(); };
    $('#setTtl').value = state.settings.ttlDays;
    $('#setTtl').onchange = e => { state.settings.ttlDays = Math.max(1, parseInt(e.target.value, 10) || 90); persist(); };
    $('#setFailSim').checked = !!state.settings.failSim;
    $('#setFailSim').onchange = e => { state.settings.failSim = e.target.checked; persist(); toast('云端失败模拟已' + (e.target.checked ? '开启' : '关闭'), 'info'); };
    // 后端地址：留空 = 同源（页面与后端同端口时零配置）
    if ($('#setApiBase')) {
      $('#setApiBase').value = api ? api.base() : '';
      $('#setApiBase').onchange = async e => {
        if (!api) return;
        api.setBase(e.target.value.trim());
        e.target.value = api.base();
        const st = await api.detect();
        if (st.online) await syncMirror('all');
        renderAll();
        toast(st.online ? '已连接后端：' + (st.base || '同源') : '后端未连接 → 继续本地演示', st.online ? 'ok' : 'err');
      };
    }
    $('#btnReset').onclick = () => { if (confirm('重置全部演示数据？')) { seedData(); renderAll(); toast('已重置为演示初始数据', 'ok'); } };
    $('#btnExport').onclick = () => {
      const blob = new Blob([JSON.stringify({ products: state.products, lib: state.lib, log: state.log, settings: state.settings, usage: usageToday() }, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'barcode-demo-data.json'; a.click();
    };
  }

  async function doScan(raw, fromPhone) {
    const code = normCode(raw);
    const input = $('#scanInput');
    if (fromPhone) input.value = code;
    if (!code) { toast('请输入或扫描条码', 'err'); return; }
    const r = await resolve(code);
    renderResult(r);
    renderHeader();
    renderTables();
    if (!fromPhone) input.select();
  }

  function renderAll() {
    renderHeader();
    renderTables();
    switchTab('scan');
  }

  function init() {
    loadState();
    // 任一库为空就恢复演示数据：保证新环境一打开就能看到商品库与条码库内容
    if (!state.products.length || !state.lib.length) seedData();
    bindUI();
    renderAll();
    $('#scanInput').focus();
    toast('演示就绪：输入条码回车查询，或点示例码直接试扫', 'info');
    // 探测后端（只探一次，不轮询）：在线则拉到真数据并把解析链交给服务端
    (async function initApi() {
      if (!api) { renderHeader(); return; }
      const st = await api.detect();
      if (st.online) {
        await syncMirror('all');
        renderAll();
        toast('后端已连接：解析/建档走服务端（' + (st.cloudConfigured ? '云端条码已启用' : '纯本地模式，未配 APPCODE') + '）', 'ok');
      } else {
        renderHeader();
      }
    })();
  }

  // ---------------- 摄像头扫码（M1.3：手机/电脑摄像头，走同一双库解析链） ----------------
  let camStream = null, camTimer = null, camDetector_ = null;
  function camSupported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices &&
      !!navigator.mediaDevices.getUserMedia && 'BarcodeDetector' in window;
  }
  function camDetector() {
    if (!camDetector_ && 'BarcodeDetector' in window) {
      camDetector_ = new BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'] });
    }
    return camDetector_;
  }
  async function startCamera() {
    const v = $('#camVideo'), tip = $('#camTip');
    if (!v) return toast('页面缺少摄像头区域', 'error');
    if (!camSupported()) {
      const m = '当前浏览器不支持摄像头扫码（需 getUserMedia + BarcodeDetector）。请改用 Chrome/Edge 桌面或安卓端，或使用扫码枪 / 手动输入。';
      if (tip) tip.textContent = m;
      return toast(m, 'error');
    }
    if (camStream) return stopCamera();
    try {
      camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      v.srcObject = camStream; v.style.display = 'block';
      if (tip) tip.textContent = '';
      $('#btnCam').textContent = '⏹ 停止扫码';
      toast('摄像头已开启：对准条码自动识别', 'info');
      camTimer = setInterval(detectOnce, 260);
    } catch (e) {
      toast('无法打开摄像头：' + e.message + '（需允许权限，或改用扫码枪/手动输入）', 'error');
    }
  }
  async function detectOnce() {
    const v = $('#camVideo');
    if (!v || !v.videoWidth) return;
    try {
      const d = camDetector();
      if (!d) return;
      const codes = await d.detect(v);
      if (codes && codes.length) { stopCamera(); doScan(codes[0].rawValue, true); }
    } catch (e) { /* 单帧识别失败忽略，下一帧继续 */ }
  }
  function stopCamera() {
    clearInterval(camTimer); camTimer = null;
    if (camStream) { camStream.getTracks().forEach(t => t.stop()); camStream = null; }
    const v = $('#camVideo');
    if (v) { v.srcObject = null; v.style.display = 'none'; }
    const b = $('#btnCam');
    if (b) b.textContent = '📷 摄像头扫一扫';
  }

  // ---------------- 导出（浏览器 + Node 测试） ----------------
  return {
    init, resolve, createProduct, saveProduct, deleteProduct, seedData, renderAll, syncMirror,
    startCamera, stopCamera,
    _state: state,
    _test: {
      normCode, isValid, endOfTodayTs,
      setSettings(s) { state.settings = Object.assign({}, DEFAULT_SETTINGS, s); },
      reset() {
        state.products = []; state.lib = []; state.log = [];
        state.settings = Object.assign({}, DEFAULT_SETTINGS);
        state.usage = { date: todayKey(), count: 0, fails: 0 };
        state.codeLock.clear(); state.lastFailSeq = 0; state.circuitUntil = 0;
        state.cloudChain = Promise.resolve();
      }
    }
  };
})();

if (typeof window !== 'undefined') {
  window.addEventListener('DOMContentLoaded', () => DemoApp.init());
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = DemoApp;
}

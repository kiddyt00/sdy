/* =====================================================================
 * bd-api.js —— 扫码台 ↔ Go 后端通道（M4 收尾第 2 步）
 *
 * 为什么需要它：
 *   浏览器直连阿里云市场条码 API 会泄露 APPCODE，还有 CORS 限制。
 *   接上后端后，解析链（档案 → 字典 → 云端）与建档全部由 Go 服务执行，
 *   APPCODE 只存在于服务端环境变量 BARCODE_APPCODE 里，页面不持有任何密钥。
 *
 * 设计：
 *   - 后端在线 → 一切以服务端为准（解析链、建档、商品库、条码字典）；
 *   - 后端离线 → 自动退回纯浏览器演示（Mock 云端），页面照常可用；
 *   - 只依赖 fetch，可在 Node 里注入 fetchImpl 做测试。
 * ===================================================================== */
'use strict';

const BdApi = (() => {
  const LS_BASE_KEY = 'bd_api_base';
  const DEFAULTS = { timeoutMs: 2000, base: '', fetchImpl: null, now: null };

  let cfg = Object.assign({}, DEFAULTS);
  let online = false;
  let lastError = '';
  let health = null;
  let listeners = [];

  /* ------------------------------ 基础 ------------------------------ */

  function configure(opts) { cfg = Object.assign({}, cfg, opts || {}); return cfg; }
  function reset() {
    cfg = Object.assign({}, DEFAULTS);
    online = false; lastError = ''; health = null; listeners = [];
  }
  function fetchImpl() { return cfg.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null); }
  function nowMs() { return cfg.now ? cfg.now() : Date.now(); }

  function base() {
    if (cfg.base) return String(cfg.base).replace(/\/+$/, '');
    try {
      const s = localStorage.getItem(LS_BASE_KEY);
      if (s) return String(s).replace(/\/+$/, '');
    } catch (e) { /* 无 localStorage（Node/隐私模式） */ }
    if (typeof window !== 'undefined' && window.SDY_API_BASE) {
      return String(window.SDY_API_BASE).replace(/\/+$/, '');
    }
    return '';
  }
  function setBase(url) {
    const v = String(url || '').trim();
    try { v ? localStorage.setItem(LS_BASE_KEY, v) : localStorage.removeItem(LS_BASE_KEY); } catch (e) {}
  }

  /* ------------------------------ 请求 ------------------------------ */

  async function req(method, path, body) {
    const f = fetchImpl();
    if (!f) throw new Error('当前环境不支持 fetch');
    const ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), cfg.timeoutMs) : null;
    let resp;
    try {
      resp = await f(base() + path, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: ctrl ? ctrl.signal : undefined
      });
    } catch (e) {
      throw new Error('无法连接后端（' + (base() || '同源') + '）：' + ((e && e.message) || e));
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data = null;
    try { data = await resp.json(); } catch (e) { /* 无 JSON 体 */ }
    if (!resp.ok) throw new Error((data && (data.error || data.msg)) || ('HTTP ' + resp.status));
    return data;
  }

  /* ------------------------------ 探测 ------------------------------ */

  function notify() { listeners.slice().forEach(fn => { try { fn(status()); } catch (e) {} }); }
  function subscribe(fn) { if (typeof fn === 'function') listeners.push(fn); return () => { listeners = listeners.filter(x => x !== fn); }; }

  // detect() 只探测一次，不做轮询：页面启动时调用即可。
  async function detect() {
    try {
      health = await req('GET', '/healthz');
      online = true; lastError = '';
    } catch (e) {
      online = false; health = null; lastError = e.message || String(e);
    }
    notify();
    return status();
  }

  function status() {
    const cloudConfigured = !!(health && health.cloudConfigured);
    return {
      mode: online ? 'server' : 'local',
      online: online,
      base: base(),
      error: lastError,
      cloudConfigured: cloudConfigured,
      circuitOpen: !!(health && health.circuitOpen),
      cloudFails: health ? (health.cloudFails || 0) : 0,
      label: online ? '🟢 后端已连接（规则在服务端）' : '🟡 本地演示（离线可用）',
      detail: online
        ? (cloudConfigured ? '云端条码已启用：APPCODE 只在服务端环境变量里' : '后端在线 · 纯本地模式（服务端未配 BARCODE_APPCODE）')
        : (lastError ? lastError : '未探测后端')
    };
  }

  function onlineNow() { return online; }
  function healthz() { return health; }
  function mode() { return online ? 'server' : 'local'; }

  /* ------------------------------ 数据映射 ------------------------------ */

  function mapProduct(p) {
    return {
      code: p.code, name: p.name, brand: p.brand || '', spec: p.spec || '',
      category: p.category || '', img: p.img || '',
      costPrice: p.costPrice || 0, salePrice: p.salePrice || 0, refPrice: p.refPrice || 0,
      unit: p.unit || '件', stock: p.stock || 0, isWholesale: !!p.isWholesale,
      syncStatus: p.syncStatus === 'pending' ? '待同步' : '已同步',
      createdAt: p.createdAt ? Date.parse(p.createdAt) : nowMs(),
      server: true
    };
  }
  function mapLib(e) {
    return {
      code: e.code, name: e.name || '', brand: '', spec: e.spec || '', img: '',
      source: e.source || 'lib',
      status: e.status === 'not_found' ? 'not_found' : 'normal',
      hits: e.hits || 0,
      notFoundUntil: e.expiresAt ? Date.parse(e.expiresAt) : 0,
      server: true
    };
  }
  function remainDays(expiresAt) {
    if (!expiresAt) return null;
    const t = Date.parse(expiresAt);
    if (isNaN(t)) return null;
    return Math.max(1, Math.ceil((t - nowMs()) / 86400000));
  }

  /* ------------------------------ 读接口 ------------------------------ */

  async function listProducts() {
    const d = await req('GET', '/api/products');
    return (d.items || []).map(mapProduct);
  }
  async function getProduct(code) {
    const d = await req('GET', '/api/products?keyword=' + encodeURIComponent(code));
    const hit = (d.items || []).find(p => p.code === code);
    return hit ? mapProduct(hit) : null;
  }
  async function listLib(limit) {
    const d = await req('GET', '/api/barcode/lib?limit=' + (limit || 200));
    return (d.items || []).map(mapLib);
  }

  /* ------------------------------ 解析链 ------------------------------ */

  // 服务端解析结果 → 扫码台（DemoApp）的展示结构。
  async function resolveForDemo(code) {
    const r = await req('GET', '/api/barcode/resolve?code=' + encodeURIComponent(code));
    switch (r.source) {
      case 'product': {
        // 服务端解析只回名称/规格，价格与库存要另取档案（仍是后端真源）
        let p = null;
        try { p = await getProduct(code); } catch (e) {}
        return {
          source: 'product', code: r.code, server: true,
          product: p || { code: r.code, name: r.name || '', brand: '', spec: r.spec || '', category: '',
            img: '', costPrice: 0, salePrice: 0, unit: '', stock: 0, syncStatus: '已同步', server: true }
        };
      }
      case 'lib':
      case 'cloud':
        return {
          source: r.source, code: r.code, server: true,
          entry: { code: r.code, name: r.name || '', brand: '', spec: r.spec || '', img: '',
            source: 'cloud', status: 'normal', server: true }
        };
      case 'not_found':
        return { source: 'none', code: r.code, server: true, negative: true, remainDays: remainDays(r.expiresAt) };
      case 'blocked':
        return { source: 'blocked', code: r.code, server: true,
          msg: r.error || '云端已熔断（当日禁用），请先手工建档' };
      case 'cloud_error':
        return { source: 'cloud_error', code: r.code, server: true, msg: r.error || '云端调用失败' };
      default:
        return { source: 'invalid', code: r.code || code, server: true,
          msg: r.error || '条码格式不合法（需 8/12/13/14 位数字）' };
    }
  }

  /* ------------------------------ 写接口 ------------------------------ */

  // 人工确认建档 → 服务端（商品档案 + 字典层一次写入）。
  async function createProduct(f) {
    const code = String(f.code || '').trim();
    const existing = await getProduct(code);
    if (existing) throw new Error('该条码已在商品库，请勿重复建档');
    const saved = await req('POST', '/api/products', {
      code: code,
      name: f.name,
      brand: f.brand || '',
      spec: f.spec || '',
      category: f.category || '',
      img: f.img || '',
      costPrice: Number(f.costPrice) || 0,
      salePrice: Number(f.salePrice) || 0,
      refPrice: Number(f.refPrice) || 0,
      unit: f.unit || '件',
      stock: Number(f.stock) || 0,
      isWholesale: !!f.isWholesale,
      syncStatus: 'pending'
    });
    return mapProduct(saved);
  }

  return {
    configure, reset, base, setBase, detect, status, subscribe,
    online: onlineNow, mode, health: healthz,
    listProducts, getProduct, listLib, resolveForDemo, createProduct,
    _map: { mapProduct, mapLib, remainDays }
  };
})();

if (typeof window !== 'undefined') { window.BdApi = BdApi; }
if (typeof module !== 'undefined' && module.exports) { module.exports = BdApi; }

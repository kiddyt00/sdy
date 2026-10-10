/* =====================================================================
 * 牵牛花 CSV 同步 · 对账引擎（M3 规则与数据层）
 * 纯逻辑模块，Node 可测、浏览器可载；字段映射可配（待行动项 0 确认后调整）。
 *
 * 冲突处理原则（对应《开发计划》M3）：
 *   - 库存类字段：以**本地实盘**为准 → 生成「库存回填」CSV 给牵牛花
 *   - 单据类字段：以**牵牛花**为准（不在本工具范围）
 *   - 差异一律进「待确认清单」，人工确认后才回填
 * ===================================================================== */
'use strict';

const SyncCSV = (() => {

  // 默认表头映射：某标准字段可命中多种候选表头（大小写/中英文都兼容）
  const DEFAULT_FIELD_MAP = {
    code:  ['条码', '商品条码', '条形码', 'barcode', 'code', '编码', '商品编码'],
    name:  ['名称', '商品名称', '品名', 'name', '商品'],
    stock: ['库存', '库存数量', '数量', 'stock', 'qty', '结存', '库存数'],
    price: ['零售价', '售价', '销售价', '零售价格', 'price', '单价']
  };

  function num(v) {
    if (v == null) return null;
    const s = String(v).replace(/[¥￥,\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    return isNaN(n) ? null : n;
  }

  /* ---------- CSV 解析（BOM / CRLF / 引号 / 制表符自动识别） ---------- */
  function parseCsv(text, opts) {
    const o = opts || {};
    let t = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    t = t.replace(/\n+$/, '');
    if (!t.trim()) return { headers: [], rows: [] };

    const firstLine = t.split('\n')[0];
    const delim = o.delim || (firstLine.split('\t').length > firstLine.split(',').length ? '\t' : ',');

    const raw = [];
    let row = [], cell = '', inQ = false;
    for (let i = 0; i < t.length; i++) {
      const ch = t[i];
      if (inQ) {
        if (ch === '"') {
          if (t[i + 1] === '"') { cell += '"'; i++; } else { inQ = false; }
        } else { cell += ch; }
      } else if (ch === '"' && cell === '') {
        inQ = true;
      } else if (ch === delim) {
        row.push(cell); cell = '';
      } else if (ch === '\n') {
        row.push(cell); raw.push(row); row = []; cell = '';
      } else {
        cell += ch;
      }
    }
    if (cell !== '' || row.length) { row.push(cell); raw.push(row); }

    const headers = (raw.shift() || []).map(h => String(h).trim());
    const rows = raw
      .filter(r => r.some(c => String(c).trim() !== ''))
      .map(r => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = r[i] == null ? '' : String(r[i]).trim(); });
        return obj;
      });
    return { headers: headers, rows: rows };
  }

  /* ---------- CSV 生成 ---------- */
  function escCell(v) {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function toCsv(headers, rows) {
    const head = headers.map(escCell).join(',');
    const body = (rows || []).map(r => headers.map(h => escCell(Array.isArray(r) ? r[headers.indexOf(h)] : r[h])).join(','));
    return [head].concat(body).join('\n');
  }

  /* ---------- 行 → 标准字段 ---------- */
  function pick(rowObj, keys) {
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      for (const h in rowObj) {
        if (h.toLowerCase() === String(k).toLowerCase() && String(rowObj[h]).trim() !== '') return rowObj[h];
      }
    }
    return '';
  }
  function mapRow(rowObj, fieldMap) {
    const fm = Object.assign({}, DEFAULT_FIELD_MAP, fieldMap || {});
    return {
      code: String(pick(rowObj, fm.code)).trim(),
      name: String(pick(rowObj, fm.name)).trim(),
      stock: num(pick(rowObj, fm.stock)),
      price: num(pick(rowObj, fm.price))
    };
  }

  /* ---------- 对账 ---------- */
  function reconcile(cloudRows, localProducts, opts) {
    const o = opts || {};
    const cloud = (cloudRows || []).map(r => mapRow(r, o.fieldMap));
    const local = (localProducts || []).map(p => ({
      code: String(p.code || '').trim(), name: String(p.name || '').trim(),
      stock: num(p.stock), price: num(p.salePrice), unit: p.unit || ''
    }));

    const localMap = {};
    local.forEach(p => { if (p.code) localMap[p.code] = p; });
    const cloudMap = {};
    let invalid = 0;
    cloud.forEach(r => { if (!r.code) { invalid++; return; } cloudMap[r.code] = r; });

    const diffs = [], cloudOnly = [], localOnly = [];
    let ok = 0, stockDiffCnt = 0, priceDiffCnt = 0, bothCnt = 0;

    local.forEach(p => {
      if (!p.code) return;
      const c = cloudMap[p.code];
      if (!c) { localOnly.push({ code: p.code, name: p.name, stock: p.stock, price: p.price, unit: p.unit }); return; }
      const sd = (c.stock == null || p.stock == null) ? null : (c.stock - p.stock);
      const pd = (c.price == null || p.price == null) ? null : Math.round((c.price - p.price) * 100) / 100;
      const stockChanged = sd != null && sd !== 0;
      const priceChanged = pd != null && pd !== 0;
      if (!stockChanged && !priceChanged) { ok++; return; }
      const verdict = stockChanged && priceChanged ? 'both' : (stockChanged ? 'stock' : 'price');
      if (verdict === 'both') bothCnt++; else if (verdict === 'stock') stockDiffCnt++; else priceDiffCnt++;
      diffs.push({
        code: p.code, name: p.name || c.name, unit: p.unit,
        cloudStock: c.stock, localStock: p.stock, stockDiff: sd,
        cloudPrice: c.price, localPrice: p.price, priceDiff: pd,
        verdict: verdict, confirmed: false
      });
    });

    Object.keys(cloudMap).forEach(code => {
      if (!localMap[code]) {
        const c = cloudMap[code];
        cloudOnly.push({ code: code, name: c.name, stock: c.stock, price: c.price });
      }
    });

    return {
      diffs: diffs.sort((a, b) => a.code.localeCompare(b.code)),
      cloudOnly: cloudOnly, localOnly: localOnly,
      stats: {
        cloudTotal: Object.keys(cloudMap).length, localTotal: local.length,
        matched: Object.keys(cloudMap).filter(c => localMap[c]).length,
        ok: ok, stockDiff: stockDiffCnt, priceDiff: priceDiffCnt, both: bothCnt,
        cloudOnly: cloudOnly.length, localOnly: localOnly.length, invalid: invalid
      }
    };
  }

  /* ---------- 回填 / 上传 CSV ---------- */
  // 库存以本地实盘为准：把本地库存回填给牵牛花（仅库存有差异的行）
  function buildBackfill(diffs) {
    return (diffs || [])
      .filter(d => d.stockDiff != null && d.stockDiff !== 0)
      .map(d => ({ 条码: d.code, 名称: d.name, 实盘库存: d.localStock, 云端库存: d.cloudStock, 差异: d.stockDiff }));
  }
  // 本地有、云端无：本地新增，待上传建档
  function buildUpload(localOnly) {
    return (localOnly || []).map(p => ({ 条码: p.code, 名称: p.name, 库存: p.stock, 售价: p.price, 单位: p.unit || '' }));
  }

  return {
    DEFAULT_FIELD_MAP: DEFAULT_FIELD_MAP,
    parseCsv: parseCsv, toCsv: toCsv, mapRow: mapRow,
    reconcile: reconcile, buildBackfill: buildBackfill, buildUpload: buildUpload
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = SyncCSV;

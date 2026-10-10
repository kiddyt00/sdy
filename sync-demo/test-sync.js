/* =====================================================================
 * 牵牛花 CSV 对账引擎测试（M3）
 * 运行：node test-sync.js
 * ===================================================================== */
'use strict';
const S = require('./sync-csv.js');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ✔ ' + msg); } else { failed++; console.log('  ✘ ' + msg); } }
function eq(a, b, msg) { ok(a === b, msg + '（实际 ' + JSON.stringify(a) + '）'); }
function section(t) { console.log('\n■ ' + t); }

/* ============ ① CSV 解析 ============ */
section('① CSV 解析（引号 / 换行 / BOM / 分隔符）');
{
  const r = S.parseCsv('条码,名称,库存\n6901,可乐,120\n6902,农夫,200');
  eq(r.headers.length, 3, '表头 3 列');
  eq(r.rows.length, 2, '数据 2 行');
  eq(r.rows[0].名称, '可乐', '首行字段取值');
}
{
  const r = S.parseCsv('条码,名称\n6901,"可乐, 330ml 罐装"');
  eq(r.rows[0].名称, '可乐, 330ml 罐装', '引号内逗号不切分');
}
{
  const r = S.parseCsv('条码,名称\n6901,"他说""你好"""');
  eq(r.rows[0].名称, '他说"你好"', '双引号转义');
}
{
  const r = S.parseCsv('条码,名称\r\n6901,可乐\r\n');
  eq(r.rows[0].名称, '可乐', 'CRLF 换行');
  eq(r.rows.length, 1, '结尾换行不产生空行');
}
{
  const r = S.parseCsv('\uFEFF条码,名称\n6901,可乐');
  eq(r.headers[0], '条码', 'BOM 已剥离');
}
{
  const r = S.parseCsv('条码\t名称\t库存\n6901\t可乐\t120');
  eq(r.headers.length, 3, '制表符分隔自动识别');
  eq(r.rows[0].库存, '120', '制表符解析取值');
}
{
  const r = S.parseCsv('');
  eq(r.headers.length, 0, '空文本 → 无表头');
  eq(r.rows.length, 0, '空文本 → 无数据');
}
{
  const r = S.parseCsv(' 条码 , 名称 \n6901,可乐\n\n6902,农夫');
  eq(r.headers[0], '条码', '表头首尾空格已 trim');
  eq(r.rows.length, 2, '中间空行被跳过');
}
{
  const r = S.parseCsv('条码,名称,库存\n6901,可乐');
  eq(r.rows[0].库存, '', '缺列补空字符串');
}

/* ============ ② 行 → 标准字段映射 ============ */
section('② 字段映射（可配，兼容中英文表头）');
{
  const m = S.mapRow({ 条码: ' 6901 ', 名称: '可乐', 库存: '120', 零售价: '2.5' });
  eq(m.code, '6901', '中文表头：条码 trim');
  eq(m.name, '可乐', '中文表头：名称');
  eq(m.stock, 120, '中文表头：库存 → number');
  eq(m.price, 2.5, '中文表头：零售价 → number');
}
{
  const m = S.mapRow({ barcode: '6902', name: '农夫', stock: '200', price: '1.8' });
  eq(m.code, '6902', '英文表头 barcode');
  eq(m.stock, 200, '英文表头 stock');
}
{
  const m = S.mapRow({ 编码: '6903', 品名: '抽纸', 结存: '60', 单价: '4.5' });
  eq(m.code, '6903', '别名表头 编码/品名/结存/单价');
  eq(m.price, 4.5, '别名表头 单价 → price');
}
{
  const m = S.mapRow({ SKU: '6904', 商品: '雪饼', 库存: '40', 售价: '4.5' }, { code: ['SKU'], name: ['商品'] });
  eq(m.code, '6904', '自定义 fieldMap 覆盖');
}
{
  const m = S.mapRow({ 条码: '6905', 名称: '啤酒', 库存: '¥1,234.50', 零售价: '' });
  eq(m.stock, 1234.5, '货币符号与千分位解析');
  eq(m.price, null, '空价格 → null');
}

/* ============ ③ 对账 ============ */
section('③ 对账（库存/价格差异、云端独有、本地独有）');
const CLOUD = [
  { 条码: '6901', 名称: '可乐', 库存: '120', 零售价: '2.5' },   // 一致
  { 条码: '6902', 名称: '农夫', 库存: '190', 零售价: '1.8' },   // 库存差 -10
  { 条码: '6903', 名称: '抽纸', 库存: '60', 零售价: '5.0' },    // 价格差 +0.5
  { 条码: '6904', 名称: '雪饼', 库存: '38', 零售价: '5.0' },    // 双差
  { 条码: '6999', 名称: '云端新品尝鲜', 库存: '10', 零售价: '9.9' } // 云端独有
];
const LOCAL = [
  { code: '6901', name: '可乐', stock: 120, salePrice: 2.5, unit: '罐' },
  { code: '6902', name: '农夫', stock: 200, salePrice: 1.8, unit: '瓶' },
  { code: '6903', name: '抽纸', stock: 60, salePrice: 4.5, unit: '包' },
  { code: '6904', name: '雪饼', stock: 40, salePrice: 4.5, unit: '袋' },
  { code: '6905', name: '本地新增品', stock: 15, salePrice: 3.0, unit: '个' }   // 本地独有
];
const R = S.reconcile(CLOUD, LOCAL);
{
  eq(R.stats.cloudTotal, 5, '云端 5 个条码');
  eq(R.stats.localTotal, 5, '本地 5 个条码');
  eq(R.stats.matched, 4, '命中 4 个');
  eq(R.stats.ok, 1, '一致 1 个（可乐）');
  eq(R.stats.stockDiff, 1, '仅库存差 1 个');
  eq(R.stats.priceDiff, 1, '仅价格差 1 个');
  eq(R.stats.both, 1, '双差 1 个');
  eq(R.stats.cloudOnly, 1, '云端独有 1 个');
  eq(R.stats.localOnly, 1, '本地独有 1 个');
}
{
  const d = R.diffs.find(x => x.code === '6902');
  eq(d.verdict, 'stock', '6902 判定为库存差');
  eq(d.stockDiff, -10, '6902 云端比本地少 10 → stockDiff=-10');
  eq(d.localStock, 200, '带回本地实盘库存');
}
{
  const d = R.diffs.find(x => x.code === '6903');
  eq(d.verdict, 'price', '6903 判定为价格差');
  eq(d.priceDiff, 0.5, '6903 价差 +0.5');
}
{
  const d = R.diffs.find(x => x.code === '6904');
  eq(d.verdict, 'both', '6904 判定为双差');
  eq(d.stockDiff, -2, '6904 库存差 -2');
  eq(d.priceDiff, 0.5, '6904 价差 +0.5');
}
{
  ok(R.diffs.every((d, i, a) => i === 0 || a[i - 1].code.localeCompare(d.code) <= 0), '差异清单按条码排序');
  ok(R.diffs.every(d => d.confirmed === false), '差异默认未确认（待人工确认）');
  eq(R.cloudOnly[0].code, '6999', '云端独有清单');
  eq(R.localOnly[0].code, '6905', '本地独有清单');
}
{
  const r2 = S.reconcile([{ 条码: '', 名称: '无码品', 库存: '1' }, { 条码: '6901', 名称: '可乐', 库存: '120' }], [{ code: '6901', name: '可乐', stock: 120, salePrice: null }]);
  eq(r2.stats.invalid, 1, '无条码行计入 invalid 并跳过');
  eq(r2.stats.matched, 1, '无条码行不参与对账');
  eq(r2.diffs.length, 0, '本地无价（salePrice=null）不算价格差');
}
{
  const r3 = S.reconcile([{ 条码: '6901', 名称: '可乐', 库存: '' }], [{ code: '6901', name: '可乐', stock: 5, salePrice: 2.5 }]);
  eq(r3.diffs.length, 0, '云端库存缺失 → 不误报差异');
}

/* ============ ④ 回填 / 上传 / CSV 生成 ============ */
section('④ 回填 CSV（库存以本地实盘为准）与上传 CSV');
{
  const back = S.buildBackfill(R.diffs);
  eq(back.length, 2, '仅库存有差异的 2 行进入回填（6902/6904）');
  eq(back[0].实盘库存, 200, '回填用本地实盘库存（不用云端）');
  eq(back[1].实盘库存, 40, '双差行也回填本地库存');
  ok(!back.some(r => r.条码 === '6903'), '纯价格差行不进入库存回填');
}
{
  const up = S.buildUpload(R.localOnly);
  eq(up.length, 1, '本地新增 1 行待上传');
  eq(up[0].条码, '6905', '上传行含条码');
  eq(up[0].单位, '个', '上传行含单位');
}
{
  const csv = S.toCsv(['条码', '名称', '实盘库存'], S.buildBackfill(R.diffs));
  const back = S.parseCsv(csv);
  eq(back.rows.length, 2, 'toCsv → parseCsv 往返行数一致');
  eq(back.rows[0].实盘库存, '200', '往返后值正确');
}
{
  const csv = S.toCsv(['条码', '名称'], [{ 条码: '6901', 名称: '可乐, 大瓶' }]);
  ok(csv.indexOf('"可乐, 大瓶"') >= 0, '含逗号字段自动加引号');
  eq(S.parseCsv(csv).rows[0].名称, '可乐, 大瓶', '引号字段往返无损');
}

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

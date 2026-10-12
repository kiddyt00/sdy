/* =====================================================================
 * 价格规则服务测试（M2）—— 配送费规则 + 牵牛花比价防线
 * 运行：node test-pricing.js
 * ===================================================================== */
'use strict';
const Pricing = require('./pricing.js');

let passed = 0, failed = 0;
function ok(cond, msg) { if (cond) { passed++; console.log('  ✔ ' + msg); } else { failed++; console.log('  ✘ ' + msg); } }
function throws(fn, msg) { try { fn(); ok(false, msg + '（应抛错却成功）'); } catch (e) { ok(true, msg + '（' + e.message + '）'); } }
function section(t) { console.log('\n■ ' + t); }

// ============ ① 配送费（默认配置） ============
section('① 配送费（默认：自提 0 / 满 30 免 / 否则 3）');
ok(Pricing.deliveryFee('pickup', 0) === 0, '自提 0 元免配送费');
ok(Pricing.deliveryFee('pickup', 199.99) === 0, '自提 199.99 免配送费');
ok(Pricing.deliveryFee('delivery', 29.99) === 3, '配送 29.99 → 3 元');
ok(Pricing.deliveryFee('delivery', 30) === 0, '配送 30 → 免');
ok(Pricing.deliveryFee('delivery', 55.5) === 0, '配送 55.5 → 免');
throws(() => Pricing.deliveryFee('xxx', 10), '未知配送方式抛错');

// ============ ② 配送费（自定义配置） ============
section('② 配送费（可配：满 50 免 / 5 元 / 自提 2 元）');
const cfg = { minFree: 50, deliveryFee: 5, pickupFee: 2 };
ok(Pricing.deliveryFee('delivery', 49.99, cfg) === 5, '配送 49.99 → 5 元');
ok(Pricing.deliveryFee('delivery', 50, cfg) === 0, '配送 50 → 免');
ok(Pricing.deliveryFee('delivery', 88, cfg) === 0, '配送 88 → 免');
ok(Pricing.deliveryFee('pickup', 1, cfg) === 2, '自提按配置收 2 元');
ok(Pricing.deliveryFee('delivery', 30, {}) === 0, '部分覆盖：只传 minFree 沿用默认 30 → 30 免');

// ============ ③ 比价防线：单商品 ============
section('③ 比价防线（零售 ≤ 牵牛花 -5%，批发不计）');
ok(Pricing.checkRetailPrice({ salePrice: 5, refPrice: 5.2 }).ok === false, '售价 5 > 4.94（5.2×0.95）→ 超价');
ok(Pricing.checkRetailPrice({ salePrice: 4.94, refPrice: 5.2 }).ok === true, '售价 4.94 = 防线边界 → 合规');
ok(Pricing.checkRetailPrice({ salePrice: 4.0, refPrice: 5.2 }).ok === true, '售价 4.0 < 4.94 → 合规');
ok(Pricing.checkRetailPrice({ salePrice: 9, refPrice: 10 }).ok === true, '售价 9 ≤ 9.5 → 合规');
{
  const r = Pricing.checkRetailPrice({ salePrice: 5, refPrice: 5.2 });
  ok(r.cap === 4.94, '超价时给出防线 cap=4.94');
  ok(Math.abs(r.diffPct - (-3.8)) < 1e-6, 'diffPct=-3.8%（相对参考价）');
}
ok(Pricing.checkRetailPrice({ salePrice: 5 }).ok === true && Pricing.checkRetailPrice({ salePrice: 5 }).skip === 'no_ref', '无参考价 → 跳过（no_ref）');
ok(Pricing.checkRetailPrice({ salePrice: 5, refPrice: 0 }).skip === 'no_ref', '参考价 0 → 跳过');
ok(Pricing.checkRetailPrice({ salePrice: 6.66, refPrice: 7, isWholesale: true }).ok === true, '批发（isWholesale）不计入防线');
ok(Pricing.checkRetailPrice({ salePrice: 6.66, refPrice: 7, priceMode: 'wholesale' }).skip === 'wholesale', '批发（priceMode=wholesale）跳过');

// ============ ④ 比价防线：边界舍入与自定义比例 ============
section('④ 比价防线：舍入与自定义比例');
{
  const r = Pricing.checkRetailPrice({ salePrice: 6.33, refPrice: 6.66 }); // cap=6.33(6.66×0.95=6.327)
  ok(r.ok === true, '6.66×0.95 舍入 cap=6.33，售价 6.33 合规');
}
{
  const r = Pricing.checkRetailPrice({ salePrice: 6.34, refPrice: 6.66 });
  ok(r.ok === false && r.cap === 6.33, '售价 6.34 > 6.33 → 超价');
}
{
  const r = Pricing.checkRetailPrice({ salePrice: 9.01, refPrice: 10 }, { maxRetailRatio: 0.9 });
  ok(r.ok === false && r.cap === 9, '自定义防线 -10%：cap=9，9.01 超价');
}
ok(Pricing.checkRetailPrice({ salePrice: 9, refPrice: 10 }, { maxRetailRatio: 0.9 }).ok === true, '自定义防线 -10%：9 合规');

// ============ ⑤ 全量扫描 ============
section('⑤ pricingCheck 全量扫描');
{
  const r = Pricing.pricingCheck([
    { code: 'A', name: '可乐', salePrice: 2.5, refPrice: 2.4 },   // 超价
    { code: 'B', name: '农夫', salePrice: 1.8, refPrice: 2.0 },   // 合规
    { code: 'C', name: '批发品', salePrice: 10, refPrice: 6, isWholesale: true } // 批发跳过
  ]);
  ok(r.total === 3 && r.violations.length === 1, '3 商品 1 违规');
  ok(r.violations[0].code === 'A' && r.violations[0].name === '可乐', '违规清单含 code/name');
}
ok(Pricing.pricingCheck([]).total === 0 && Pricing.pricingCheck([]).violations.length === 0, '空列表 total=0 violations=0');

// ============ ⑥ 顾客等级与有效价（任务池⑦ / D24） ============
// 与 Go 侧 internal/pricing 的 TestEffectivePrice 用同一组用例，保证双端口径一致。
section('⑥ 顾客等级与有效价（非零售且批发价>0 → 批发价，一律 round2）');
ok(Pricing.effectivePrice('retail', 60, 52) === 60, '零售等级 → 零售价 60');
ok(Pricing.effectivePrice('', 60, 52) === 60, '缺等级（空串）视为零售 → 60');
ok(Pricing.effectivePrice('wholesale', 60, 52) === 52, '批发等级 + 有批发价 → 52');
ok(Pricing.effectivePrice('vip', 60, 52) === 52, '白名单同批发口径 → 52');
ok(Pricing.effectivePrice('wholesale', 60, 0) === 60, '批发价 0（未设）→ 回落到零售价 60');
ok(Pricing.effectivePrice('wholesale', 60.005, 0) === 60.01, '零售价一律 round2 → 60.01');
ok(Pricing.effectivePrice('wholesale', 60, 52.005) === 52.01, '批发价一律 round2 → 52.01');
ok(Pricing.normalizeTier('') === 'retail' && Pricing.normalizeTier('vip') === 'vip', 'normalizeTier：空串归一成零售');
ok(Pricing.validTier('') && Pricing.validTier('retail') && Pricing.validTier('wholesale') && Pricing.validTier('vip'), '已知等级都合法（含空串）');
ok(!Pricing.validTier('gold'), '未知等级 gold 不合法');
ok(Pricing.isWholesaleTier('wholesale') && Pricing.isWholesaleTier('vip') && !Pricing.isWholesaleTier('retail'), 'isWholesaleTier 判定正确');
ok(Pricing.tierLabel('wholesale') === '批发' && Pricing.tierLabel('') === '零售' && Pricing.tierLabel('vip') === '白名单', 'tierLabel 文案：零售 / 批发 / 白名单');
// 批发价不参与零售比价防线：批发等级取到的批发价低于零售价，天然合规；但零售价本身仍要过防线
ok(Pricing.checkRetailPrice({ salePrice: 60, refPrice: 60 }).ok === false, '零售价 60 > 防线 57（60×0.95）→ 仍拦');
ok(Pricing.effectivePrice('wholesale', 60, 52) < 57, '批发价 52 在防线之内（批发客户不受零售防线限制）');

console.log('\n========================================');
console.log('通过 ' + passed + ' 项 / 失败 ' + failed + ' 项');
process.exit(failed ? 1 : 0);

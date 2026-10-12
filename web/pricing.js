/* =====================================================================
 * 价格规则服务（M2 规则与数据层）—— 纯逻辑模块，Node 可测、浏览器可载
 * 对应《开发计划》M2「价格规则」：
 *   - 配送费：自提免配送费；配送满 minFree 免、否则 deliveryFee（占位可配）
 *   - 比价防线：零售定价 ≤ 牵牛花参考价 × (1 - 5%)，防平台比价处罚；
 *     批发价不计入（excludeWholesale）
 * 说明：规则为纯函数 + 默认配置；后续 M4 后端化时可直接复用同一份逻辑。
 * ===================================================================== */
'use strict';

const Pricing = (() => {

  const DEFAULT_CONFIG = {
    pickupFee: 0,          // 自提配送费（占位 0）
    minFree: 30,           // 配送满免门槛（占位 30 元）
    deliveryFee: 3,        // 配送费（占位 3 元）
    maxRetailRatio: 0.95,  // 零售价 ≤ 牵牛花参考价 × 0.95（即 -5%，防比价处罚）
    excludeWholesale: true // 批发价不计入比价防线
  };

  // 配送费：type=pickup|delivery；cfg 可覆盖任意项
  function deliveryFee(type, subtotal, cfg) {
    const c = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    const s = Math.round((subtotal || 0) * 100) / 100;
    if (type === 'pickup') return c.pickupFee;
    if (type === 'delivery') return s >= c.minFree ? 0 : c.deliveryFee;
    throw new Error('未知配送方式');
  }

  // 比价防线检查：product = {salePrice, refPrice?, isWholesale?, priceMode?}
  // 返回 {ok:true} 或 {ok:false, code:'over_ref', cap, sale, refPrice, diffPct, msg}
  function checkRetailPrice(product, cfg) {
    const c = Object.assign({}, DEFAULT_CONFIG, cfg || {});
    const p = product || {};
    if (c.excludeWholesale && (p.isWholesale || p.priceMode === 'wholesale')) {
      return { ok: true, skip: 'wholesale' };
    }
    if (p.refPrice == null || p.refPrice <= 0) return { ok: true, skip: 'no_ref' };
    const cap = Math.round(p.refPrice * c.maxRetailRatio * 100) / 100;
    const sale = +(p.salePrice || 0);
    if (sale > cap) {
      const diffPct = Math.round(((sale - p.refPrice) / p.refPrice) * 1000) / 10;
      return {
        ok: false, code: 'over_ref', cap: cap, sale: sale, refPrice: p.refPrice, diffPct: diffPct,
        msg: '售价 ' + sale + ' 超过比价防线 ' + cap + '（牵牛花参考价 ' + p.refPrice + ' 的 -' +
             (100 - c.maxRetailRatio * 100) + '% 内），存在平台比价处罚风险'
      };
    }
    return { ok: true };
  }

  // 全量扫描：返回 {total, violations:[{code,name,salePrice,refPrice,result}]}
  function pricingCheck(products, cfg) {
    const list = (products || []).map(p => ({ product: p, result: checkRetailPrice(p, cfg) }));
    const violations = list.filter(x => !x.result.ok).map(x => ({
      code: x.product.code, name: x.product.name,
      salePrice: x.product.salePrice, refPrice: x.product.refPrice, result: x.result
    }));
    return { total: list.length, violations: violations };
  }

  // ---------------- 顾客等级与批发价（任务池⑦ / D24） ----------------
  // 与服务端 server/internal/pricing/pricing.go 同一口径：
  //   等级 retail(默认) / wholesale(批发) / vip(白名单，同批发价)；手机号即身份，无账号体系。
  //   有效价：非零售等级且批发价 > 0 → 批发价，否则零售价；一律 round2（与订单入库同口径）。
  const TIER_RETAIL = 'retail';
  const TIER_WHOLESALE = 'wholesale';
  const TIER_VIP = 'vip';
  const TIER_LABELS = { retail: '零售', wholesale: '批发', vip: '白名单' };

  function round2(n) { return Math.round((+(n) || 0) * 100) / 100; }

  // 空串合法（老数据 / 老前端不带字段＝零售）；未知等级不合法，由服务端拒绝
  function validTier(tier) {
    if (tier == null || tier === '') return true;
    return tier === TIER_RETAIL || tier === TIER_WHOLESALE || tier === TIER_VIP;
  }
  function normalizeTier(tier) {
    return (tier === TIER_WHOLESALE || tier === TIER_VIP) ? tier : TIER_RETAIL;
  }
  function isWholesaleTier(tier) {
    return tier === TIER_WHOLESALE || tier === TIER_VIP;
  }
  function tierLabel(tier) { return TIER_LABELS[normalizeTier(tier)] || '零售'; }

  // 有效价：页面展示 / 本地降级下单都用它，口径与服务端一致
  function effectivePrice(tier, salePrice, wholesalePrice) {
    if (isWholesaleTier(tier) && +(wholesalePrice || 0) > 0) return round2(wholesalePrice);
    return round2(salePrice);
  }

  return {
    DEFAULT_CONFIG, deliveryFee, checkRetailPrice, pricingCheck,
    TIER_RETAIL, TIER_WHOLESALE, TIER_VIP,
    round2, validTier, normalizeTier, isWholesaleTier, tierLabel, effectivePrice
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Pricing;

// 商品详情（第 24 轮新增）：大图 + 价格 + 库存 + 数量 + 底部动作条
// 价格由服务端按顾客等级算好（D24），页面只读；缺货先拦，不放进购物车。
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')
const ui = require('../common/ui.js')

Page({
  data: {
    code: '',
    p: null,
    loading: true,
    err: '',
    notFound: '',
    qty: 1,
    cartCount: 0,
    // 第 27 轮 P0-9：低库存阈值由服务端 settings 下发（api.lowStock 兜底 5）
    lowStock: api.lowStock(),
    tierText: '',
    tierHint: '',
    shop: {}
  },

  onLoad(q) {
    const code = String((q && q.code) || '').trim()
    this.setData({ code: code, shop: api.cachedSettings() || {}, lowStock: api.lowStock() })
    // 第 27 轮 P0-2：别处加购 / 购物车加减也要让本页计数跟着变
    this._unsub = store.subscribe(() => this.syncCart())
    return this.load()
  },

  onUnload() {
    if (this._unsub) this._unsub()
  },

  onShow() {
    this.syncCart()
  },

  syncCart() {
    this.setData({ cartCount: store.cartCount() })
  },

  load() {
    if (!this.data.code) {
      this.setData({ loading: false, err: '', notFound: '没有带上商品条码' })
      return Promise.resolve(null)
    }
    this.setData({ loading: true, err: '', notFound: '', lowStock: api.lowStock() })
    return api.getProduct(this.data.code).then((p) => {
      if (!p) {
        // 请求成功但查不到 —— 这才是「已下架 / 不存在」
        this.setData({ loading: false, p: null, notFound: '这个商品不在了，可能已经下架' })
        return null
      }
      const tier = p.tier || ''
      this.setData({
        p: p,
        loading: false,
        qty: p.stock > 0 ? this.data.qty || 1 : 0,
        tierText: rules.tierLabel(tier),
        // 只有批发/白名单等级才提「批发价」，零售顾客不该看到这句话
        tierHint: rules.isWholesaleTier(tier) ? '按「' + rules.tierLabel(tier) + '」价' : ''
      })
      wx.setNavigationBarTitle({ title: p.name || '商品详情' })
      return p
    }, (e) => {
      // 第 27 轮 P0-2：请求失败用人话文案 + 给「重新加载」，不冒充「已下架」
      this.setData({ loading: false, p: null, notFound: '', err: ui.errText(e) })
      return null
    })
  },

  // 错误卡上的「重新加载」：真正重新发请求
  reload() {
    return this.load()
  },

  onStep(e) {
    this.setData({ qty: Number(e.detail) || 1 })
  },

  previewImg() {
    const p = this.data.p
    if (!p || !p.img) return
    wx.previewImage({ urls: [p.img], current: p.img })
  },

  addCart() {
    const p = this.data.p
    if (!p) return
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return
    }
    if (this.data.qty > p.stock) {
      wx.showToast({ title: '只剩 ' + p.stock + p.unit + '了', icon: 'none' })
      return
    }
    // 第 27 轮 P0-6：数量上限 = 该商品库存，购物车里已经有的也算进去
    const have = store.cartStock(p.code)
    if (have + this.data.qty > p.stock) {
      wx.showToast({
        title: '最多只能买 ' + p.stock + (p.unit || '件') + '，车里已经有 ' + have + (p.unit || '件'),
        icon: 'none'
      })
      return
    }
    store.addToCart(p, this.data.qty)
    this.syncCart()
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  // 立即购买：先二次确认（第 27 轮 P0-4），确认了才放进 storage 再跳购物车 tab
  // （tab 页不能 navigateTo）。确认框用 success 回调直接做，避免误触就生成订单。
  buyNow() {
    const p = this.data.p
    if (!p) return null
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return null
    }
    if (this.data.qty > p.stock) {
      wx.showToast({ title: '只剩 ' + p.stock + p.unit + '了', icon: 'none' })
      return null
    }
    const qty = this.data.qty
    wx.showModal({
      title: '马上下单？',
      content: (p.name || '这件商品') + ' × ' + qty + (p.unit || '件') + '，立即去结算。',
      confirmText: '去结算',
      cancelText: '再想想',
      success: (r) => {
        if (r && r.confirm) this.doBuyNow(p, qty)
      },
      fail: () => { /* 弹窗失败就当没点，不生成订单 */ }
    })
    return null
  },

  // 带服务端算好的有效价（D24）：buyNow 模式在购物车里不再重新定价
  doBuyNow(p, qty) {
    store.setBuyNow([{
      code: p.code, name: p.name, price: p.price, salePrice: p.salePrice, qty: qty,
      unit: p.unit, emoji: p.emoji, img: p.img
    }])
    wx.switchTab({ url: '/pages/cart/cart' })
    return null
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  goHome() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  onShareAppMessage() {
    const p = this.data.p
    return {
      title: (p && p.name) || '啥都有快送',
      path: '/pages/goods/goods?code=' + encodeURIComponent(this.data.code)
    }
  }
})

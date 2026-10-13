// 商品详情（第 24 轮新增）：大图 + 价格 + 库存 + 数量 + 底部动作条
// 价格由服务端按顾客等级算好（D24），页面只读；缺货先拦，不放进购物车。
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

Page({
  data: {
    code: '',
    p: null,
    loading: true,
    err: '',
    qty: 1,
    cartCount: 0,
    tierText: '',
    tierHint: '',
    shop: {}
  },

  onLoad(q) {
    const code = String((q && q.code) || '').trim()
    this.setData({ code: code, shop: api.cachedSettings() || {} })
    return this.load()
  },

  onShow() {
    this.setData({ cartCount: store.cartCount() })
  },

  load() {
    if (!this.data.code) {
      this.setData({ loading: false, err: '没有带上商品条码' })
      return Promise.resolve(null)
    }
    this.setData({ loading: true, err: '' })
    return api.getProduct(this.data.code).then((p) => {
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
      this.setData({ loading: false, err: (e && e.message) || '商品不存在或已下架' })
      return null
    })
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
    store.addToCart(p, this.data.qty)
    this.setData({ cartCount: store.cartCount() })
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  // 立即购买：放进 storage 再跳购物车 tab（tab 页不能 navigateTo）
  buyNow() {
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
    // 带服务端算好的有效价（D24）：buyNow 模式在购物车里不再重新定价
    store.setBuyNow([{
      code: p.code, name: p.name, price: p.price, salePrice: p.salePrice, qty: this.data.qty,
      unit: p.unit, emoji: p.emoji, img: p.img
    }])
    wx.switchTab({ url: '/pages/cart/cart' })
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

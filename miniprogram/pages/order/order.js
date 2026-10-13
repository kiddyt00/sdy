// 订单详情页（第 24 轮新增）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')

Page({
  data: {
    id: '',
    o: null,
    loading: true,
    err: '',
    online: false,
    cartCount: 0
  },

  onLoad(q) {
    this.setData({ id: String((q && q.id) || '') })
  },

  onShow() {
    this.setData({ cartCount: store.cartCount() })
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  onPullDownRefresh() {
    return this.load().then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh())
  },

  load() {
    const id = this.data.id
    if (!id) {
      this.setData({ loading: false, err: '缺少订单号' })
      return Promise.resolve(null)
    }
    this.setData({ loading: true, err: '' })
    return api.getOrder(id).then((o) => {
      if (!o) {
        this.setData({ loading: false, o: null, err: '订单不存在' })
        return null
      }
      this.setData({ loading: false, o: o })
      wx.setNavigationBarTitle({ title: '订单 ' + o.id })
      return o
    }, (e) => {
      this.setData({ loading: false, o: null, err: (e && e.message) || '订单加载失败' })
      return null
    })
  },

  refresh() {
    return this.load()
  },

  onCancel() {
    return this.advance('cancelled')
  },

  onAdvance() {
    return this.advance('done')
  },

  advance(to) {
    const o = this.data.o
    if (!o) return Promise.resolve(null)
    const title = to === 'cancelled' ? '取消这笔订单？' : '确认已经收到货了？'
    const content = to === 'cancelled' ? '取消后库存会回补，这件商品重新上架。' : '确认后这笔订单就完成了。'
    return new Promise((resolve) => {
      wx.showModal({
        title: title,
        content: content,
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    }).then((yes) => {
      if (!yes) return null
      return api.advanceOrder(o.id, to).then((r) => {
        if (r && r.ok === false) {
          wx.showToast({ title: (r.error || '操作失败'), icon: 'none' })
          return null
        }
        wx.showToast({ title: to === 'cancelled' ? '已取消' : '已完成', icon: 'success' })
        return this.load()
      }, (err) => {
        wx.showToast({ title: (err && err.message) || '操作失败', icon: 'none' })
        return null
      })
    })
  },

  onReorder() {
    const o = this.data.o
    if (!o) return null
    ;(o.items || []).forEach((g) => {
      store.addToCart({
        code: g.code,
        name: g.name,
        spec: g.spec || '',
        price: g.price,
        salePrice: g.price,
        wholesalePrice: g.price,
        stock: g.stock || 0,
        unit: g.unit || '件',
        img: g.img || '',
        emoji: g.emoji || '🛒'
      }, g.qty)
    })
    wx.showToast({ title: '已放进购物车', icon: 'success' })
    setTimeout(() => wx.switchTab({ url: '/pages/cart/cart' }), 600)
    return null
  },

  copyId() {
    const o = this.data.o
    if (!o) return null
    wx.setClipboardData({ data: String(o.id) })
    return null
  },

  goIndex() {
    wx.switchTab({ url: '/pages/index/index' })
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  callShop() {
    const s = (getApp().globalData && getApp().globalData.settings) || {}
    if (!s.phone) {
      wx.showToast({ title: '店里没留电话', icon: 'none' })
      return null
    }
    wx.makePhoneCall({ phoneNumber: String(s.phone) })
    return null
  },

  onShareAppMessage() {
    return { title: '啥都有快送 · 订单', path: '/pages/index/index' }
  }
})

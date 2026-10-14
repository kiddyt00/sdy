// 订单详情页（第 24 轮新增）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const ui = require('../common/ui.js')

Page({
  data: {
    id: '',
    o: null,
    loading: true,
    err: '',
    notFoundText: '',
    needIdentity: false,
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
      this.setData({ loading: false, err: '', notFoundText: '缺少订单号' })
      return Promise.resolve(null)
    }
    // 第 27 轮 P0-8：订单详情接口要带身份（openid 或手机号）。
    // 先在页面拦住并引导，不要让顾客看到后端那句「缺少身份」。
    if (this.data.online && !ui.hasIdentity()) {
      this.setData({ loading: false, err: '', notFoundText: '', needIdentity: true, o: null })
      return Promise.resolve(null)
    }
    this.setData({ loading: true, err: '', notFoundText: '', needIdentity: false })
    return api.getOrder(id).then((o) => {
      if (!o) {
        // 请求成功但查无此单 —— 这才是真正的「没找到」
        this.setData({ loading: false, o: null, notFoundText: '没找到这笔订单' })
        return null
      }
      this.setData({ loading: false, o: o, notFoundText: '' })
      wx.setNavigationBarTitle({ title: '订单 ' + o.id })
      return o
    }, (e) => {
      // 第 27 轮 P0-2：请求失败用人话文案 + 给「重新加载」，不冒充「订单不存在」
      this.setData({ loading: false, o: null, notFoundText: '', err: ui.errText(e) })
      return null
    })
  },

  // 错误卡上的「重新加载」：真正重新发请求
  reload() {
    return this.load()
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
    // 第 27 轮 P0-8：取消订单要带身份，没身份先在页面拦住
    if (to === 'cancelled' && this.data.online && !ui.hasIdentity()) {
      this.setData({ needIdentity: true })
      return Promise.resolve(null)
    }
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
        wx.showToast({ title: ui.errText(err) || '操作失败', icon: 'none' })
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

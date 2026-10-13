// 我的：连接状态、后端地址、店铺信息
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    statusDetail: '',
    apiBase: '',
    cartCount: 0,
    shop: {
      name: '小邻里超市',
      hours: '07:30 – 22:30',
      notice: '满 30 元免配送费（自提随时免）；4 人小店，当天送当天到。'
    }
  },

  onShow() {
    this.setData({ apiBase: api.base(), cartCount: store.cartCount() })
    return this.refresh()
  },

  refresh() {
    return getApp()
      .refreshStatus()
      .then((st) => {
        this.setData({
          online: st.online,
          statusLabel: st.label,
          statusDetail: st.detail,
          apiBase: st.base,
          cartCount: store.cartCount()
        })
        return st
      })
  },

  onBase(e) {
    this.setData({ apiBase: e.detail.value })
  },

  saveBase() {
    api.setBase(this.data.apiBase)
    return this.refresh().then(() => {
      this.toast(this.data.online ? '已连接后端' : '保存了，但还没连上')
    })
  },

  goOrders() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/orders/orders' })
  },
  goCart() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/cart/cart' })
  },

  clearAll() {
    return this.confirm('清空本地数据', '只会清手机上的缓存与购物车；服务端商品和订单不受影响。').then((yes) => {
      if (!yes) return null
      api.clearCache()
      store.clearCart()
      this.toast('已清空本地演示数据')
      return this.refresh()
    })
  },

  // 确认框（返回 Promise<boolean>）
  confirm(title, content) {
    return new Promise((resolve) => {
      if (typeof wx !== 'undefined' && wx.showModal) {
        wx.showModal({
          title: title,
          content: content,
          success: (r) => resolve(!!(r && r.confirm)),
          fail: () => resolve(false)
        })
      } else {
        resolve(true)
      }
    })
  },

  toast(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none' })
  }
})

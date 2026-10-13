// 我的订单（顾客视角：看状态、待处理可取消、可再来一单）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    orders: [],
    loading: true
  },

  onShow() {
    return this.refresh()
  },

  onPullDownRefresh() {
    this.refresh().then(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh()
    })
  },

  refresh() {
    return getApp()
      .refreshStatus()
      .then((st) => {
        this.setData({ online: st.online, statusLabel: st.label })
        return api.listOrders()
      })
      .then((list) => {
        this.setData({ orders: list, loading: false })
        return list
      })
      .catch((e) => {
        this.setData({ loading: false })
        this.toast(e.message)
        return []
      })
  },

  onCancel(e) {
    const id = e.currentTarget.dataset.id
    return this.confirm('取消订单', '确定取消这一单吗？').then((yes) => {
      if (!yes) return null
      return api
        .cancelOrder(id)
        .then(() => {
          this.toast('已取消')
          return this.refresh()
        })
        .catch((err) => {
          this.toast(err.message)
          return null
        })
    })
  },

  // 确认框（返回 Promise<boolean>，便于测试与复用）
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

  // 再来一单：把订单里的商品重新放进购物车
  onReorder(e) {
    const id = e.currentTarget.dataset.id
    const o = this.data.orders.filter((x) => x.id === id)[0]
    if (!o) return
    o.items.forEach((it) => {
      store.addToCart({ code: it.code, name: it.name, price: it.price, salePrice: it.price, emoji: '🛒' }, it.qty)
    })
    this.toast('已加入购物车')
    if (typeof wx !== 'undefined' && wx.switchTab) {
      setTimeout(() => { try { wx.switchTab({ url: '/pages/cart/cart' }) } catch (err) { /* 忽略 */ } }, 600)
    }
  },

  toast(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
  }
})

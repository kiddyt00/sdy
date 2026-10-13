// 我的订单（顾客视角：状态 tab、看详情、待处理可取消、配送中/待自提可确认收货、可再来一单）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    orders: [],
    loading: true,
    tabs: rules.STATUS_TABS,
    status: '',
    activeTab: 0,
    empty: false
  },

  onShow() {
    this.takeTab()
    return this.refresh()
  },

  // 「我的」页的状态宫格把想看的 tab 存在本地，这里读走再清掉
  takeTab() {
    let key = ''
    try {
      key = wx.getStorageSync('sdy_mp_order_tab') || ''
      wx.removeStorageSync('sdy_mp_order_tab')
    } catch (e) {
      key = ''
    }
    if (!key) return false
    const idx = this.data.tabs.map((t) => t.key).indexOf(key)
    if (idx < 0) return false
    this.setData({ status: key, activeTab: idx, loading: true })
    return true
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
        return api.listOrders(this.data.status)
      })
      .then((list) => {
        this.setData({ orders: list, loading: false, empty: list.length === 0 })
        return list
      })
      .catch((e) => {
        this.setData({ loading: false, empty: true })
        this.toast(e.message)
        return []
      })
  },

  onTab(e) {
    this.setData({ status: e.currentTarget.dataset.key || '', loading: true })
    return this.refresh()
  },

  // van-tabs：e.detail = { index, name, title }
  onTabChange(e) {
    const idx = Number((e.detail && e.detail.index) || 0) || 0
    const t = this.data.tabs[idx] || { key: '' }
    this.setData({ status: t.key, activeTab: idx, loading: true })
    return this.refresh()
  },

  goDetail(e) {
    const id = e.currentTarget.dataset.id
    if (!id) return
    wx.navigateTo({ url: '/pages/order/order?id=' + encodeURIComponent(id) })
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

  // 确认收货（配送中 / 待自提 → 已完成）
  onAdvance(e) {
    const id = e.currentTarget.dataset.id
    return api
      .advanceOrder(id, 'done')
      .then(() => {
        this.toast('已确认收货')
        return this.refresh()
      })
      .catch((err) => {
        this.toast(err.message)
        return null
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

  goIndex() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/index/index' })
  },

  toast(msg) {
    if (typeof wx !== 'undefined' && wx.showToast) wx.showToast({ title: msg, icon: 'none', duration: 2500 })
  }
})

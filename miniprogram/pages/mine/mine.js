// 我的：登录 / 连接状态 / 后端地址 / 店铺信息
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    statusDetail: '',
    apiBase: '',
    cartCount: 0,
    // 登录态（第 23 轮 / D28）
    loggedIn: false,
    bound: false,
    sessionLabel: '',
    sessionName: '',
    sessionPhone: '',
    tierText: '零售',
    phone: '',
    nickname: '',
    busy: false,
    shop: {
      name: '小邻里超市',
      hours: '07:30 – 22:30',
      notice: '满 30 元免配送费（自提随时免）；4 人小店，当天送当天到。'
    }
  },

  onShow() {
    this.syncSession()
    this.setData({ apiBase: api.base(), cartCount: store.cartCount() })
    return this.refresh()
  },

  // 把登录态同步到页面（退出/登录后都调一次）
  syncSession() {
    const s = api.session()
    this.setData({
      loggedIn: api.isLoggedIn(),
      bound: !!(s && s.phone),
      sessionLabel: api.sessionLabel(),
      sessionName: (s && s.name) || '',
      sessionPhone: (s && s.phone) || '',
      tierText: rules.tierLabel(s && s.tier)
    })
  },

  onPhone(e) {
    this.setData({ phone: e.detail.value })
  },
  onNickname(e) {
    this.setData({ nickname: e.detail.value })
  },

  // 微信登录：没绑过手机号就先填手机号；价格与等级仍由店里设定（不因登录变批发价）
  doLogin() {
    if (this.data.busy) return Promise.resolve(null)
    const phone = String(this.data.phone || '').trim()
    if (!this.data.bound && !phone) {
      this.toast('请先填手机号（老板建档、给价都靠它）')
      return Promise.resolve(null)
    }
    if (phone && !/^1\d{10}$/.test(phone)) {
      this.toast('手机号要 11 位、1 开头')
      return Promise.resolve(null)
    }
    this.setData({ busy: true })
    return api
      .wxLogin({ phone: phone, nickname: this.data.nickname })
      .then((s) => {
        this.setData({ busy: false, phone: '', nickname: '' })
        this.syncSession()
        this.toast('登录成功：' + (s.name || '微信顾客') + ' · ' + rules.tierLabel(s.tier))
        return s
      })
      .catch((e) => {
        this.setData({ busy: false })
        this.toast(e.message)
        return null
      })
  },

  doLogout() {
    return this.confirm('退出登录', '只是让这台手机忘掉登录状态；订单、档案与价格不受影响。').then((yes) => {
      if (!yes) return null
      api.clearSession()
      this.syncSession()
      this.toast('已退出登录')
      return null
    })
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

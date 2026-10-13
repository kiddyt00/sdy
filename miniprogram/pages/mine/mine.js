// 我的：登录 / 订单状态概览 / 地址簿 / 连接状态（第 24 轮重构）
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

const TAB_KEY = 'sdy_mp_order_tab'
const AVATAR_KEY = 'sdy_mp_avatar'

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
    avatar: '',
    devMode: false,
    counts: { pending: 0, delivering: 0, ready: 0, done: 0 },
    orderGrid: [
      { key: 'pending', label: '待处理', icon: 'tosend' },
      { key: 'delivering', label: '配送中', icon: 'logistics' },
      { key: 'ready', label: '待自提', icon: 'shop-o' },
      { key: 'done', label: '已完成', icon: 'completed' }
    ],
    shop: {
      name: '啥都有快送',
      hours: '07:30 – 22:30',
      notice: '满 30 元免配送费（自提随时免）；4 人小店，当天送当天到。'
    }
  },

  onShow() {
    this.syncSession()
    this.setData({ apiBase: api.base(), cartCount: store.cartCount() })
    this.loadAvatar()
    return this.refresh().then((st) => {
      this.loadCounts()
      return st
    })
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

  loadAvatar() {
    try {
      const a = wx.getStorageSync(AVATAR_KEY)
      if (a) this.setData({ avatar: a })
    } catch (e) { /* 忽略 */ }
  },

  // open-type="chooseAvatar" 回传的临时头像，只存在本机（服务端没存头像字段）
  onChooseAvatar(e) {
    const url = (e.detail && e.detail.avatarUrl) || ''
    if (!url) return null
    this.setData({ avatar: url })
    try {
      wx.setStorageSync(AVATAR_KEY, url)
    } catch (err) { /* 忽略 */ }
    return url
  },

  // 订单状态条：把想看的 tab 存下来，切到订单页读走（tab 页不能带参数）
  goOrdersWith(e) {
    const key = (e.currentTarget.dataset.key) || ''
    try {
      wx.setStorageSync(TAB_KEY, key)
    } catch (err) { /* 忽略 */ }
    wx.switchTab({ url: '/pages/orders/orders' })
  },

  loadCounts() {
    return api.listOrders('').then((list) => {
      const c = { pending: 0, delivering: 0, ready: 0, done: 0 }
      ;(list || []).forEach((o) => {
        if (c[o.status] !== undefined) c[o.status] += 1
      })
      this.setData({ counts: c })
      return c
    }, () => null)
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
        this.loadCounts()
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
      this.loadCounts()
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
        const s = getApp().globalData && getApp().globalData.settings
        if (s && s.name) {
          this.setData({
            'shop.name': s.name,
            'shop.notice': s.notice || s.footer || this.data.shop.notice
          })
        }
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

  toggleDev() {
    this.setData({ devMode: !this.data.devMode })
  },

  goOrders() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/orders/orders' })
  },
  goCart() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/cart/cart' })
  },
  goAddress() {
    if (typeof wx !== 'undefined' && wx.navigateTo) wx.navigateTo({ url: '/pages/address/list' })
  },
  goIndex() {
    if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/index/index' })
  },
  callShop() {
    const p = (getApp().globalData && getApp().globalData.settings && getApp().globalData.settings.phone) || ''
    if (!p) {
      this.toast('店里还没留电话')
      return null
    }
    if (typeof wx !== 'undefined' && wx.makePhoneCall) wx.makePhoneCall({ phoneNumber: String(p) })
    return null
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

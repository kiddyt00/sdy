// 我的：微信登录（头像昵称）/ 订单状态概览 / 地址簿（第 24 轮重构；第 25 轮 D31 改造）
// D31 两条口径：① 登录只认微信（openid），**不绑手机号**——手机号是下单时填的收货信息；
// ② 头像昵称只能用微信官方的「头像昵称填写能力」让用户自己选（微信 2022 起不再静默下发）。
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const rules = require('../../utils/rules.js')

const TAB_KEY = 'sdy_mp_order_tab'
const AVATAR_KEY = 'sdy_mp_avatar'

// 服务端只存得下 http(s) 地址：chooseAvatar 给的是本机临时路径，
// 直接存进去下次任何设备都显示不出来（要真跨设备得先有文件上传接口，暂时不做）。
function avatarForServer(path) {
  return /^https?:\/\//.test(String(path || '')) ? String(path) : ''
}

Page({
  data: {
    online: false,
    statusLabel: '⏳ 探测中…',
    statusDetail: '',
    apiBase: '',
    cartCount: 0,
    // 登录态（第 23 轮 / D28；第 25 轮 D31：不再有 phone / bound）
    loggedIn: false,
    sessionLabel: '',
    sessionName: '',
    sessionPhone: '',
    tierText: '零售',
    nickname: '',
    busy: false,
    saving: false,
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

  // 把登录态同步到页面（登录/退出/换头像昵称后都调一次）
  syncSession() {
    const s = api.session()
    this.setData({
      loggedIn: api.isLoggedIn(),
      sessionLabel: api.sessionLabel(),
      sessionName: api.displayName(),
      sessionPhone: (s && s.phone) || '',
      tierText: rules.tierLabel(s && s.tier),
      // 昵称优先用本地的（用户刚在输入框里改的），没有就用服务端带回来的
      nickname: this.data.nickname || (s && (s.nickname || '')) || ''
    })
  },

  loadAvatar() {
    try {
      const a = wx.getStorageSync(AVATAR_KEY)
      if (a) this.setData({ avatar: a })
    } catch (e) { /* 忽略 */ }
  },

  // 把 chooseAvatar 给的临时文件存成小程序本地永久文件，否则重启后头像就白了
  persistAvatar(tempPath) {
    return new Promise((resolve) => {
      const fs = (typeof wx !== 'undefined' && wx.getFileSystemManager) ? wx.getFileSystemManager() : null
      if (!tempPath || !fs || typeof fs.saveFile !== 'function') {
        resolve(tempPath || '')
        return
      }
      fs.saveFile({
        tempFilePath: tempPath,
        success: (r) => resolve((r && r.savedFilePath) || tempPath),
        fail: () => resolve(tempPath) // 存不下就用临时路径先显示，至少这次是好的
      })
    })
  },

  // open-type="chooseAvatar" 回传用户选的头像（登录前后都能点）
  onChooseAvatar(e) {
    const url = (e.detail && e.detail.avatarUrl) || ''
    if (!url) return Promise.resolve('')
    return this.persistAvatar(url).then((saved) => {
      this.setData({ avatar: saved })
      try {
        wx.setStorageSync(AVATAR_KEY, saved)
      } catch (err) { /* 忽略 */ }
      // 已登录：顺手同步给服务端（只有 http(s) 地址服务端才用得上）
      const forServer = avatarForServer(saved)
      if (this.data.loggedIn && forServer) return this.pushProfile({ avatar: forServer })
      return saved
    })
  },

  onNickname(e) {
    this.setData({ nickname: (e.detail && e.detail.value) || '' })
  },

  // 登录：只换 openid，不填手机号（手机号下单时填）；头像昵称有就带上
  doLogin() {
    if (this.data.busy) return Promise.resolve(null)
    this.setData({ busy: true })
    return api
      .wxLogin({
        nickname: String(this.data.nickname || '').trim(),
        avatar: avatarForServer(this.data.avatar)
      })
      .then((s) => {
        this.setData({ busy: false })
        this.syncSession()
        this.loadCounts()
        this.toast('登录成功：' + (api.displayName() || '微信顾客') + ' · ' + rules.tierLabel(s.tier))
        return s
      })
      .catch((e) => {
        this.setData({ busy: false })
        this.toast(e.message)
        return null
      })
  },

  // 已登录时保存头像昵称（服务端空值＝保留原值）
  pushProfile(patch) {
    return api.saveProfile(patch).then((s) => {
      this.syncSession()
      return s
    })
  },

  saveProfile() {
    if (!this.data.loggedIn) {
      this.toast('先登录再保存头像昵称')
      return Promise.resolve(null)
    }
    if (this.data.saving) return Promise.resolve(null)
    this.setData({ saving: true })
    return this.pushProfile({
      nickname: String(this.data.nickname || '').trim(),
      avatar: avatarForServer(this.data.avatar)
    })
      .then(() => {
        this.setData({ saving: false })
        this.toast('已保存，下次进来自动带出来')
        return null
      })
      .catch((e) => {
        this.setData({ saving: false })
        this.toast(e.message)
        return null
      })
  },

  doLogout() {
    return this.confirm('退出登录', '只是让这台手机忘掉登录状态；订单、档案与价格不受影响。').then((yes) => {
      if (!yes) return null
      api.clearSession()
      this.setData({ nickname: '' })
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

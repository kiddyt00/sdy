// 我的：微信登录（头像昵称）/ 订单状态概览 / 地址簿（第 24 轮重构；第 25 轮 D31 改造）
// D31 口径：① 登录只认微信（openid），**不绑手机号**——手机号是下单时填的收货信息；
// ② 头像昵称只能用微信官方的「头像昵称填写能力」让用户自己选（微信 2022-10-25 起不再静默下发，
//    wx.getUserProfile 只会给灰头像 + 「微信用户」）；③ 没有「保存头像昵称」入口——
//    登录按钮本身就是头像按钮（点一次同时选头像 + 登录），之后永远带出来；
// ④ **顾客端没有任何开发入口**——原先长按版本号进的「调试面板」已按老板要求整块删除，
//    后端地址只在 utils/config.js 里配置，页面 data 里不再留 devMode / statusDetail / apiBase。
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
    cartCount: 0,
    // 登录态（第 23 轮 / D28；第 25 轮 D31：不再有 phone / bound）
    loggedIn: false,
    sessionLabel: '',
    sessionName: '',
    sessionPhone: '',
    tierText: '零售',
    nickname: '',
    busy: false,
    avatar: '',
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
    this.setData({ cartCount: store.cartCount() })
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

  // 头像优先用本机记住的（chooseAvatar 存下来的永久文件）；
  // 换了手机 / 清过缓存就从服务端带回来的地址补上（服务端只存得下 http(s)）
  loadAvatar() {
    let a = ''
    try {
      a = wx.getStorageSync(AVATAR_KEY) || ''
    } catch (e) { /* 忽略 */ }
    if (!a) a = avatarForServer((api.session() || {}).avatar)
    if (a) this.setData({ avatar: a })
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

  // 登录按钮就是 open-type="chooseAvatar" 按钮（第 25 轮收口④）：
  // 微信不允许静默拿真实头像，官方唯一入口就是这个选择器（第一项「使用微信头像」），
  // 所以「选头像」和「登录」合成一步——选完头像立刻用同一份昵称/头像去换 openid。
  onChooseAvatar(e) {
    const url = (e.detail && e.detail.avatarUrl) || ''
    if (!url) return Promise.resolve(null)
    return this.persistAvatar(url).then((saved) => {
      this.setData({ avatar: saved })
      if (saved) {
        try {
          wx.setStorageSync(AVATAR_KEY, saved)
        } catch (err) { /* 忽略 */ }
      }
      return this.doLogin()
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

  doLogout() {
    return this.confirm('退出登录', '只是让这台手机忘掉登录状态；订单、档案与价格不受影响。').then((yes) => {
      if (!yes) return null
      api.clearSession()
      // 退出登录必须把头像也清掉：上一版的头像存在本机缓存里，退出后还挂在绿色框上，
      // 老板一眼就看成「退出了还显示我的微信头像」。存储一起删，免得换个人登录先闪出上一个人的头像。
      try {
        wx.removeStorageSync(AVATAR_KEY)
      } catch (err) { /* 忽略 */ }
      this.setData({ nickname: '', avatar: '' })
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

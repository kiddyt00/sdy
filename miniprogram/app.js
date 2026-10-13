// 啥都有快送 · 顾客端小程序（M5）
// 与网页版同构：后端是唯一真源；探测不到后端自动降级为「本地演示」，页面照常可点。
const api = require('./utils/api.js')
const store = require('./utils/store.js')

App({
  globalData: {
    apiBase: api.base(),
    online: false,
    status: null,
    netConnected: true,
    settings: null
  },

  onLaunch() {
    this.refreshStatus()
    this.initNavMetrics()
    this.watchNetwork()
    this.watchUpdate()
    store.syncTabBadge()
    // 店铺信息缓存着，我的页 / 首页公告先出内容，网络回来再刷新
    this.globalData.settings = api.cachedSettings()
    this.loadSettings()
  },

  onShow() {
    store.syncTabBadge()
  },

  // 探测一次后端（不轮询）。返回 Promise<status>，失败也 resolve（降级）。
  refreshStatus() {
    return api.probe().then((st) => {
      this.globalData.online = !!st.online
      this.globalData.status = st
      this.globalData.apiBase = st.base
      if (st.online) this.loadSettings()
      return st
    })
  },

  // 店铺信息（店名/电话/地址/落款）与 Web 端同一份 /api/settings
  loadSettings() {
    return api.getSettings().then((s) => {
      this.globalData.settings = s
      return s
    }, () => this.globalData.settings)
  },

  // 自定义导航栏 / 状态栏高度：顶部吸顶与安全区用得上（换 wx.getSystemInfo 为 getWindowInfo）
  initNavMetrics() {
    if (typeof wx === 'undefined' || !wx || typeof wx.getWindowInfo !== 'function') {
      this.globalData.navHeight = 64
      return
    }
    try {
      const win = wx.getWindowInfo()
      let nav = 0
      if (typeof wx.getMenuButtonBoundingClientRect === 'function') {
        const mb = wx.getMenuButtonBoundingClientRect()
        const bar = win.statusBarHeight || 20
        nav = bar + mb.height + (mb.top - bar) * 2
      }
      this.globalData.statusBarHeight = win.statusBarHeight || 20
      this.globalData.navHeight = nav || 64
    } catch (e) {
      this.globalData.navHeight = 64
    }
  },

  // 网络状态：断开即时提示，恢复时刷新一次（比每次进页面探测更跟手）
  watchNetwork() {
    if (typeof wx === 'undefined' || !wx || typeof wx.onNetworkStatusChange !== 'function') return
    wx.onNetworkStatusChange((res) => {
      const was = this.globalData.netConnected
      this.globalData.netConnected = !!(res && res.isConnected)
      if (was && !this.globalData.netConnected) {
        wx.showToast({ title: '网络已断开', icon: 'none' })
      }
      if (!was && this.globalData.netConnected) {
        wx.hideToast()
        this.refreshStatus()
      }
    })
  },

  // 版本更新提示（原生能力，零依赖）
  watchUpdate() {
    if (typeof wx === 'undefined' || !wx || typeof wx.getUpdateManager !== 'function') return
    const um = wx.getUpdateManager()
    um.onUpdateReady(() => {
      wx.showModal({
        title: '发现新版本',
        content: '新版本已经准备好，是否重启应用？',
        success(res) {
          if (res.confirm) um.applyUpdate()
        }
      })
    })
  }
})

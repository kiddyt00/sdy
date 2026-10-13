// 小邻里超市 · 顾客端小程序（M5）
// 与网页版同构：后端是唯一真源；探测不到后端自动降级为「本地演示」，页面照常可点。
const api = require('./utils/api.js')

App({
  globalData: {
    apiBase: api.base(),
    online: false,
    status: null
  },

  onLaunch() {
    this.refreshStatus()
  },

  // 探测一次后端（不轮询）。返回 Promise<status>，失败也 resolve（降级）。
  refreshStatus() {
    return api.probe().then((st) => {
      this.globalData.online = !!st.online
      this.globalData.status = st
      this.globalData.apiBase = st.base
      return st
    })
  }
})

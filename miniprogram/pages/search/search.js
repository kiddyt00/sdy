// 搜索页（第 24 轮新增）：历史词（≤10、去重）+ 热门词 + 300ms 防抖 + 结果网格
const api = require('../../utils/api.js')
const config = require('../../utils/config.js')

const HIST_KEY = 'sdy_mp_search_history'
const HIST_MAX = 10
const DEFAULT_HOT = ['可乐', '雪碧', '啤酒', '牛奶', '抽纸', '矿泉水', '薯片']

function readHist() {
  try {
    const v = wx.getStorageSync(HIST_KEY)
    return Array.isArray(v) ? v : []
  } catch (e) {
    return []
  }
}

Page({
  data: {
    keyword: '',
    hist: [],
    hot: DEFAULT_HOT,
    results: [],
    searched: false,
    loading: false,
    empty: false,
    online: false
  },

  onLoad() {
    this.setData({ hist: readHist() })
    // 热门词优先用店铺的真实分类，接口不通就退回默认词
    api.listCategories().then((cs) => {
      const names = (cs || []).map((c) => c.name).filter((n) => n && n !== '未分类')
      if (names.length) this.setData({ hot: names.slice(0, 8) })
    }).catch(() => {})
  },

  onShow() {
    api.probe().then((st) => this.setData({ online: !!st.online }))
  },

  // 输入防抖：300ms 不敲字才去查（参考项目里没做，翻页会抖）
  onInput(e) {
    this.setData({ keyword: e.detail.value })
    if (this._t) clearTimeout(this._t)
    this._t = setTimeout(() => this.doSearch(false), 300)
  },

  onConfirm() {
    if (this._t) clearTimeout(this._t)
    return this.doSearch(true)
  },

  onClear() {
    this.setData({ keyword: '', results: [], searched: false, empty: false })
    return null
  },

  tapWord(e) {
    this.setData({ keyword: e.currentTarget.dataset.w })
    return this.doSearch(true)
  },

  doSearch(save) {
    const kw = String(this.data.keyword || '').trim()
    if (!kw) {
      this.setData({ results: [], searched: false, empty: false })
      return Promise.resolve([])
    }
    this.setData({ loading: true })
    return api.listProducts(kw, '').then((list) => {
      this.setData({
        results: list,
        searched: true,
        loading: false,
        empty: list.length === 0
      })
      if (save) this.pushHist(kw)
      return list
    }, () => {
      this.setData({ loading: false, searched: true, empty: true })
      return []
    })
  },

  pushHist(kw) {
    const list = [kw].concat(readHist().filter((x) => x !== kw)).slice(0, HIST_MAX)
    try {
      wx.setStorageSync(HIST_KEY, list)
    } catch (e) { /* 忽略 */ }
    this.setData({ hist: list })
  },

  clearHist() {
    try {
      wx.removeStorageSync(HIST_KEY)
    } catch (e) { /* 忽略 */ }
    this.setData({ hist: [] })
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/goods/goods?code=' + encodeURIComponent(code) })
  },

  goIndex() {
    wx.switchTab({ url: '/pages/index/index' })
  }
})

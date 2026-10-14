// 首页（第 24 轮重做）：吸顶店铺条 + 搜索 + 分类 chips + 双列商品网格
// 数据全部来自服务端（离线自动降级为本地演示商品）；价格由服务端按等级算好，页面只读。
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const config = require('../../utils/config.js')
const ui = require('../common/ui.js')

const PAGE_SIZE = 20

Page({
  data: {
    online: false,
    shop: { name: config.STORE_NAME, phone: '', address: '' },
    cats: [{ name: '全部', count: 0 }],
    cat: '全部',
    keyword: '',
    all: [],          // 当前分类 + 关键词下的全量
    products: [],     // 分页后真正渲染的
    shown: PAGE_SIZE,
    hasMore: false,
    total: 0,
    loading: true,
    empty: false,
    loadErr: '',
    // 第 27 轮 P0-9：低库存阈值由服务端 settings 下发（api.lowStock 兜底 5），页面不再写死 5
    lowStock: api.lowStock(),
    cartCount: 0,
    cartAmountText: '0.00'
  },

  onLoad() {
    this.setData({
      shop: Object.assign({ name: config.STORE_NAME }, api.cachedSettings() || {}),
      lowStock: api.lowStock()
    })
    // 购物车变更 → 页面计数 + tabBar 角标由 store 一处广播（第 27 轮 P0-1）
    this._off = store.subscribe(() => this.syncCart())
  },

  onUnload() {
    if (this._off) this._off()
  },

  onShow() {
    this.syncCart()
    this.setData({ lowStock: api.lowStock() })
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  onPullDownRefresh() {
    Promise.all([api.probe(), this.load()]).then(
      () => wx.stopPullDownRefresh(),
      () => wx.stopPullDownRefresh()
    )
  },

  onReachBottom() {
    this.setData({ shown: this.data.shown + PAGE_SIZE })
    this.applyFilter()
  },

  // 拉商品 + 分类；分类接口失败就按商品自己归类（离线 / 老后端也能用）
  load() {
    this.setData({ loading: true, loadErr: '' })
    return Promise.all([
      api.listProducts('', ''),
      api.listCategories().catch(() => [])
    ]).then((res) => {
      const items = res[0] || []
      let cats = res[1] || []
      if (!cats.length) {
        const m = {}
        items.forEach((p) => {
          const k = p.category || '未分类'
          m[k] = (m[k] || 0) + 1
        })
        cats = Object.keys(m).map((k) => ({ name: k, count: m[k] }))
      }
      // 分类 chip 在，但当前选中的分类已经没货了 → 回到「全部」，不让用户卡在空列表
      const names = cats.map((c) => c.name)
      const cat = this.data.cat !== '全部' && names.indexOf(this.data.cat) < 0 ? '全部' : this.data.cat
      this.setData({
        all: items,
        cats: [{ name: '全部', count: items.length }].concat(cats),
        cat: cat,
        loading: false,
        loadErr: ''
      })
      this.applyFilter()
      return items
    }, (e) => {
      // 第 27 轮 P0-2：拉不到商品 ≠ 店里没货。失败给错误卡 + 「重新加载」，
      // 只有请求成功且结果为空才允许显示「没有找到商品」。
      this.setData({
        loading: false,
        all: [],
        products: [],
        total: 0,
        hasMore: false,
        empty: false,
        loadErr: ui.errText(e)
      })
      return []
    })
  },

  // 错误卡上的「重新加载」：真的重新探测 + 重新发请求（不是把旧数据再渲染一遍）
  reload() {
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  applyFilter() {
    const cat = this.data.cat
    const kw = String(this.data.keyword || '').trim().toLowerCase()
    let list = this.data.all || []
    if (cat && cat !== '全部') list = list.filter((p) => (p.category || '未分类') === cat)
    if (kw) list = list.filter((p) => (p.name + p.brand + p.spec + p.code).toLowerCase().indexOf(kw) >= 0)
    const shown = list.slice(0, this.data.shown)
    this.setData({
      products: shown,
      total: list.length,
      hasMore: list.length > shown.length,
      empty: shown.length === 0 && !this.data.loading && !this.data.loadErr
    })
    return shown
  },

  syncCart() {
    this.setData({
      cartCount: store.cartCount(),
      cartAmountText: store.cartAmount().toFixed(2)
    })
  },

  onCategory(e) {
    this.setData({ cat: e.currentTarget.dataset.cat, shown: PAGE_SIZE })
    this.applyFilter()
  },

  clearKeyword() {
    this.setData({ keyword: '', shown: PAGE_SIZE })
    this.applyFilter()
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/goods/goods?code=' + encodeURIComponent(code) })
  },

  goCategory() {
    wx.switchTab({ url: '/pages/category/category' })
  },

  // 列表页直接加购：只加 1 件，改数量去购物车
  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const p = (this.data.all || []).filter((x) => x.code === code)[0]
    if (!p) return
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return
    }
    // 第 27 轮 P0-6：购物车里的数量上限就是这件商品的库存，到顶了就别再加
    const line = (store.getCart() || []).filter((x) => x.code === code)[0]
    const have = line ? Number(line.qty) || 0 : 0
    if (have + 1 > p.stock) {
      wx.showToast({ title: '最多只能买 ' + p.stock + (p.unit || '件'), icon: 'none' })
      return
    }
    store.addToCart(p, 1)
    this.syncCart()
    wx.showToast({ title: '已加入购物车', icon: 'none' })
  },

  // 扫码找货（**只读**，D8）：只回答「这个条码是哪个商品」，绝不自动加购
  onScan() {
    return new Promise((resolve) => {
      if (typeof wx === 'undefined' || !wx || typeof wx.scanCode !== 'function') {
        resolve(null)
        return
      }
      wx.scanCode({
        onlyFromCamera: false,
        success: (res) => {
          const code = String((res && res.result) || '').trim()
          if (!code) {
            resolve(null)
            return
          }
          api.resolveBarcode(code).then((r) => {
            const found = !!(r && r.found)
            const name = found ? r.name || '' : ''
            this.setData({ keyword: found ? name : code, shown: PAGE_SIZE })
            this.applyFilter()
            if (found) wx.showToast({ title: '已找到：' + name, icon: 'none' })
            else wx.showToast({ title: '没建档，记下条码找老板', icon: 'none' })
            resolve(r)
          }, () => {
            wx.showToast({ title: '查货失败，稍后再试', icon: 'none' })
            resolve(null)
          })
        },
        fail: () => resolve(null)
      })
    })
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  onShareAppMessage() {
    return {
      title: (this.data.shop && this.data.shop.name) || config.STORE_NAME,
      path: '/pages/index/index'
    }
  }
})

// 分类页（第 24 轮新增）：左侧分类栏 + 右侧商品列表
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')

Page({
  data: {
    cats: [],
    cat: '',
    catIndex: 0,
    products: [],
    loading: true,
    online: false,
    empty: false,
    cartCount: 0
  },

  onShow() {
    this.syncCart()
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  onPullDownRefresh() {
    return api.probe().then(() => this.load())
      .then(() => wx.stopPullDownRefresh(), () => wx.stopPullDownRefresh())
  },

  // 商品只拉一次（全量在售），分类和筛选都在本地做：切分类不再打网络
  load() {
    this.setData({ loading: true })
    return api.listProducts('', '').then((list) => {
      this._all = list || []
      return api.listCategories().catch(() => null).then((cs) => {
        const cats = (cs && cs.length) ? cs : this.deriveCats(this._all)
        let cat = this.data.cat
        if (!cats.some((c) => c.name === cat)) cat = cats.length ? cats[0].name : ''
        const idx = Math.max(0, cats.map((c) => c.name).indexOf(cat))
        this.setData({ cats: cats, cat: cat, catIndex: idx })
        this.applyProducts(cat)
        return cats
      })
    }, () => {
      this._all = []
      this.setData({ cats: [], cat: '', products: [], loading: false, empty: true })
      return []
    })
  },

  // 分类接口不通时，按商品自身的 category 现场归类（口径与后端一致：空 → 未分类）
  deriveCats(list) {
    const m = {}
    ;(list || []).forEach((p) => {
      const k = p.category || '未分类'
      m[k] = (m[k] || 0) + 1
    })
    return Object.keys(m).map((k) => ({ name: k, count: m[k] }))
  },

  applyProducts(cat) {
    const list = (this._all || []).filter((p) => !cat || (p.category || '未分类') === cat)
    this.setData({ products: list, loading: false, empty: list.length === 0 })
    return list
  },

  onSelect(e) {
    const name = e.currentTarget.dataset.name || ''
    const idx = this.data.cats.map((c) => c.name).indexOf(name)
    this.setData({ cat: name, catIndex: idx < 0 ? 0 : idx })
    return Promise.resolve(this.applyProducts(name))
  },

  // van-sidebar：e.detail 是 index
  onSideChange(e) {
    const idx = Number((e.detail && e.detail.index) || 0) || 0
    const c = this.data.cats[idx] || { name: '' }
    this.setData({ cat: c.name, catIndex: idx })
    return Promise.resolve(this.applyProducts(c.name))
  },

  onAdd(e) {
    const code = e.currentTarget.dataset.code
    const p = (this.data.products || []).filter((x) => x.code === code)[0]
    if (!p) return null
    if (p.stock <= 0) {
      wx.showToast({ title: '这件暂时没货', icon: 'none' })
      return null
    }
    store.addToCart(p, 1)
    this.syncCart()
    wx.showToast({ title: '已加入购物车', icon: 'success' })
    return null
  },

  goDetail(e) {
    const code = e.currentTarget.dataset.code
    if (!code) return
    wx.navigateTo({ url: '/pages/goods/goods?code=' + encodeURIComponent(code) })
  },

  goCart() {
    wx.switchTab({ url: '/pages/cart/cart' })
  },

  goSearch() {
    wx.navigateTo({ url: '/pages/search/search' })
  },

  syncCart() {
    this.setData({ cartCount: store.cartCount() })
  },

  onShareAppMessage() {
    return { title: '啥都有快送 · 分类', path: '/pages/category/category' }
  }
})

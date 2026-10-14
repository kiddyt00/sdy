// 员工库存页（第 26 轮 / D32）：按名字/条码搜货，看库存与售价，点进去就是扫码台的货卡。
// 这里故意带出「已下架」的货（顾客端看不到，员工要能看见），店员找货才不至于漏。
const api = require('../../utils/api.js')
const staff = require('../../utils/staff.js')

Page({
  data: {
    kw: '',
    loading: false,
    err: '',
    lowStock: 5,
    list: [],
    onlyLow: false
  },

  onShow() {
    if (!staff.ensureStaff()) return
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh()
    })
  },

  onKw(e) {
    this.setData({ kw: (e.detail && e.detail.value) || '' })
  },
  search() {
    this.load()
  },
  clear() {
    this.setData({ kw: '' })
    this.load()
  },
  toggleLow() {
    this.setData({ onlyLow: !this.data.onlyLow }, () => this.render())
  },

  load() {
    this.setData({ loading: true, err: '' })
    return api.listAllProducts(this.data.kw).then(
      (list) => {
        this.raw = list || []
        this.setData({ loading: false })
        this.render()
        return this.raw
      },
      (e) => {
        this.setData({ loading: false, err: (e && e.message) || '加载失败' })
        return null
      }
    )
  },

  render() {
    const low = this.data.lowStock
    let list = (this.raw || []).map((p) => ({
      code: p.code,
      name: p.name,
      spec: p.spec,
      brand: p.brand,
      unit: p.unit,
      stock: p.stock,
      stockText: p.stock + ' ' + (p.unit || '件'),
      priceText: '¥' + p.salePriceText,
      onSale: p.onSale,
      low: p.stock <= low
    }))
    if (this.data.onlyLow) list = list.filter((p) => p.low)
    this.setData({ list: list })
  },

  open(e) {
    const code = (e.currentTarget.dataset.code) || ''
    if (!code) return
    staff.go('/pages/staff/scan?code=' + encodeURIComponent(code))
  },
  goScan() {
    staff.go('/pages/staff/scan')
  }
})

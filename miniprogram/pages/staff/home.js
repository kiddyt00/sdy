// 员工工作台（第 26 轮 / D32）：老板手机上第一眼要看的东西
// 今日营业额 / 今日单数 / 待处理单 / 低库存，加一个大大的「扫码找货」。
// 数据全部来自服务端 /api/staff/overview（员工令牌校验），小程序不自己算账。
const api = require('../../utils/api.js')
const staff = require('../../utils/staff.js')

Page({
  data: {
    ready: false,
    loading: true,
    error: '',
    name: '',
    lowStock: 5,
    stats: { revenueText: '0.00', todayOrders: 0, pending: 0, lowStockCount: 0, products: 0 },
    pendingOrders: [],
    lowStockItems: [],
    recent: []
  },

  onShow() {
    if (!staff.ensureStaff()) return
    this.setData({ name: api.displayName() || '员工' })
    this.load()
  },

  onPullDownRefresh() {
    this.load().then(() => {
      if (typeof wx !== 'undefined' && wx.stopPullDownRefresh) wx.stopPullDownRefresh()
    })
  },

  load() {
    this.setData({ loading: true, error: '' })
    return api.staffOverview().then(
      (d) => {
        const st = (d && d.stats) || {}
        this.setData({
          loading: false,
          ready: true,
          lowStock: d.lowStock || 5,
          stats: {
            revenueText: staff.money(st.todayRevenue),
            todayOrders: st.todayOrders || 0,
            pending: st.pending || 0,
            lowStockCount: st.lowStockCount || 0,
            products: st.products || 0
          },
          pendingOrders: (d.pendingOrders || []).map((o) => ({
            id: String(o.id || ''),
            who: o.customerName || o.phone || '顾客',
            totalText: staff.money(o.total),
            address: o.address || '',
            at: (o.createdAt || '').replace('T', ' ').slice(5, 16)
          })),
          lowStockItems: (d.lowStockItems || []).map((p) => ({
            code: String(p.code || ''),
            name: p.name || '',
            spec: p.spec || '',
            stock: Number(p.stock) || 0,
            unit: p.unit || '件'
          })),
          recent: (d.recent || []).map((e) => ({
            id: String(e.id || ''),
            name: e.name || '',
            deltaText: (Number(e.delta) > 0 ? '+' : '') + e.delta,
            after: Number(e.after) || 0,
            reason: e.reason || '',
            by: e.by || '',
            at: (e.ts || '').replace('T', ' ').slice(5, 16)
          }))
        })
        return d
      },
      (e) => {
        this.setData({ loading: false, ready: true, error: (e && e.message) || '加载失败' })
        return null
      }
    )
  },

  // 工作台上的大按钮：直接调起扫码，扫完带着条码进扫码台看结果
  onScan() {
    if (typeof wx === 'undefined' || !wx.scanCode) return
    wx.scanCode({
      onlyFromCamera: false,
      scanType: ['barCode', 'qrCode'],
      success: (r) => {
        const code = String((r && r.result) || '').trim()
        if (code) staff.go('/pages/staff/scan?code=' + encodeURIComponent(code))
      },
      fail: () => { /* 用户取消不提示 */ }
    })
  },
  goScan() {
    staff.go('/pages/staff/scan')
  },
  goStock() {
    staff.go('/pages/staff/stock')
  },
  goOrders() {
    staff.go('/pages/staff/orders')
  },
  openOrder(e) {
    const id = (e.currentTarget.dataset.id) || ''
    if (!id) return
    if (typeof wx !== 'undefined' && wx.navigateTo) wx.navigateTo({ url: '/pages/order/order?id=' + encodeURIComponent(id) })
  },
  openItem(e) {
    const code = (e.currentTarget.dataset.code) || ''
    if (!code) return
    staff.go('/pages/staff/scan?code=' + encodeURIComponent(code))
  }
})

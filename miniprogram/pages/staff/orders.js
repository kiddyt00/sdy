// 员工订单页（第 26 轮 / D32）：老板/店员在手机上直接把单子往下推。
// 状态机跟服务端 store.stateFlow 一模一样（pending → delivering/ready → done，pending → cancelled），
// 「能点哪个按钮」全部由这一份决定，页面不自己发明状态。
const api = require('../../utils/api.js')
const staff = require('../../utils/staff.js')
const rules = require('../../utils/rules.js')

const TABS = [
  { key: '', label: '全部' },
  { key: 'pending', label: '待处理' },
  { key: 'delivering', label: '配送中' },
  { key: 'ready', label: '待自提' },
  { key: 'done', label: '已完成' },
  { key: 'cancelled', label: '已取消' }
]

Page({
  data: {
    tabs: TABS,
    tab: '',
    loading: false,
    err: '',
    list: []
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

  pick(e) {
    const key = (e.currentTarget.dataset.key) || ''
    if (key === this.data.tab) return
    this.setData({ tab: key })
    this.load()
  },

  load() {
    this.setData({ loading: true, err: '' })
    return api.listOrders(this.data.tab).then(
      (list) => {
        this.setData({ loading: false, list: (list || []).map((o) => this.row(o)) })
        return list
      },
      (e) => {
        this.setData({ loading: false, err: (e && e.message) || '加载失败' })
        return null
      }
    )
  },

  row(o) {
    const acts = []
    if (o.status === 'pending') {
      acts.push(o.deliveryType === 'delivery'
        ? { to: 'delivering', label: '开始配送', kind: 'primary' }
        : { to: 'ready', label: '备好待提', kind: 'primary' })
      acts.push({ to: 'cancelled', label: '取消', kind: 'danger' })
    } else if (o.status === 'delivering' || o.status === 'ready') {
      acts.push({ to: 'done', label: '完成', kind: 'primary' })
    }
    return {
      id: o.id,
      who: o.customerName || '顾客',
      phone: o.phone || '',
      address: o.address || '',
      deliveryText: o.deliveryText,
      totalText: o.totalText,
      status: o.status,
      statusText: rules.statusLabel(o.status),
      at: o.createdText || '',
      items: (o.items || []).map((it) => ({ name: it.name, qty: it.qty, unit: it.unit })),
      summary: (o.items || []).map((it) => it.name + '×' + it.qty).join('、'),
      acts: acts
    }
  },

  open(e) {
    const id = (e.currentTarget.dataset.id) || ''
    if (!id) return
    if (typeof wx !== 'undefined' && wx.navigateTo) wx.navigateTo({ url: '/pages/order/order?id=' + encodeURIComponent(id) })
  },

  advance(e) {
    const ds = e.currentTarget.dataset
    const id = ds.id || ''
    const to = ds.to || ''
    if (!id || !to) return
    const label = ds.label || '推进'
    const tip = to === 'cancelled' ? '取消这一单？库存会回补。' : '把订单 #' + id + ' 标成「' + label + '」？'
    staff.confirm(label, tip).then((ok) => {
      if (!ok) return
      api.advanceOrder(id, to).then(
        () => {
          staff.toast('已' + label)
          this.load()
        },
        (err) => staff.toast((err && err.message) || '操作失败')
      )
    })
  },
  callPhone(e) {
    const p = (e.currentTarget.dataset.phone) || ''
    if (!p) {
      staff.toast('这单没留电话')
      return
    }
    if (typeof wx !== 'undefined' && wx.makePhoneCall) wx.makePhoneCall({ phoneNumber: String(p) })
  }
})

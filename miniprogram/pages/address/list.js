// 收货地址簿（第 24 轮新增）：从购物车「从地址簿选」进来时带 pick=1，点一条即回填
const api = require('../../utils/api.js')
const store = require('../../utils/store.js')
const ui = require('../common/ui.js')

Page({
  data: {
    list: [],
    loading: true,
    loadErr: '',
    pick: false,
    loggedIn: false,
    empty: false,
    online: false
  },

  onLoad(q) {
    this.pick = !!(q && String(q.pick) === '1')
    this.setData({ pick: this.pick })
  },

  onShow() {
    const phone = api.boundPhone && api.boundPhone()
    if (!phone) {
      // 地址簿是挂在手机号上的，没绑号就只能先去登录
      this.setData({ loggedIn: false, loading: false, list: [], empty: true })
      return Promise.resolve([])
    }
    this.setData({ loggedIn: true })
    return api.probe().then((st) => {
      this.setData({ online: !!st.online })
      return this.load()
    })
  },

  load() {
    this.setData({ loading: true, loadErr: '' })
    return api.listAddresses().then((list) => {
      this.setData({ list: list, loading: false, empty: list.length === 0, loadErr: '' })
      return list
    }, (e) => {
      // 第 27 轮 P0-2：失败 ≠ 「还没有收货地址」，给错误卡 + 「重新加载」
      this.setData({ list: [], loading: false, empty: false, loadErr: ui.errText(e) })
      return []
    })
  },

  refresh() {
    return this.load()
  },

  // 错误卡上的「重新加载」：连身份和在线状态一起重新确认
  reload() {
    return this.onShow()
  },

  onPick(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const hit = (this.data.list || []).filter((a) => String(a.id) === id)[0]
    if (!hit) return null
    store.setPickedAddress(hit)
    wx.navigateBack()
    return hit
  },

  onEdit(e) {
    const id = String(e.currentTarget.dataset.id || '')
    wx.navigateTo({ url: '/pages/address/edit?id=' + encodeURIComponent(id) })
  },

  onAdd() {
    wx.navigateTo({ url: '/pages/address/edit' })
  },

  onDefault(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const hit = (this.data.list || []).filter((a) => String(a.id) === id)[0]
    if (!hit || hit.isDefault) return Promise.resolve(null)
    return api.saveAddress({
      id: hit.id,
      contact: hit.contact,
      address: hit.address,
      isDefault: true
    }).then((r) => {
      if (r && r.ok === false) {
        wx.showToast({ title: (r.error || '设置失败'), icon: 'none' })
        return null
      }
      wx.showToast({ title: '已设为默认', icon: 'success' })
      return this.load()
    }, (err) => {
      wx.showToast({ title: ui.errText(err) || '设置失败', icon: 'none' })
      return null
    })
  },

  onDelete(e) {
    const id = String(e.currentTarget.dataset.id || '')
    const hit = (this.data.list || []).filter((a) => String(a.id) === id)[0]
    return new Promise((resolve) => {
      wx.showModal({
        title: '删除这条地址？',
        content: hit ? (hit.contact + ' ' + hit.address) : '',
        success: (r) => resolve(!!r.confirm),
        fail: () => resolve(false)
      })
    }).then((yes) => {
      if (!yes) return null
      return api.deleteAddress(id).then((r) => {
        if (r && r.ok === false) {
          wx.showToast({ title: (r.error || '删除失败'), icon: 'none' })
          return null
        }
        wx.showToast({ title: '已删除', icon: 'success' })
        return this.load()
      }, (err) => {
        wx.showToast({ title: ui.errText(err) || '删除失败', icon: 'none' })
        return null
      })
    })
  },

  goMine() {
    wx.switchTab({ url: '/pages/mine/mine' })
  }
})

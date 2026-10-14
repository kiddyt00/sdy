// 员工「我的」（第 26 轮 / D32）：员工自己的身份卡 + 门店信息 + 切回顾客版 / 退出登录。
// 「切回顾客版」只切本机看的界面（api.setView），不动服务端的角色——老板把角色改成顾客
// 才会真的失去员工权限（那时令牌会被服务端清掉）。
const api = require('../../utils/api.js')
const staff = require('../../utils/staff.js')
const config = require('../../utils/config.js')

Page({
  data: {
    name: '',
    phone: '',
    avatar: '',
    openid: '',
    roleText: '员工',
    shop: { name: '啥都有快送', phone: '', address: '', hours: '' },
    version: '0.5.0'
  },

  onShow() {
    if (!staff.ensureStaff()) return
    const s = api.session() || {}
    this.setData({
      name: api.displayName() || '员工',
      phone: s.phone || '未留手机号',
      avatar: s.avatar || '',
      openid: String(s.openid || '').slice(-6),
      roleText: api.sessionRole() === 'staff' ? '员工（管理后台同权限）' : '顾客'
    })
    api.getSettings().then(
      (v) => {
        const o = v && typeof v === 'object' ? v : {}
        this.setData({
          shop: {
            name: o.name || config.STORE_NAME,
            phone: o.phone || '',
            address: o.address || '',
            hours: o.hours || '07:30 – 22:30'
          }
        })
        return v
      },
      () => null
    )
  },

  // 切回顾客版：本机界面切回去，下次进来就能正常买东西
  switchCustomer() {
    api.setView('customer')
    staff.toast('已切回顾客版')
    setTimeout(() => {
      if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/index/index' })
    }, 500)
  },

  logout() {
    staff.confirm('退出登录', '退出后要重新用微信登录（员工身份由老板在后台设定，不会丢）。').then((ok) => {
      if (!ok) return
      api.clearSession()
      if (typeof wx !== 'undefined' && wx.switchTab) wx.switchTab({ url: '/pages/mine/mine' })
    })
  },
  callShop() {
    const p = this.data.shop.phone
    if (!p) {
      staff.toast('店里还没留电话')
      return
    }
    if (typeof wx !== 'undefined' && wx.makePhoneCall) wx.makePhoneCall({ phoneNumber: String(p) })
  }
})

// 小程序「真机预览 + 上传开发版」命令行工具（第 22 轮）
//
// 为什么需要它：本机是 Linux 桌面且没装微信开发者工具（无 GUI 可用），
// 所以用微信官方的 miniprogram-ci 直接从命令行产出预览二维码 / 上传开发版。
//
// 一次性准备（只需一次，装在仓库外的临时目录，避免污染项目依赖）：
//   mkdir -p /tmp/mpci && cd /tmp/mpci && npm init -y && npm install miniprogram-ci
//
// 用法（在仓库根目录执行）：
//   NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js            # 预览二维码 + 上传开发版
//   NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js preview    # 只出预览二维码
//   NODE_PATH=/tmp/mpci/node_modules node deploy/mp-ci.js upload     # 只上传开发版
//   MP_VERSION=0.2.0 NODE_PATH=... node deploy/mp-ci.js upload       # 指定版本号
//
// 产物：.preview/mp-preview-qr.png（真机预览二维码，微信扫；有效期约 25 分钟，过期重跑）
//
// 两个已知坑（详见 .agent_rules.md 规则 25）：
//   1) 本机 DNS 只给 servicewechat.com 的 IPv6 而无 IPv6 出口 → 报 AggregateError；
//      修法是 /etc/hosts 强制 IPv4：140.207.120.252 servicewechat.com shv6.servicewechat.com
//   2) 上传密钥有 IP 白名单，出口 IP 变动会报 errCode -10008 invalid ip；
//      需在 开发管理 → 开发设置 → 小程序代码上传 → IP白名单 里加当时机器的出口 IP。
//
// 安全：AppID 是公开信息；上传私钥 private.wx*.key 只在本机读取（已 gitignore），本脚本不含任何密钥。

const path = require('path')

const REPO = path.resolve(__dirname, '..')
const APPID = 'wx3f2d2aa52660b80f' // 小程序 AppID（公开信息，同 project.config.json）
const KEY_NAME = 'private.wx3f2d2aa52660b80f.key' // 本机小程序代码上传密钥（gitignore）
const MPCI_HOME = process.env.MPCI_HOME || '/tmp/mpci' // npm i miniprogram-ci 的临时目录

let ci
try {
  ci = require('miniprogram-ci')
} catch (e) {
  ci = require(path.join(MPCI_HOME, 'node_modules', 'miniprogram-ci'))
}

const mode = process.argv[2] || 'all' // all | preview | upload
// 版本号真源 = miniprogram/package.json（避免脚本和包版本号各写一份）
const version = process.env.MP_VERSION || require(path.join(REPO, 'miniprogram/package.json')).version
// 版本描述真源 = 最近一次提交的标题（第 25 轮踩过坑：写死的 desc 忘了跟着改，
// 0.5.0 的包却挂着「第25轮」的说明）。取不到 git 时再退回写死的兜底文案。
function latestCommitSubject() {
  try {
    const { execSync } = require('child_process')
    return execSync('git log -1 --pretty=%s', { cwd: REPO, encoding: 'utf8' }).trim()
  } catch (e) {
    return ''
  }
}
const desc = process.env.MP_DESC || latestCommitSubject() || '啥都有快送小程序开发版'

const project = new ci.Project({
  appid: APPID,
  type: 'miniProgram',
  projectPath: path.join(REPO, 'miniprogram'),
  privateKeyPath: path.join(REPO, KEY_NAME),
  ignores: ['node_modules/**/*']
})

const log = (t) => console.log(new Date().toISOString().slice(11, 19), t)

;(async () => {
  if (mode === 'all' || mode === 'preview') {
    log('生成真机预览二维码…')
    await ci.preview({
      project,
      desc,
      setting: { es6: true, minify: false, urlCheck: true },
      qrcodeFormat: 'image',
      qrcodeOutputDest: path.join(REPO, '.preview/mp-preview-qr.png'),
      onProgressUpdate: () => {}
    })
    log('PREVIEW_OK → .preview/mp-preview-qr.png（有效期约 25 分钟）')
  }

  if (mode === 'all' || mode === 'upload') {
    log('上传开发版 ' + version + ' …')
    const r = await ci.upload({
      project,
      version,
      desc,
      setting: { es6: true, minify: false },
      robot: 1,
      onProgressUpdate: () => {}
    })
    log('UPLOAD_OK ' + JSON.stringify(r))
    log('去 mp.weixin.qq.com → 管理 → 版本管理 → 开发版本，可「选为体验版」')
  }
})().catch((e) => {
  console.error('FAILED:', (e && e.message) || e)
  if (e && e.errCode) console.error('errCode:', e.errCode)
  process.exit(1)
})

#!/usr/bin/env node
// 假微信支付 v3（零依赖 Node，仅本地/验收测试用；不含任何真实凭证）。
//
// 两种调用方式都支持：
//   1) 位置参数（本轮任务原始契约）：
//        node deploy/fake-wxpay.js <port> <keydir> [serverBase]
//   2) 命名参数（父代理/accept-pay.js 冻结的形状）：
//        node deploy/fake-wxpay.js --port=8098 --merchant-key=/tmp/pay/merchant_priv.pem \
//             [--api-v3-key=<32位>] [--mchid=...] [--appid=...] [--notify-url=...] [--keydir=...] \
//             [--host=127.0.0.1] [--fail-notify] [--fail-amount] [--fail-sign]
//
// 启动时：
//   * 缺密钥就在 <keydir> 下生成并落盘（RSA 2048）：
//       wxpay_merchant_priv.pem / wxpay_merchant_pub.pem
//       wxpay_platform_priv.pem / wxpay_platform_pub.pem（PUBLIC KEY）/ wxpay_platform_cert.pem（CERTIFICATE，自签）
//   * 打印一行可直接复制进 env 的 WXPAY_* 配置
//   * 打印一行 FAKE_WXPAY_READY {json}，供脚本取平台证书路径 / APIv3 密钥 / mchid / appid
//
// 所有 /v3/* 端点都用商户公钥校验 Authorization 签名，验不过 → 401 {"code":"SIGN_ERROR"}。
'use strict'

const http = require('http')
const https = require('https')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const DEFAULT_API_V3_KEY = '0123456789abcdef0123456789abcdef' // 恰好 32 字节
const DEFAULT_MCHID = '1900000109'
const DEFAULT_APPID = 'wxfakeappid0000001'
const DEFAULT_SERIAL_NO = 'FAKE-SERIAL-01'
const DEFAULT_PLATFORM_SERIAL = 'FAKE-PLATFORM-SERIAL-01'
const DEFAULT_SERVER_BASE = 'http://127.0.0.1:8093'

// 资源解密后的 AAD（与微信一致：支付 transaction / 退款 refund）
const AAD_PAY = 'transaction'
const AAD_REFUND = 'refund'

// ---------------------------------------------------------------- 命令行

function parseArgs(argv) {
  const cfg = {
    port: 8098,
    host: '127.0.0.1',
    keydir: '',
    merchantKey: '',
    apiV3Key: process.env.WXPAY_API_V3_KEY || DEFAULT_API_V3_KEY,
    mchid: process.env.WXPAY_MCHID || DEFAULT_MCHID,
    appid: process.env.WXPAY_APPID || DEFAULT_APPID,
    serialNo: process.env.WXPAY_SERIAL_NO || DEFAULT_SERIAL_NO,
    notifyUrl: '',
    serverBase: '',
    defaultMode: 'ok',
  }
  const positional = []
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      console.log(HELP)
      process.exit(0)
    } else if (arg === '--fail-notify') {
      cfg.defaultMode = 'fail-notify'
    } else if (arg === '--fail-amount') {
      cfg.defaultMode = 'fail-amount'
    } else if (arg === '--fail-sign') {
      cfg.defaultMode = 'fail-sign'
    } else if (arg.startsWith('--')) {
      const i = arg.indexOf('=')
      if (i < 0) throw new Error('未知参数（需要 --key=value 形式）：' + arg)
      const key = arg.slice(2, i)
      const value = arg.slice(i + 1)
      switch (key) {
        case 'port': cfg.port = Number(value); break
        case 'host': cfg.host = value; break
        case 'keydir': cfg.keydir = value; break
        case 'merchant-key': cfg.merchantKey = value; break
        case 'api-v3-key': cfg.apiV3Key = value; break
        case 'mchid': cfg.mchid = value; break
        case 'appid': cfg.appid = value; break
        case 'serial-no': cfg.serialNo = value; break
        case 'notify-url': cfg.notifyUrl = value; break
        case 'server-base': cfg.serverBase = value; break
        default: throw new Error('未知参数：--' + key)
      }
    } else {
      positional.push(arg)
    }
  }
  // 位置参数：<port> <keydir> [serverBase]
  if (positional.length) {
    if (/^\d+$/.test(positional[0])) cfg.port = Number(positional[0])
    if (positional[1]) cfg.keydir = positional[1]
    if (positional[2]) cfg.serverBase = positional[2]
  }
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) {
    throw new Error('端口不合法：' + cfg.port)
  }
  if (Buffer.byteLength(cfg.apiV3Key, 'utf8') !== 32) {
    throw new Error('APIv3 密钥必须恰好 32 字节，当前 ' + Buffer.byteLength(cfg.apiV3Key, 'utf8') + ' 字节：' + cfg.apiV3Key)
  }
  if (!cfg.keydir) {
    cfg.keydir = cfg.merchantKey ? path.dirname(path.resolve(cfg.merchantKey)) : path.join('/tmp', 'fake-wxpay-keys')
  }
  cfg.keydir = path.resolve(cfg.keydir)
  if (cfg.merchantKey) cfg.merchantKey = path.resolve(cfg.merchantKey)
  if (!cfg.serverBase) cfg.serverBase = DEFAULT_SERVER_BASE
  return cfg
}

const HELP = `用法：
  node deploy/fake-wxpay.js <port> <keydir> [serverBase]
  node deploy/fake-wxpay.js --port=8098 --merchant-key=/tmp/pay/merchant_priv.pem [其它参数]

参数：
  --port=<端口>           默认 8098
  --host=<地址>           默认 127.0.0.1（容器外访问可传 0.0.0.0）
  --keydir=<目录>         平台密钥与（未指定 --merchant-key 时的）商户密钥目录
  --merchant-key=<路径>   商户私钥 PEM；假服务据此 derive 商户公钥验证服务端请求签名。文件不存在会自动生成
  --api-v3-key=<32位>     回调 AES-256-GCM 密钥，默认 ${DEFAULT_API_V3_KEY}
  --mchid=<商户号>        默认 ${DEFAULT_MCHID}
  --appid=<AppID>         默认 ${DEFAULT_APPID}
  --notify-url=<地址>     回调兜底地址（服务端 prepay 时传的 notify_url 优先）
  --server-base=<地址>    回调兜底 serverBase，默认 ${DEFAULT_SERVER_BASE}
  --fail-notify           默认回调模式 fail-notify（服务端会回非 200，用于验证微信重试）
  --fail-amount           默认回调模式 fail-amount（金额改成 1 分）
  --fail-sign             默认回调模式 fail-sign（签名改坏 → 服务端 401）
`

// ---------------------------------------------------------------- DER / 自签证书

// Node 标准库不能直接签发 X.509 证书，这里手写最小 DER 编码器（无扩展项即可被 Go/openssl 解析）。
function derLen(n) {
  if (n < 0x80) return Buffer.from([n])
  const bytes = []
  let x = n
  while (x > 0) { bytes.unshift(x & 0xff); x = Math.floor(x / 256) }
  return Buffer.from([0x80 | bytes.length, ...bytes])
}
function der(tag, content) {
  const body = Buffer.isBuffer(content) ? content : Buffer.concat(content)
  return Buffer.concat([Buffer.from([tag]), derLen(body.length), body])
}
const derSeq = (...parts) => der(0x30, parts)
const derSet = (...parts) => der(0x31, parts)
const derNull = () => der(0x05, Buffer.alloc(0))
const derBitString = (buf) => der(0x03, Buffer.concat([Buffer.from([0]), buf]))
function derInt(buf) {
  let b = buf
  while (b.length > 1 && b[0] === 0) b = b.subarray(1)
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0]), b])
  return der(0x02, b)
}
function derOID(oid) {
  const parts = oid.split('.').map(Number)
  const out = [40 * parts[0] + parts[1]]
  for (let i = 2; i < parts.length; i++) {
    const stack = [parts[i] & 0x7f]
    let v = parts[i] >>> 7
    while (v > 0) { stack.unshift((v & 0x7f) | 0x80); v >>>= 7 }
    out.push(...stack)
  }
  return der(0x06, Buffer.from(out))
}
function derUtcTime(d) {
  const p = (n) => String(n).padStart(2, '0')
  const s = p(d.getUTCFullYear() % 100) + p(d.getUTCMonth() + 1) + p(d.getUTCDate()) +
    p(d.getUTCHours()) + p(d.getUTCMinutes()) + p(d.getUTCSeconds()) + 'Z'
  return der(0x17, Buffer.from(s, 'ascii'))
}
function rdn(oid, value) {
  return derSet(derSeq(derOID(oid), der(0x0c, Buffer.from(value, 'utf8'))))
}
function pemEncode(label, derBuf) {
  const lines = derBuf.toString('base64').match(/.{1,64}/g).join('\n')
  return `-----BEGIN ${label}-----\n${lines}\n-----END ${label}-----\n`
}
// makeSelfSignedCert 用给定密钥对签一张最简 v3 自签证书（CN 可辨识，无扩展项）。
function makeSelfSignedCert(privateKey, publicKey) {
  const sha256RSA = () => derSeq(derOID('1.2.840.113549.1.1.11'), derNull())
  // Name ::= SEQUENCE OF RDN；rdn() 已经返回 Set，这里必须再包一层 SEQUENCE，
  // 否则 issuer/subject 的 DER 不合法，Go 的 x509.ParseCertificate 会直接拒绝。
  const name = derSeq(rdn('2.5.4.3', 'fake wechatpay platform'))
  const now = Date.now()
  const tbs = derSeq(
    der(0xa0, derInt(Buffer.from([2]))), // version v3
    derInt(crypto.randomBytes(8)),       // serialNumber
    sha256RSA(),
    name,
    derSeq(derUtcTime(new Date(now - 86400000)), derUtcTime(new Date(now + 10 * 365 * 86400000))),
    name,
    publicKey.export({ type: 'spki', format: 'der' }),
  )
  const signature = crypto.sign('sha256', tbs, privateKey)
  return pemEncode('CERTIFICATE', derSeq(tbs, sha256RSA(), derBitString(signature)))
}

// ---------------------------------------------------------------- 密钥装载

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}
function readFileIfExists(p) {
  try { return fs.readFileSync(p, 'utf8') } catch (e) { return null }
}
function writeFile(p, content) {
  fs.writeFileSync(p, content, { mode: 0o600 })
}
// merchantPubPathFor：/x/merchant_priv.pem → /x/merchant_pub.pem
function pubPathFor(privPath) {
  return privPath.includes('_priv') ? privPath.replace('_priv', '_pub') : privPath + '.pub.pem'
}
function generateRSA() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  })
  return { privatePem: privateKey, publicPem: publicKey }
}

function loadKeys(cfg, log) {
  ensureDir(cfg.keydir)
  const keys = { generated: [] }

  // ---- 商户密钥 ----
  const merchantKeyPath = cfg.merchantKey || path.join(cfg.keydir, 'wxpay_merchant_priv.pem')
  let merchantPrivPem = readFileIfExists(merchantKeyPath)
  if (!merchantPrivPem) {
    const pair = generateRSA()
    writeFile(merchantKeyPath, pair.privatePem)
    writeFile(pubPathFor(merchantKeyPath), pair.publicPem)
    merchantPrivPem = pair.privatePem
    keys.generated.push(merchantKeyPath, pubPathFor(merchantKeyPath))
  }
  keys.merchantKeyPath = merchantKeyPath
  keys.merchantPubPath = pubPathFor(merchantKeyPath)
  try {
    const priv = crypto.createPrivateKey(merchantPrivPem)
    const pubPem = crypto.createPublicKey(priv).export({ type: 'spki', format: 'pem' })
    keys.merchantPubPem = pubPem
    keys.merchantPub = crypto.createPublicKey(priv)
    if (!fs.existsSync(keys.merchantPubPath)) writeFile(keys.merchantPubPath, pubPem)
  } catch (e) {
    keys.merchantPub = null
    log('⚠️  商户公钥无法从 ' + merchantKeyPath + ' 推导（' + e.message + '）：将**不校验**服务端请求签名，仅记录。')
  }

  // ---- 平台密钥（假微信自己持有，服务端只拿公钥/证书验回调） ----
  const platformPrivPath = path.join(cfg.keydir, 'wxpay_platform_priv.pem')
  const platformPubPath = path.join(cfg.keydir, 'wxpay_platform_pub.pem')
  const platformCertPath = path.join(cfg.keydir, 'wxpay_platform_cert.pem')
  let platformPrivPem = readFileIfExists(platformPrivPath)
  if (!platformPrivPem) {
    const pair = generateRSA()
    writeFile(platformPrivPath, pair.privatePem)
    writeFile(platformPubPath, pair.publicPem)
    platformPrivPem = pair.privatePem
    keys.generated.push(platformPrivPath, platformPubPath)
  }
  keys.platformPriv = crypto.createPrivateKey(platformPrivPem)
  const platformPub = crypto.createPublicKey(keys.platformPriv)
  const platformPubPem = platformPub.export({ type: 'spki', format: 'pem' })
  if (!fs.existsSync(platformPubPath)) writeFile(platformPubPath, platformPubPem)
  keys.platformPubPem = platformPubPem
  keys.platformPrivPath = platformPrivPath
  keys.platformPubPath = platformPubPath
  keys.platformCertPath = platformCertPath
  let certPem = readFileIfExists(platformCertPath)
  if (!certPem || !certPem.includes('BEGIN CERTIFICATE')) {
    certPem = makeSelfSignedCert(keys.platformPriv, platformPub)
    writeFile(platformCertPath, certPem)
    keys.generated.push(platformCertPath)
  }
  keys.platformCertPem = certPem
  return keys
}

// ---------------------------------------------------------------- 签名 / 验签

function parseAuthorization(header) {
  const h = String(header || '').trim()
  const prefix = 'WECHATPAY2-SHA256-RSA2048 '
  if (!h.startsWith(prefix)) return { ok: false, reason: 'Authorization 头缺失或前缀不对' }
  const params = {}
  for (const part of h.slice(prefix.length).split(',')) {
    const i = part.indexOf('=')
    if (i < 0) return { ok: false, reason: 'Authorization 参数格式不对' }
    params[part.slice(0, i).trim()] = part.slice(i + 1).trim().replace(/^"|"$/g, '')
  }
  for (const k of ['mchid', 'nonce_str', 'signature', 'timestamp', 'serial_no']) {
    if (!params[k]) return { ok: false, reason: 'Authorization 缺 ' + k }
  }
  return { ok: true, params }
}

// 签名串 = method\nurlPath（含 query）\ntimestamp\nnonce\nbody\n
function checkAuthorization(method, rawUrl, body, header, merchantPub) {
  const parsed = parseAuthorization(header)
  if (!parsed.ok) return { ok: false, params: {}, reason: parsed.reason, skipped: false }
  if (!merchantPub) return { ok: true, params: parsed.params, reason: 'no merchant key, signature not verified', skipped: true }
  const message = method + '\n' + rawUrl + '\n' + parsed.params.timestamp + '\n' + parsed.params.nonce_str + '\n' + body + '\n'
  let ok = false
  try {
    ok = crypto.verify('sha256', Buffer.from(message, 'utf8'), merchantPub, Buffer.from(parsed.params.signature, 'base64'))
  } catch (e) {
    return { ok: false, params: parsed.params, reason: 'verify threw: ' + e.message, skipped: false }
  }
  return { ok, params: parsed.params, reason: ok ? '' : '签名与商户公钥不匹配', skipped: false }
}

// ---------------------------------------------------------------- 回调组包

function encryptResource(plainText, aad) {
  const key = Buffer.from(cfg.apiV3Key, 'utf8')
  const nonce = crypto.randomBytes(6).toString('hex') // 12 字节 ASCII
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.from(nonce, 'utf8'))
  cipher.setAAD(Buffer.from(aad || '', 'utf8'))
  const enc = Buffer.concat([cipher.update(Buffer.from(plainText, 'utf8')), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    algorithm: 'AEAD_AES_256_GCM',
    ciphertext: Buffer.concat([enc, tag]).toString('base64'),
    nonce,
    associated_data: aad || '',
    original_type: aad === AAD_REFUND ? 'refund' : 'transaction',
  }
}

function buildNotifyBody(eventType, plainObj, aad) {
  return JSON.stringify({
    id: crypto.randomUUID(),
    create_time: new Date().toISOString(),
    event_type: eventType,
    resource_type: 'encrypt-resource',
    summary: eventType === 'REFUND.SUCCESS' ? '退款成功' : '支付成功',
    resource: encryptResource(JSON.stringify(plainObj), aad),
  })
}

function signNotifyHeaders(bodyText, mode) {
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = crypto.randomBytes(8).toString('hex')
  const message = timestamp + '\n' + nonce + '\n' + bodyText + '\n'
  let signature = crypto.sign('sha256', Buffer.from(message, 'utf8'), keys.platformPriv)
  if (mode === 'fail-sign') {
    const broken = Buffer.from(signature)
    broken[0] ^= 0xff // 破坏签名：验签必然失败 → 服务端应回 401
    signature = broken
  }
  return {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'User-Agent': 'fake-wxpay/1.0',
    'Wechatpay-Id': crypto.randomUUID(),
    'Wechatpay-Timestamp': timestamp,
    'Wechatpay-Nonce': nonce,
    'Wechatpay-Signature': signature.toString('base64'),
    'Wechatpay-Serial': DEFAULT_PLATFORM_SERIAL,
    'Wechatpay-Signature-Type': 'WECHATPAY2-SHA256-RSA2048',
  }
}

function postJSON(target, headers, bodyText) {
  return new Promise((resolve) => {
    let u
    try {
      u = new URL(target)
    } catch (e) {
      return resolve({ status: 0, body: '', error: '回调地址不合法：' + target })
    }
    const mod = u.protocol === 'https:' ? https : http
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign({}, headers, { 'Content-Length': Buffer.byteLength(bodyText) }),
      timeout: 10000,
    }, (r) => {
      const chunks = []
      r.on('data', (c) => chunks.push(c))
      r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', (e) => resolve({ status: 0, body: '', error: String(e.message || e) }))
    req.on('timeout', () => { req.destroy(new Error('回调超时')) })
    req.end(bodyText)
  })
}

function parseMaybeJSON(text) {
  try { return JSON.parse(text) } catch (e) { return text }
}

// ---------------------------------------------------------------- 状态

const state = { orders: {}, refunds: {}, requests: [] }
const MAX_REQUESTS = 300
const nowISO = () => new Date().toISOString()

function recordRequest(entry) {
  state.requests.push(entry)
  if (state.requests.length > MAX_REQUESTS) state.requests.splice(0, state.requests.length - MAX_REQUESTS)
}

// ---------------------------------------------------------------- HTTP

function sendJSON(res, status, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
function sendText(res, status, text, type) {
  res.writeHead(status, { 'Content-Type': type || 'text/plain; charset=utf-8', 'Content-Length': Buffer.byteLength(text) })
  res.end(text)
}
function notFound(res) {
  sendJSON(res, 404, { code: 'NOT_FOUND', message: '假服务未实现该端点（测试后门见 --help）' })
}

const cfg = parseArgs(process.argv.slice(2))
const logs = []
function log(msg) { const line = String(msg); logs.push(line); console.log(line) }

const keys = loadKeys(cfg, log)

// ---------------------------------------------------------------- 私有测试接口

function effectiveMode(b) {
  return String(b.mode || cfg.defaultMode || 'ok')
}

async function handlePay(res, rawBody) {
  const b = parseMaybeJSON(rawBody) || {}
  if (typeof b !== 'object') return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '请求体必须是 JSON 对象' })
  const outTradeNo = b.outTradeNo || b.out_trade_no
  if (!outTradeNo) return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '缺少 outTradeNo / out_trade_no' })
  const mode = effectiveMode(b)

  let order = state.orders[outTradeNo]
  if (!order) {
    // 没走过 jsapi 下单也允许直接触发（金额取显式字段，默认 600 分）。
    order = state.orders[outTradeNo] = {
      amountFen: Number(b.total || b.amountFen || 600),
      prepayId: '', openid: b.openid || 'o_fake_openid',
      notifyUrl: b.notifyUrl || '', appid: b.appid || cfg.appid, mchid: cfg.mchid,
      description: '(未经 jsapi 下单，直接触发回调)', queried: false, closed: false, paid: false, createdAt: nowISO(),
    }
  }
  const total = Number(b.total ?? b.amountFen ?? order.amountFen ?? 600)

  // 回调目标：显式 serverBase+notifyPath > 服务端 prepay 时传的 notify_url > --notify-url > serverBase 默认值
  let notifyTarget
  if (b.serverBase) {
    notifyTarget = b.serverBase.replace(/\/+$/, '') + (b.notifyPath || '/api/pay/notify')
  } else if (order.notifyUrl) {
    notifyTarget = order.notifyUrl
  } else if (cfg.notifyUrl) {
    notifyTarget = cfg.notifyUrl
  } else {
    notifyTarget = cfg.serverBase.replace(/\/+$/, '') + '/api/pay/notify'
  }

  const successTime = nowISO()
  const transactionId = order.transactionId || '42000' + outTradeNo
  const plain = {
    mchid: cfg.mchid,
    appid: order.appid || cfg.appid,
    out_trade_no: mode === 'fail-notify' ? outTradeNo + '-NOSUCH' : outTradeNo,
    transaction_id: transactionId,
    trade_state: 'SUCCESS',
    success_time: successTime,
    amount: {
      total: mode === 'fail-amount' ? 1 : total,
      payer_total: total,
      currency: 'CNY',
      payer_currency: 'CNY',
    },
    payer: { openid: order.openid || 'o_fake_openid' },
  }
  const bodyText = buildNotifyBody('TRANSACTION.SUCCESS', plain, AAD_PAY)
  const headers = signNotifyHeaders(bodyText, mode)
  const result = await postJSON(notifyTarget, headers, bodyText)

  if (mode === 'ok') {
    order.paid = true
    order.transactionId = transactionId
    order.successTime = successTime
    order.paidAmountFen = total
  }
  order.lastNotifyMode = mode
  order.lastNotifyStatus = result.status

  sendJSON(res, 200, {
    ok: true,
    notified: result.status !== 0,
    mode,
    outTradeNo,
    notifyTarget,
    httpStatus: result.status,
    respBody: result.body,
    resp: parseMaybeJSON(result.body),
    status: result.status,
    error: result.error,
    note: mode === 'fail-notify'
      ? '回调里的 out_trade_no 故意改成不存在的单，服务端应回 4xx（让微信重试）'
      : (mode === 'fail-amount' ? '回调金额故意改成 1 分，服务端必须拒绝且订单不变'
        : (mode === 'fail-sign' ? '回调签名已破坏，服务端必须回 401' : '')),
  })
}

async function handleRefundNotify(res, rawBody) {
  const b = parseMaybeJSON(rawBody) || {}
  if (typeof b !== 'object') return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '请求体必须是 JSON 对象' })
  let outRefundNo = b.outRefundNo || b.out_refund_no
  const outTradeNo = b.outTradeNo || b.out_trade_no || ''
  if (!outRefundNo && outTradeNo) outRefundNo = 'R' + outTradeNo
  if (!outRefundNo) return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '缺少 outRefundNo / out_refund_no' })
  let mode = effectiveMode(b)
  if (mode === 'fail') mode = 'fail-sign' // 父代理只定义了 ok|fail，fail 默认按「签名坏 → 401」

  let refund = state.refunds[outRefundNo]
  if (!refund) {
    const amount = Number(b.total ?? b.amountFen ?? 600)
    refund = state.refunds[outRefundNo] = {
      amountFen: amount, totalFen: Number(b.orderTotal ?? amount), state: 'PROCESSING',
      refundId: '50000' + outRefundNo, outTradeNo, reason: b.reason || '(直接触发)',
      notifyUrl: b.notifyUrl || '', createdAt: nowISO(), successTime: '',
    }
  }
  const amount = Number(b.total ?? b.amountFen ?? refund.amountFen ?? 600)

  let notifyTarget
  if (b.serverBase) {
    notifyTarget = b.serverBase.replace(/\/+$/, '') + (b.notifyPath || '/api/pay/refund-notify')
  } else if (refund.notifyUrl) {
    notifyTarget = refund.notifyUrl
  } else if (cfg.notifyUrl) {
    notifyTarget = cfg.notifyUrl.replace(/\/notify$/, '/refund-notify')
    if (notifyTarget === cfg.notifyUrl) notifyTarget = cfg.notifyUrl
  } else {
    notifyTarget = cfg.serverBase.replace(/\/+$/, '') + '/api/pay/refund-notify'
  }

  const successTime = nowISO()
  const plain = {
    mchid: cfg.mchid,
    appid: cfg.appid,
    out_trade_no: refund.outTradeNo || outTradeNo,
    out_refund_no: outRefundNo,
    refund_id: refund.refundId || '50000' + outRefundNo,
    refund_status: 'SUCCESS',
    success_time: successTime,
    user_received_account: '支付用户零钱',
    amount: {
      total: refund.totalFen || amount,
      refund: mode === 'fail-amount' ? 1 : amount,
      payer_total: refund.totalFen || amount,
      payer_refund: amount,
      currency: 'CNY',
    },
  }
  const bodyText = buildNotifyBody('REFUND.SUCCESS', plain, AAD_REFUND)
  const headers = signNotifyHeaders(bodyText, mode)
  const result = await postJSON(notifyTarget, headers, bodyText)

  if (mode === 'ok') {
    refund.state = 'SUCCESS'
    refund.successTime = successTime
    refund.refundedFen = amount
  }
  refund.lastNotifyMode = mode
  refund.lastNotifyStatus = result.status

  sendJSON(res, 200, {
    ok: true,
    notified: result.status !== 0,
    mode,
    outRefundNo,
    notifyTarget,
    httpStatus: result.status,
    respBody: result.body,
    resp: parseMaybeJSON(result.body),
    status: result.status,
    error: result.error,
  })
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const c of req) chunks.push(c)
  const rawBody = Buffer.concat(chunks).toString('utf8')
  const u = new URL(req.url, 'http://placeholder')
  const p = u.pathname
  try {
    // ---------- 私有测试接口（不校验签名） ----------
    if (p === '/__pay' && req.method === 'POST') return await handlePay(res, rawBody)
    if (p === '/__refund-notify' && req.method === 'POST') return await handleRefundNotify(res, rawBody)
    if (p === '/__clear' && req.method === 'POST') {
      state.orders = {}; state.refunds = {}; state.requests = []
      return sendJSON(res, 200, { ok: true, cleared: true })
    }
    if (p === '/__state' && req.method === 'GET') {
      return sendJSON(res, 200, {
        orders: state.orders,
        refunds: state.refunds,
        requests: state.requests,
        port: cfg.port,
        mchid: cfg.mchid,
        appid: cfg.appid,
        apiV3Key: cfg.apiV3Key,
        platformCert: keys.platformCertPath,
        platformPub: keys.platformPubPath,
        merchantKey: keys.merchantKeyPath,
        merchantPub: keys.merchantPubPath,
        defaultMode: cfg.defaultMode,
      })
    }
    if (p === '/__pubkey' && req.method === 'GET') {
      // 默认 CERTIFICATE 形状（?format=spki 可拿 PUBLIC KEY PEM）；两种我的 Go 客户端都支持。
      const fmt = u.searchParams.get('format')
      return sendText(res, 200, fmt === 'spki' ? keys.platformPubPem : keys.platformCertPem)
    }
    if (p === '/__merchant_pubkey' && req.method === 'POST') {
      try {
        keys.merchantPub = crypto.createPublicKey(rawBody)
        keys.merchantPubPem = rawBody
        return sendJSON(res, 200, { ok: true, received: true })
      } catch (e) {
        return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '不是合法公钥 PEM：' + e.message })
      }
    }

    // ---------- 真 v3 端点：必须先验签 ----------
    if (!p.startsWith('/v3/')) return notFound(res)

    const auth = checkAuthorization(req.method, req.url, rawBody, req.headers['authorization'], keys.merchantPub)
    recordRequest({
      method: req.method,
      path: p,
      url: req.url,
      query: Object.fromEntries(u.searchParams),
      body: rawBody,
      signatureOk: auth.ok,
      signatureSkipped: !!auth.skipped,
      signatureReason: auth.reason || '',
      timestamp: auth.params.timestamp || '',
      nonceStr: auth.params.nonce_str || '',
      mchid: auth.params.mchid || '',
      serialNo: auth.params.serial_no || '',
      at: nowISO(),
    })
    if (!auth.ok) {
      return sendJSON(res, 401, { code: 'SIGN_ERROR', message: '签名验证失败：' + (auth.reason || '未知') })
    }

    let body = {}
    if (rawBody) {
      try { body = JSON.parse(rawBody) } catch (e) {
        return sendJSON(res, 400, { code: 'PARAM_ERROR', message: '请求体不是合法 JSON' })
      }
    }

    // ---------- 下单 ----------
    if (req.method === 'POST' && p === '/v3/pay/transactions/jsapi') {
      const total = body.amount && body.amount.total
      if (!body.out_trade_no || !Number.isInteger(total) || total <= 0) {
        return sendJSON(res, 400, { code: 'PARAM_ERROR', message: 'out_trade_no 不能为空，amount.total 必须是正整数（分）' })
      }
      const prepayId = 'wxfake' + Date.now().toString(36) + crypto.randomBytes(3).toString('hex')
      state.orders[body.out_trade_no] = Object.assign({}, state.orders[body.out_trade_no], {
        amountFen: total,
        prepayId,
        openid: (body.payer && body.payer.openid) || '',
        notifyUrl: body.notify_url || '',
        appid: body.appid || cfg.appid,
        mchid: body.mchid || cfg.mchid,
        description: body.description || '',
        queried: false,
        closed: false,
        paid: false,
        createdAt: nowISO(),
      })
      return sendJSON(res, 200, { prepay_id: prepayId })
    }

    // ---------- 查单 ----------
    const orderPrefix = '/v3/pay/transactions/out-trade-no/'
    if (req.method === 'GET' && p.startsWith(orderPrefix) && !p.endsWith('/close')) {
      const no = decodeURIComponent(p.slice(orderPrefix.length))
      const order = state.orders[no]
      if (order) order.queried = true
      if (order && order.paid) {
        return sendJSON(res, 200, {
          appid: order.appid || cfg.appid,
          mchid: cfg.mchid,
          out_trade_no: no,
          transaction_id: order.transactionId || '42000' + no,
          trade_type: 'JSAPI',
          trade_state: 'SUCCESS',
          trade_state_desc: '支付成功',
          bank_type: 'OTHERS',
          success_time: order.successTime || nowISO(),
          payer: { openid: order.openid || '' },
          amount: { total: order.paidAmountFen || order.amountFen, payer_total: order.paidAmountFen || order.amountFen, currency: 'CNY', payer_currency: 'CNY' },
        })
      }
      return sendJSON(res, 200, {
        appid: (order && order.appid) || cfg.appid,
        mchid: cfg.mchid,
        out_trade_no: no,
        trade_type: 'JSAPI',
        trade_state: order && order.closed ? 'CLOSED' : 'NOTPAY',
        trade_state_desc: order && order.closed ? '订单已关闭' : '订单未支付',
        amount: { total: order ? order.amountFen : 0, currency: 'CNY' },
      })
    }

    // ---------- 关单 ----------
    if (req.method === 'POST' && p.startsWith(orderPrefix) && p.endsWith('/close')) {
      const no = decodeURIComponent(p.slice(orderPrefix.length, p.length - '/close'.length))
      const order = state.orders[no] || (state.orders[no] = { amountFen: 0, queried: false, closed: false, paid: false })
      order.closed = true
      order.closedAt = nowISO()
      res.writeHead(204)
      return res.end()
    }

    // ---------- 退款 ----------
    if (req.method === 'POST' && p === '/v3/refund/domestic/refunds') {
      const amount = body.amount || {}
      if (!body.out_refund_no || !Number.isInteger(amount.refund) || amount.refund <= 0 || !Number.isInteger(amount.total)) {
        return sendJSON(res, 400, { code: 'PARAM_ERROR', message: 'out_refund_no 不能为空，amount.refund/amount.total 必须是正整数（分）' })
      }
      state.refunds[body.out_refund_no] = Object.assign({}, state.refunds[body.out_refund_no], {
        amountFen: amount.refund,
        totalFen: amount.total,
        state: 'PROCESSING',
        refundId: '50000' + body.out_refund_no,
        outTradeNo: body.out_trade_no || '',
        reason: body.reason || '',
        notifyUrl: body.notify_url || '',
        createdAt: nowISO(),
        successTime: '',
      })
      return sendJSON(res, 200, {
        refund_id: '50000' + body.out_refund_no,
        out_trade_no: body.out_trade_no || '',
        out_refund_no: body.out_refund_no,
        status: 'PROCESSING',
        create_time: nowISO(),
        amount: { refund: amount.refund, total: amount.total, payer_total: amount.total, currency: 'CNY' },
      })
    }

    // ---------- 退款查单 ----------
    const refundPrefix = '/v3/refund/domestic/refunds/'
    if (req.method === 'GET' && p.startsWith(refundPrefix)) {
      const no = decodeURIComponent(p.slice(refundPrefix.length))
      const refund = state.refunds[no]
      if (!refund) return sendJSON(res, 404, { code: 'RESOURCE_NOT_EXISTS', message: '退款单不存在' })
      return sendJSON(res, 200, {
        refund_id: refund.refundId,
        out_trade_no: refund.outTradeNo,
        out_refund_no: no,
        status: refund.state,
        success_time: refund.successTime || undefined,
        create_time: refund.createdAt,
        amount: { refund: refund.amountFen, total: refund.totalFen, payer_total: refund.totalFen, currency: 'CNY' },
      })
    }

    return notFound(res)
  } catch (e) {
    // 任何异常都不让假服务挂掉；把原因回给对方便于排查。
    try {
      sendJSON(res, 500, { code: 'FAKE_INTERNAL_ERROR', message: String(e && e.message || e) })
    } catch (_) { /* ignore */ }
  }
})

server.listen(cfg.port, cfg.host, () => {
  log('fake-wxpay（假微信支付 v3）已启动：http://' + cfg.host + ':' + cfg.port)
  log('密钥目录：' + cfg.keydir + (keys.generated.length ? '（本次新生成：' + keys.generated.join('、') + '）' : '（复用已有密钥）'))
  log('商户公钥验签：' + (keys.merchantPub ? '开启（' + keys.merchantPubPath + '）' : '关闭（没有商户公钥，仅记录）'))
  // ① 可直接复制进 env 的一行（本轮任务原始契约要求的顺序与变量）
  log('WXPAY_MCHID=' + cfg.mchid +
    ' WXPAY_SERIAL_NO=' + cfg.serialNo +
    ' WXPAY_PRIVATE_KEY_PATH=' + keys.merchantKeyPath +
    ' WXPAY_PLATFORM_CERT_PATH=' + keys.platformPubPath +
    ' WXPAY_API_V3_KEY=' + cfg.apiV3Key)
  // ② 指向本假服务所需的补充变量
  log('# 还需（指向本假服务）：WXPAY_API_BASE=http://' + cfg.host + ':' + cfg.port +
    ' WXPAY_APPID=' + cfg.appid +
    ' WXPAY_NOTIFY_URL=' + (cfg.notifyUrl || (cfg.serverBase.replace(/\/+$/, '') + '/api/pay/notify')))
  // ③ 机器可读（父代理/accept-pay.js 取这个）
  log('FAKE_WXPAY_READY ' + JSON.stringify({
    port: cfg.port,
    host: cfg.host,
    apiBase: 'http://' + cfg.host + ':' + cfg.port,
    apiV3Key: cfg.apiV3Key,
    platformCert: keys.platformCertPath,
    platformPub: keys.platformPubPath,
    platformPriv: keys.platformPrivPath,
    platformSerial: DEFAULT_PLATFORM_SERIAL,
    merchantKey: keys.merchantKeyPath,
    merchantPub: keys.merchantPubPath,
    mchid: cfg.mchid,
    appid: cfg.appid,
    serialNo: cfg.serialNo,
    notifyUrl: cfg.notifyUrl || (cfg.serverBase.replace(/\/+$/, '') + '/api/pay/notify'),
    defaultMode: cfg.defaultMode,
    verifySignature: !!keys.merchantPub,
  }))
})

server.on('error', (e) => {
  console.error('假微信支付启动失败：' + (e && e.message || e))
  process.exit(1)
})

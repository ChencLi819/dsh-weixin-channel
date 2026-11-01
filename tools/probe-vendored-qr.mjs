// probe-sdk-qr.mjs —— 用 @wechatbot/wechatbot SDK 真实请求 iLink 扫码接口,
// 并用本仓库自研的 qr.js 把 qrcode_img_content(URL)渲染成 PNG。
// 只读探测:不登录、不保存凭证、不发消息。
import { writeFileSync } from 'node:fs'
import { ILinkApi } from '../vendor/wechatbot/dist/protocol/api.js'
import { HttpClient } from '../vendor/wechatbot/dist/transport/http.js'
import { createLogger } from '../vendor/wechatbot/dist/logger/logger.js'
import { DEFAULT_BASE_URL } from '../vendor/wechatbot/dist/protocol/types.js'
import { encodeMatrix, toPng, toAscii } from '../lib/qr.js'

const logger = createLogger({ level: 'error' })
const http = new HttpClient({ logger })
const api = new ILinkApi(http, 'DSH-WeChat-Channel/0.1')

console.log('请求扫码…')
const qr = await api.getQrCode(DEFAULT_BASE_URL)
console.log('qrcode        :', qr.qrcode)
console.log('qrcode_img_content:', qr.qrcode_img_content)

const url = qr.qrcode_img_content
const m = encodeMatrix(url)
console.log(`\n二维码内容 ${url.length} 字节 → 版本 ${m.version} (${m.size}x${m.size})`)
writeFileSync('tmp-ilink-qr.png', toPng(url, { scale: 8, quiet: 4 }))
console.log('已写出 tmp-ilink-qr.png')
console.log('\n终端预览:')
console.log(toAscii(url, { quiet: 2 }))

// 轮询状态几次(不提交验证码)
for (let i = 0; i < 3; i++) {
  await new Promise((r) => setTimeout(r, 2000))
  const st = await api.pollQrStatus(DEFAULT_BASE_URL, qr.qrcode)
  console.log(`轮询 ${i + 1}: status=${st.status}`)
  if (st.status !== 'wait') break
}

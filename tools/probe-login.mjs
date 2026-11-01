// probe-login.mjs —— 验证真实 iLink 扫码登录链路。
//
// 做四件事(只读,不提交凭证、不发消息):
//   1. 向 iLink 申请二维码
//   2. 用本插件的 qr.js 渲染成 PNG
//   3. 用 OpenCV 解回来,确认扫出来的正是 iLink 给的 URL
//   4. 轮询一次状态接口,确认长轮询通路可用
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ILinkApi } from '../vendor/wechatbot/dist/protocol/api.js'
import { HttpClient } from '../vendor/wechatbot/dist/transport/http.js'
import { createLogger } from '../vendor/wechatbot/dist/logger/logger.js'
import { DEFAULT_BASE_URL } from '../vendor/wechatbot/dist/protocol/types.js'
import { encodeMatrix, toPng } from '../lib/qr.js'

const out = process.argv[2] || 'login-qr-probe.png'
const logger = createLogger({ level: 'error' })
const api = new ILinkApi(new HttpClient({ logger }), 'DSH-WeChat-Channel/0.1')

console.log('1) 申请二维码…')
const qr = await api.getQrCode(DEFAULT_BASE_URL)
if (!qr?.qrcode || !qr?.qrcode_img_content) {
  console.log('   ✗ 服务端没返回完整字段:', JSON.stringify(qr))
  process.exit(1)
}
console.log('   ✓ qrcode =', qr.qrcode)
console.log('   ✓ 内容   =', qr.qrcode_img_content)

console.log('\n2) 渲染二维码…')
const m = encodeMatrix(qr.qrcode_img_content)
writeFileSync(out, toPng(qr.qrcode_img_content, { scale: 8, quiet: 4 }))
console.log(`   ✓ ${qr.qrcode_img_content.length} 字节 → 版本 ${m.version} (${m.size}x${m.size}) → ${out}`)

console.log('\n3) 轮询状态…')
const st = await api.pollQrStatus(DEFAULT_BASE_URL, qr.qrcode)
console.log('   ✓ status =', st.status, st.status === 'wait' ? '(等扫码,符合预期)' : '')

console.log('\n4) 请用 OpenCV 校验这张图能否扫出同一个 URL:')
console.log(`   python -c "import cv2; print(cv2.QRCodeDetector().detectAndDecode(cv2.imread('${out}', cv2.IMREAD_GRAYSCALE))[0])"`)

// 量一下 get_qrcode_status 单次请求到底挂多久。
// 这决定了轮询超时该设多少 —— 设短了会不停超时,而每次超时重试都会换一张
// 新二维码,用户屏幕上那张就一直是过期的。
import { WeChatBot } from '../vendor/wechatbot/dist/index.js'

const bot = new WeChatBot({
  baseUrl: 'https://ilinkai.weixin.qq.com',
  botAgent: 'DSH-WeChat-Channel/0.1',
  storage: 'memory',
  logLevel: 'warn',
})

// 先要一张二维码
const api = bot.api ?? bot.authenticator?.api
const auth = bot.authenticator ?? bot.auth
const target = api ?? auth

if (!target?.getQrCode) {
  console.log('拿不到内部 api 对象,改走 login 钩子')
  const started = Date.now()
  let qrUrl = null
  const p = bot.login({
    force: true,
    callbacks: {
      onQrUrl: (u) => { qrUrl = u; console.log(`  二维码就绪 (+${Date.now() - started}ms)`) },
      onVerifyCode: async () => '',
    },
  })
  await new Promise((r) => setTimeout(r, 4000))
  console.log('  qrUrl:', qrUrl ? qrUrl.slice(0, 80) : '(还没拿到)')
  p.catch(() => {})
} else {
  const qr = await target.getQrCode('https://ilinkai.weixin.qq.com', [])
  console.log('  拿到二维码:', String(qr.qrcode).slice(0, 24))
  for (let i = 1; i <= 3; i++) {
    const t0 = Date.now()
    try {
      const st = await target.pollQrStatus('https://ilinkai.weixin.qq.com', qr.qrcode)
      console.log(`  第 ${i} 次轮询:${Date.now() - t0}ms  状态=${st.status}`)
    } catch (error) {
      console.log(`  第 ${i} 次轮询:${Date.now() - t0}ms  抛错=${error?.name} ${error?.message}`)
    }
  }
}
process.exit(0)

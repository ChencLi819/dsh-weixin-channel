// login.mjs —— 在插件之外跑一次完整的扫码登录,凭证落到插件读取的同一位置。
//
// 为什么要单独跑:扫码时必须有进程在实时轮询 get_qrcode_status,否则用户确认后
// 服务端把 bot_token 发下来也没人接。这个脚本跑完把凭证写进 <stateDir>/sdk/,
// 插件下次加载(或热重载)就会自动登录并开始收消息。
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mergeConfig, stateDirOf, qrDirOf } from '../lib/config.js'
import { createLogger } from '../lib/log.js'
import { createStore } from '../lib/store.js'
import { createClient } from '../lib/client.js'

// 尽量复用 profile 里的配置(和插件看到的保持一致)
const readProfileConfig = () => {
  const file = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
  if (!existsSync(file)) return {}
  const text = readFileSync(file, 'utf8')
  const at = text.indexOf('- id: wechat-channel')
  if (at < 0) return {}
  // 只需要 cwd / stateDir 这类简单标量,做个够用的解析
  const block = text.slice(at, at + 1200)
  const out = {}
  const m = /^\s{4}cwd:\s*(.+)$/m.exec(block)
  if (m) out.cwd = m[1].trim()
  return out
}

const settings = mergeConfig({ ...readProfileConfig(), login: { autoLogin: true } })
const stateDir = stateDirOf(settings)
const qrDir = qrDirOf(settings)
const log = createLogger(stateDir, console)
const store = createStore(stateDir)

mkdirSync(qrDir, { recursive: true })
const readyFile = join(qrDir, 'login-ready.json')

let client
client = createClient({
  settings,
  store,
  log,
  hooks: {
    onQr: (qr) => {
      writeFileSync(readyFile, `${JSON.stringify({
        ready: true,
        qrFile: qr.latest || qr.file,
        qrUrl: qr.url,
        at: qr.at,
      }, null, 2)}\n`)
      console.log(`QR_READY ${qr.latest || qr.file}`)
    },
    onScanned: () => console.log('SCANNED 已扫码,等手机确认…'),
    onExpired: () => console.log('EXPIRED 二维码过期'),
    onVerifyCodeNeeded: (isRetry) => {
      console.log(`VERIFY_CODE_NEEDED retry=${isRetry}`)
      writeFileSync(join(qrDir, 'need-verifycode'), '1')
    },
    onLogin: (creds) => {
      console.log(`LOGIN_OK accountId=${creds?.accountId} userId=${creds?.userId}`)
      store.setMeta('loginCompletedAt', new Date().toISOString())
    },
  },
})

try {
  const creds = await client.login({ force: true })
  console.log(`DONE accountId=${creds?.accountId} userId=${creds?.userId}`)
  try { writeFileSync(readyFile, `${JSON.stringify({ ready: false, done: true, accountId: creds?.accountId, userId: creds?.userId }, null, 2)}\n`) } catch { /* 忽略 */ }
  process.exit(0)
} catch (error) {
  console.log(`LOGIN_FAILED ${error?.message ?? error}`)
  try { writeFileSync(readyFile, `${JSON.stringify({ ready: false, failed: String(error?.message ?? error) }, null, 2)}\n`) } catch { /* 忽略 */ }
  process.exit(1)
}

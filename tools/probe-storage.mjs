// 查 SDK 的 storage 到底指向哪 —— 登录成功了但 sdk 目录是空的。
import { WeChatBot } from '../vendor/wechatbot/dist/index.js'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const stateDir = process.argv[2] ?? join(homedir(), '.dsh', 'wechat-channel')
const storageDir = join(stateDir, 'sdk')

const bot = new WeChatBot({
  baseUrl: 'https://ilinkai.weixin.qq.com',
  botAgent: 'DSH-WeChat-Channel/0.1',
  storage: 'file',
  storageDir,
  logLevel: 'warn',
})

console.log('  期望的 storageDir :', storageDir)

// 探一探 storage 对象
const seen = new Set()
let storage
for (let p = bot; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
  for (const k of Object.getOwnPropertyNames(p)) seen.add(k)
}
console.log('  bot 上的属性:', [...seen].filter((k) => /stor|auth|api|poll/i.test(k)).join(', '))

storage = bot.storage ?? bot.auth?.storage ?? bot.authenticator?.storage
console.log('  bot.storage          :', bot.storage?.constructor?.name)
console.log('  bot.auth.storage     :', bot.auth?.storage?.constructor?.name)
console.log('  bot.authenticator.storage:', bot.authenticator?.storage?.constructor?.name)

const s = storage ?? bot.auth?.storage ?? bot.authenticator?.storage
if (s) {
  console.log('  storage.dir          :', s.dir ?? '(没有 dir 字段)')
  console.log('  storage 上的键:', Object.getOwnPropertyNames(Object.getPrototypeOf(s)).join(', '))
  // 真写一次试试
  await s.set('__probe__', { hello: 'world' })
  console.log('  写探针后 sdk 目录:', existsSync(storageDir) ? readdirSync(storageDir).join(', ') : '(目录不存在)')
  await s.delete('__probe__')
  console.log('  删探针后 sdk 目录:', existsSync(storageDir) ? (readdirSync(storageDir).join(', ') || '(空)') : '(目录不存在)')
} else {
  console.log('  拿不到 storage 对象')
}
process.exit(0)

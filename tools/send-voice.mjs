// 独立验证:不经过 DSH,直接用已存的凭据发一条语音。
//
// 为什么要单独跑:DSH 按插件 id 缓存模块,改了代码不重启拿不到新的,
// 但「SDK 补丁 + 协议字段对不对」这件事跟 DSH 没关系 —— 直接调 SDK 就能验。
// 验过了,重启 DSH 之后插件里那条路自然也是通的。
//
// 只发不收:不启动 poller,免得和正在跑的实例抢同一个账号。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createClient } from '../lib/client.js'
import { DEFAULTS, mergeConfig } from '../lib/config.js'
import { textToSilk } from '../lib/voice.js'

const stateDir = join(homedir(), '.dsh', 'wechat-channel')
const credsFile = join(stateDir, 'sdk', 'credentials.json')
if (!existsSync(credsFile)) {
  console.log('没有凭据,先登录:', credsFile)
  process.exit(1)
}

const settings = mergeConfig(DEFAULTS, {
  stateDir,
  tts: { apiKeyEnv: 'DASHSCOPE_API_KEY', voice: 'Cherry' },
})
const log = {
  info: (m) => console.log('  [info]', m),
  warn: (m) => console.log('  [warn]', m),
  error: (m) => console.log('  [error]', m),
}

const text = process.argv[2] || '喂，这条是语音。能听见吗？'
console.log(`合成:${text}`)

const { silk, durationMs, sampleRate, bitsPerSample } = await textToSilk(text, { settings, log })
console.log(`  SILK ${silk.length} 字节 / ${durationMs}ms`)

const client = createClient({ settings, log, stateDir })
// 不跑 bot.start()(那会开长轮询,和正在跑的实例抢账号)。
// 直接塞凭据 + 把持久化的 context_token 读进来 —— 发消息要用它。
client.bot.setCredentials(JSON.parse(readFileSync(credsFile, 'utf8')))
try {
  await client.bot.contextStore.load()
  console.log('  context_token 已加载')
} catch (e) {
  console.log('  contextStore.load 失败:', e.message)
}

const target = process.argv[3] || 'example_user@im.wechat'
console.log(`发送给 ${target} …`)
try {
  await client.sendVoice(target, silk, durationMs, { sampleRate, bitsPerSample })
  console.log('  ✓ 发出去了')
} catch (error) {
  console.log('  ✗ 失败:', error?.message ?? error)
  process.exitCode = 1
}

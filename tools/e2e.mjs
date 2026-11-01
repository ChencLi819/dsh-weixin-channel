// e2e.mjs —— 端到端集成测试:微信消息进 → DSH 会话 → 助手回复 → 微信出。
// 用假的 client(记录发送)和假的 agents(记录 followup),但用真的 store /
// WeChatSessions / createInbound / createOutbound —— 测的是真实集成逻辑。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
register(new URL('./load-hook.mjs', import.meta.url).href, import.meta.url)

const { createStore } = await import('../lib/store.js')
const { mergeConfig } = await import('../lib/config.js')
const { WeChatSessions } = await import('../lib/session.js')
const { createInbound } = await import('../lib/inbound.js')
const { createOutbound } = await import('../lib/outbound.js')

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`) }
}
const eq = (label, got, want) => ok(label, JSON.stringify(got) === JSON.stringify(want), `实际 ${JSON.stringify(got)} 期望 ${JSON.stringify(want)}`)

const silent = { info() {}, warn() {}, error() {}, log() {} }

function makeWorld(configPatch = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'wechat-e2e-'))
  const settings = mergeConfig({ stateDir, login: { autoLogin: false }, receive: { poll: false }, ...configPatch })
  const store = createStore(stateDir)
  const sent = []
  const followups = []
  const createdSessions = []

  const client = {
    sent,
    async sendText(userId, text) { sent.push({ kind: 'text', userId, text }) },
    async sendFile(userId, buffer, fileName) { sent.push({ kind: 'file', userId, fileName }) },
    async sendTyping() {},
    async stopTyping() {},
    async download() { throw new Error('no media in test') },
  }

  const ctx = { wechatAccountId: 'acct-test' }
  const agents = {
    get: () => undefined,
    async create(options) {
      createdSessions.push(options.sessionId)
      const agent = {
        session: { id: options.sessionId },
        status: 'idle',
        followup(msg) { followups.push({ sessionId: options.sessionId, msg }) },
        async whenIdle() {},
        cancel() {},
      }
      return { agent, dispose: async () => {} }
    },
    async resume() { throw new Error('first run') },
  }

  const sessions = new WeChatSessions({ ctx, agents, settings, log: silent, store })
  const outbound = createOutbound({ settings, log: silent, client, sessions })
  const handleInbound = createInbound({ settings, store, log: silent, sessions, client, stateDir })

  return { stateDir, settings, store, sessions, outbound, handleInbound, sent, followups, createdSessions, client }
}

const msg = (over = {}) => ({
  userId: 'me@wechat',
  text: '你好呀',
  type: 'text',
  timestamp: new Date(),
  images: [], voices: [], files: [], videos: [],
  _contextToken: 'ctx-token-1',
  raw: { message_id: 1001, client_id: 'c-1' },
  ...over,
})

// ═══ 场景 1:本人消息 → 建会话 → 投递 ═══
console.log('\n── 场景 1:本人消息进 → 建会话 → 投递 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')   // 模拟已登录

  await w.handleInbound(msg())

  eq('建了 1 个会话', w.createdSessions.length, 1)
  eq('投递了 1 条消息', w.followups.length, 1)
  const text = w.followups[0]?.msg?.content?.[0]?.text
  eq('消息正文正确', text, '你好呀')
  eq('消息来源标为 user', w.followups[0]?.msg?.source?.kind, 'user')
  eq('context_token 已持久化', w.store.getContext('me@wechat'), 'ctx-token-1')
  eq('message_id 已记入去重', w.store.hasSeen(1001), true)
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 2:重复投递被去重 ═══
console.log('\n── 场景 2:重复投递去重 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  await w.handleInbound(msg())   // 同一条再来一次
  eq('仍然只投递 1 次', w.followups.length, 1)
  await w.handleInbound(msg({ raw: { message_id: 1002 } }))
  eq('新消息能进来', w.followups.length, 2)
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 3:陌生人被拦住(安全边界)═══
console.log('\n── 场景 3:陌生人被拦住 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg({ userId: 'stranger@wechat' }))
  eq('陌生人没建会话', w.createdSessions.length, 0)
  eq('陌生人没投递', w.followups.length, 0)
  eq('陌生人的 token 没被存', w.store.getContext('stranger@wechat'), '')
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 4:助手回复 → 发回微信 ═══
console.log('\n── 场景 4:助手回复 → 发回微信 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  const sessionId = w.createdSessions[0]

  await w.outbound.onSessionEvent(
    { header: { id: sessionId } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '你好！我在呢。' }] } } },
  )
  eq('发出 1 条', w.sent.length, 1)
  eq('发给了对的人', w.sent[0]?.userId, 'me@wechat')
  eq('内容正确', w.sent[0]?.text, '你好！我在呢。')

  // 非 assistant/message 的事件不该触发发送
  await w.outbound.onSessionEvent({ header: { id: sessionId } }, { type: 'turn/end', data: { reason: {} } })
  eq('turn/end 不发送', w.sent.length, 1)

  // 空文本不发送
  await w.outbound.onSessionEvent({ header: { id: sessionId } }, { type: 'assistant/message', data: { message: { content: [] } } })
  eq('空回复不发送', w.sent.length, 1)
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 5:会话 id 确定性 ═══
console.log('\n── 场景 5:会话 id 确定性 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  const first = w.createdSessions[0]
  ok('sessionId 是 uuid 形状', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(first), first)

  // 换一个世界(模拟插件重启),同一个用户应当得到同一个 sessionId
  const w2 = makeWorld()
  w2.store.setMeta('userId', 'me@wechat')
  await w2.handleInbound(msg())
  eq('重启后 sessionId 不变(能 resume 上下文)', w2.createdSessions[0], first)

  // 不同用户 → 不同会话
  const w3 = makeWorld({ allow: { users: ['other@wechat'], selfOnly: false } })
  await w3.handleInbound(msg({ userId: 'other@wechat' }))
  ok('不同用户 → 不同会话', w3.createdSessions[0] !== first)
  rmSync(w.stateDir, { recursive: true, force: true })
  rmSync(w2.stateDir, { recursive: true, force: true })
  rmSync(w3.stateDir, { recursive: true, force: true })
}

// ═══ 场景 6:/new 重置会话 ═══
console.log('\n── 场景 6:/new 重置会话 ──')
{
  const w = makeWorld()
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  const before = w.createdSessions[0]

  await w.handleInbound(msg({ text: '/new', raw: { message_id: 2001 } }))

  ok('重置后换了新 sessionId', w.createdSessions[w.createdSessions.length - 1] !== before)
  eq('重置有回执', w.sent[w.sent.length - 1]?.text, '好，重新开始。')
  eq('重置指令没被投给 agent', w.followups.length, 1)
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 7:长回复被切分 ═══
console.log('\n── 场景 7:长回复切分 ──')
{
  const w = makeWorld({ send: { maxChars: 100 } })
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  const sessionId = w.createdSessions[0]
  const long = '这是一段很长的回复。'.repeat(20)   // 200 字
  await w.outbound.onSessionEvent(
    { header: { id: sessionId } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: long }] } } },
  )
  ok('长回复被切成多条', w.sent.length > 1, `实际 ${w.sent.length} 条`)
  ok('每条都不超限', w.sent.every((s) => s.text.length <= 100))
  rmSync(w.stateDir, { recursive: true, force: true })
}

// ═══ 场景 8:出站顺序不被打乱 ═══
console.log('\n── 场景 8:出站顺序 ──')
{
  const w = makeWorld({ send: { maxChars: 5 } })
  w.store.setMeta('userId', 'me@wechat')
  await w.handleInbound(msg())
  const sessionId = w.createdSessions[0]
  await w.outbound.onSessionEvent(
    { header: { id: sessionId } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'AAAAA。BBBBB。CCCCC。' }] } } },
  )
  const joined = w.sent.map((s) => s.text).join('')
  ok('切分后顺序正确', joined === 'AAAAA。BBBBB。CCCCC。', joined)
  rmSync(w.stateDir, { recursive: true, force: true })
}

console.log(`\n${'─'.repeat(44)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

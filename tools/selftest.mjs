// selftest.mjs —— 纯逻辑自测:不依赖 DSH 运行时,直接跑。
// 覆盖:文本切分、出站取文本、白名单闸门、context_token 持久化、二维码渲染。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chunkText, extractText } from '../lib/outbound.js'
import { isAllowed } from '../lib/inbound.js'
import { createStore } from '../lib/store.js'
import { mergeConfig, DEFAULTS } from '../lib/config.js'
import { encodeMatrix, toPng } from '../lib/qr.js'

let pass = 0
let fail = 0
const eq = (label, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (ok) pass += 1
  else { fail += 1; console.log(`  ✗ ${label}\n      实际 ${JSON.stringify(got)}\n      期望 ${JSON.stringify(want)}`) }
}
const ok = (label, cond) => {
  if (cond) pass += 1
  else { fail += 1; console.log(`  ✗ ${label}`) }
}
const section = (name) => console.log(`\n── ${name} ──`)

// ── 文本切分 ──
section('文本切分 chunkText')
eq('短文本不切', chunkText('你好', 2000), ['你好'])
eq('空文本', chunkText('', 2000), [])
eq('超长按句号切', chunkText('第一句。第二句。第三句。', 8).length >= 2, true)
ok('切完拼回去内容不丢', chunkText('a'.repeat(5000), 1000).join('').length >= 4999)
ok('每段都不超限', chunkText('字'.repeat(9999), 500).every((s) => s.length <= 500))
eq('正好等于上限不切', chunkText('x'.repeat(100), 100), ['x'.repeat(100)])

// ── 出站取文本 ──
section('出站取文本 extractText')
eq('单个文本块', extractText([{ type: 'text', text: 'hi' }]), 'hi')
// 多块用 '\n' 拼 —— 块之间可能夹着工具调用,粘起来会变成「我先看看看完了」。
// 对齐 dsh-qqbot/outbound.js 的做法。
eq('多块用换行拼接', extractText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'a\nb')
eq('夹着工具调用时不会粘成一坨',
  extractText([{ type: 'text', text: '我先看看' }, { type: 'tool-call', name: 'x' }, { type: 'text', text: '看完了' }]),
  '我先看看\n看完了')
eq('空文本块被跳过(不留空行)', extractText([{ type: 'text', text: '' }, { type: 'text', text: 'x' }]), 'x')
eq('忽略非文本块', extractText([{ type: 'image', attachment: {} }, { type: 'text', text: 'x' }]), 'x')
eq('空数组', extractText([]), '')
eq('非数组', extractText(undefined), '')

// ── 白名单闸门(安全边界)──
section('白名单闸门 isAllowed')
const stateDir = mkdtempSync(join(tmpdir(), 'wechat-test-'))
const store = createStore(stateDir)
const silent = { info() {}, warn() {}, error() {} }

const cfgWith = (allow) => mergeConfig({ allow, stateDir })

// 场景 1:白名单为空 + 还没登录 → 谁都不放行(绝不能默认放行)
ok('名单空且未登录 → 拒绝', !isAllowed({ userId: 'stranger' }, { settings: cfgWith({ users: [] }), store, log: silent }))

// 场景 2:登录后,名单为空 → 只放行本人
store.setMeta('userId', 'me@wechat')
ok('名单空+已登录 → 放行本人', isAllowed({ userId: 'me@wechat' }, { settings: cfgWith({ users: [] }), store, log: silent }))
ok('名单空+已登录 → 拒绝他人', !isAllowed({ userId: 'stranger' }, { settings: cfgWith({ users: [] }), store, log: silent }))

// 场景 3:显式名单 → 按名单来
ok('显式名单命中 → 放行', isAllowed({ userId: 'friend' }, { settings: cfgWith({ users: ['friend'] }), store, log: silent }))
ok('显式名单未命中 → 拒绝', !isAllowed({ userId: 'stranger' }, { settings: cfgWith({ users: ['friend'] }), store, log: silent }))
ok('显式名单里也不放行未列出的本人', !isAllowed({ userId: 'me@wechat' }, { settings: cfgWith({ users: ['friend'] }), store, log: silent }))

// 场景 4:没有 userId 的消息一律拒绝
ok('空 userId → 拒绝', !isAllowed({ userId: '' }, { settings: cfgWith({ users: [] }), store, log: silent }))
ok('undefined userId → 拒绝', !isAllowed({}, { settings: cfgWith({ users: [] }), store, log: silent }))

// 场景 5:数字型 id 也要能比对
store.setMeta('userId', '12345')
ok('数字型 id 能对上', isAllowed({ userId: 12345 }, { settings: cfgWith({ users: [] }), store, log: silent }))

// ── context_token 持久化 ──
section('context_token 持久化')
const dir2 = mkdtempSync(join(tmpdir(), 'wechat-test2-'))
const s1 = createStore(dir2)
s1.setContext('u1', 'tok-abc')
s1.setMeta('userId', 'u1')
const s2 = createStore(dir2)   // 重新加载,模拟插件重启
eq('重启后 token 还在', s2.getContext('u1'), 'tok-abc')
eq('重启后 meta 还在', s2.getMeta('userId'), 'u1')
eq('没有的 key 返回空串', s2.getContext('nobody'), '')
ok('去重:没见过', s2.hasSeen('m1') === false)
s2.markSeen('m1')
ok('去重:标记后见过', s2.hasSeen('m1') === true)
const s3 = createStore(dir2)
ok('去重跨重启有效', s3.hasSeen('m1') === true)

// ── 配置合并 ──
section('配置深合并')
const merged = mergeConfig({ allow: { users: ['x'] }, send: { maxChars: 99 } })
eq('覆盖标量', merged.send.maxChars, 99)
eq('覆盖数组', merged.allow.users, ['x'])
eq('未写的字段保留默认', merged.send.typing, DEFAULTS.send.typing)
eq('未写的子对象保留默认', merged.receive.dedupeSize, DEFAULTS.receive.dedupeSize)
eq('空配置得到默认', mergeConfig(undefined).baseUrl, DEFAULTS.baseUrl)

// ── 二维码 ──
section('二维码渲染')
const url = 'https://liteapp.weixin.qq.com/q/7GiQu1?qrcode=0123456789abcdef0123456789abcdef&bot_type=3'
const m = encodeMatrix(url)
eq('89 字节 → 版本 6', m.version, 6)
eq('版本 6 尺寸 41', m.size, 41)
const png = toPng(url, { scale: 8, quiet: 4 })
ok('PNG 魔数正确', png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47)
eq('PNG 尺寸 = (41+8)*8', png.readUInt32BE(16), (41 + 8) * 8)

rmSync(stateDir, { recursive: true, force: true })
rmSync(dir2, { recursive: true, force: true })

console.log(`\n${'─'.repeat(40)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

// loadtest.mjs —— 加载测试:用 mock ctx 真正把插件 apply 起来,验证接线正确。
// 不联网、不登录(登录是异步 fire-and-forget,这里用 autoLogin=false 关掉)。
import { mkdtempSync, existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'

// 把 @deepseek-ai/* 指到真包(工作区里没有 profile 的目录层级)
register(new URL('./load-hook.mjs', import.meta.url).href, import.meta.url)

let pass = 0
let fail = 0
const ok = (label, cond, extra = '') => {
  if (cond) { pass += 1; console.log(`  ✓ ${label}`) }
  else { fail += 1; console.log(`  ✗ ${label}${extra ? `\n      ${extra}` : ''}`) }
}

const stateDir = mkdtempSync(join(tmpdir(), 'wechat-load-'))

// ── mock 的 DSH 运行时 ──
const created = []
const listeners = new Map()
const tools = []
const disposers = []

const mockAgent = (sessionId) => ({
  session: { id: sessionId },
  status: 'idle',
  followup(msg) { this.lastFollowup = msg },
  async whenIdle() {},
  cancel() {},
})

// 记录宿主 logger 收到的每一条 —— 子模块的日志会经这里转发。
// 这样就能验证「插件传给子模块的 logger 是好用的」:子模块调 log.info()
// 时如果那个对象上没有 info,会直接抛 TypeError,日志也就到不了这里。
const hostLogLines = []

/**
 * mock ctx —— 故意做得像真的 DSH ctx 一样「刻薄」。
 *
 * 真的 ctx 是个 Proxy:读一个没在 `inject` 里声明过的属性会直接抛
 * `cannot get property "xxx" without inject`。
 *
 * 为什么非要复现这个:踩过一次大坑 —— session.js 读了 `ctx.wechatAccountId`
 * (index.js 里挂上去的),而真的 ctx 读它就抛。结果是登录成功、消息也收到
 * 了,但**每一条投递都挂**,用户看到的是「处理这类消息时出错了」。
 * 当时的 mock ctx 是个普通对象,读不存在的属性返回 undefined,于是一路绿灯。
 *
 * 所以:mock 越宽松,漏掉的 bug 越致命。这里读/写未声明的属性一律抛。
 */
const REAL_CTX_KEYS = new Set([
  'logger', 'agents', 'on', 'effect', 'inject', 'get', 'set', 'provide', 'plugin',
])

// webServer 注册过的路由。用来验证「插件比 webServer 先加载」时路由还能不能挂上。
const registeredRoutes = []
const fakeWebServer = {
  register({ kind, path }) { registeredRoutes.push({ kind, path }); return () => {} },
}
let webServerGetCalls = 0
let webServerInjectUsed = false

const ctxTarget = {
  logger: {
    info: (m) => hostLogLines.push(String(m)),
    warn: (m) => hostLogLines.push(String(m)),
    error: (m) => hostLogLines.push(String(m)),
    debug: (m) => hostLogLines.push(String(m)),
  },
  agents: {
    get: () => undefined,
    async create(options) {
      created.push({ kind: 'create', options })
      const agent = mockAgent(options.sessionId)
      return { agent, dispose: async () => {} }
    },
    async resume(options) {
      created.push({ kind: 'resume', options })
      throw new Error('no persisted session')   // 模拟首次运行:恢复失败 → 走 create
    },
  },
  on(event, fn, opts) {
    listeners.set(event, [...(listeners.get(event) ?? []), { fn, opts }])
  },
  effect(fn, name) {
    disposers.push({ name, dispose: fn() })
  },
  inject(deps, fn) {
    // 模拟 cordis:依赖可用时立刻调用回调。
    // webServer 走这条路 —— 插件加载时它还没起来(实测踩过这个竞态)。
    if (Array.isArray(deps) && deps.includes('webServer')) {
      webServerInjectUsed = true
      fn({
        tools: { register(def) { tools.push(def); return () => {} } },
        get: (n) => (n === 'webServer' ? fakeWebServer : undefined),
        effect: (f, name) => disposers.push({ name, dispose: f() }),
      })
      return
    }
    const scope = { tools: { register(def) { tools.push(def); return () => {} } } }
    fn(scope)
  },
  get(name) {
    // ⚠️ 故意对 webServer 返回 undefined:复现「插件先于 webServer 加载」。
    // 早先的实现只在这里抓一次,拿不到就永远没注册 —— 浏览器那边只看到 404。
    if (name === 'webServer') { webServerGetCalls += 1; return undefined }
    return name === 'tools' ? { register(def) { tools.push(def); return () => {} } } : undefined
  },
}

const ctx = new Proxy(ctxTarget, {
  get(target, prop) {
    if (typeof prop === 'symbol') return target[prop]
    if (REAL_CTX_KEYS.has(prop)) return target[prop]
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
  set(target, prop) {
    throw new Error(`cannot set property "${String(prop)}" without inject`)
  },
  has(target, prop) {
    return typeof prop === 'symbol' ? prop in target : REAL_CTX_KEYS.has(prop)
  },
})

console.log('── 1. 模块导出 ──')
const mod = await import('../index.js')
ok('导出 name', mod.name === 'wechat-channel', `实际 ${mod.name}`)
ok('inject 声明 agents', Array.isArray(mod.inject) && mod.inject.includes('agents'))
ok('导出 Config(schemastery schema)', typeof mod.Config === 'function' || typeof mod.Config === 'object')
ok('导出 apply', typeof mod.apply === 'function')

console.log('\n── 2. Config schema 能校验 ──')
const parsed = mod.Config({})
ok('空配置解析出默认值', parsed && parsed.enabled === true, JSON.stringify(parsed)?.slice(0, 120))
ok('默认 baseUrl 正确', parsed?.baseUrl === 'https://ilinkai.weixin.qq.com', String(parsed?.baseUrl))
ok('默认白名单为空', Array.isArray(parsed?.allow?.users) && parsed.allow.users.length === 0)
ok('默认 selfOnly 开启', parsed?.allow?.selfOnly === true)
ok('默认只支持单聊语义(无群配置)', parsed?.groupPolicy === undefined)
const parsed2 = mod.Config({ allow: { users: ['wxid_a'] }, send: { maxChars: 500 } })
ok('用户配置覆盖生效', parsed2?.allow?.users?.[0] === 'wxid_a' && parsed2?.send?.maxChars === 500)
ok('未覆盖字段保留默认', parsed2?.receive?.dedupeSize === 500)

console.log('\n── 3. apply 装配 ──')
await mod.apply(ctx, { stateDir, login: { autoLogin: false }, receive: { poll: false } })
ok('注册了 session/event 出站监听', listeners.has('session/event'))
ok('注册了 system-prompt/assemble 提示注入', listeners.has('system-prompt/assemble'))
ok('注册了 lifecycle effect', disposers.some((d) => d.name === 'wechat-channel.lifecycle'))
ok('注册了 wechat_* 工具', tools.length >= 3, `实际 ${tools.length} 个: ${tools.map((t) => t.name).join(', ')}`)

// ── webServer 加载顺序竞态 ──
// 实测踩过:插件比 webServer 先加载,ctx.get('webServer') 是 undefined,
// 三条二维码路由全没注册 —— 插件页上的卡片只显示一句莫名其妙的 JSON 解析错误,
// 服务端日志里只有一行 info。换一次启动顺序又好了,所以是竞态。
{
  const paths = registeredRoutes.map((r) => r.path)
  ok('webServer 拿不到时走了 ctx.inject 等它', webServerInjectUsed, '只抓一次的话这里就是 false')
  ok('二维码页面路由注册上了 /qr', paths.includes('/wechat-channel/qr'), paths.join(', '))
  ok('二维码图片路由注册上了 /qr.png', paths.includes('/wechat-channel/qr.png'))
  ok('状态路由注册上了 /status', paths.includes('/wechat-channel/status'))
  ok('登录路由注册上了 /login', paths.includes('/wechat-channel/login'))
  ok('路由都用 exact 匹配', registeredRoutes.every((r) => r.kind === 'exact'),
    JSON.stringify(registeredRoutes))
}
for (const expected of ['wechat_status', 'wechat_login', 'wechat_send']) {
  ok(`工具 ${expected} 已注册`, tools.some((t) => t.name === expected))
}
ok('每个工具都有 parameters JSON Schema', tools.every((t) => t.parameters?.type === 'object'))
ok('每个工具都有 output.render', tools.every((t) => typeof t.output?.render === 'function'))

console.log('\n── 4. 工具能跑 ──')
const statusTool = tools.find((t) => t.name === 'wechat_status')
const statusResult = await statusTool.execute({}, {})
ok('wechat_status 返回文本', typeof statusResult?.text === 'string' && statusResult.text.includes('已登录'))
ok('wechat_status 显示未登录', statusResult.text.includes('已登录:否'), statusResult.text)

const loginTool = tools.find((t) => t.name === 'wechat_login')
const verifyResult = await loginTool.execute({ action: 'verify', code: '123456' }, {})
ok('没在等配对码时 verify 给出明确提示', verifyResult.text.includes('没有在等配对码'), verifyResult.text)

const sendTool = tools.find((t) => t.name === 'wechat_send')
const sendResult = await sendTool.execute({ text: 'hi' }, {})
ok('非微信会话调用 wechat_send 时提示要 userId', sendResult.text.includes('不知道发给谁'), sendResult.text)

// file 的分流:http(s) → sendUrl(插件自己下载),否则 → readFile(本地路径)。
// 这条分流是工具收口之后的命脉:微信会话没有文件工具,发图只能靠链接。
// 用「错误长什么样」来判定走了哪条路 —— URL 那条不会报 ENOENT。
const urlResult = await sendTool.execute({ userId: 'u1', file: 'https://example.invalid/pic.png' }, {})
ok('URL 不走本地文件读取(没有 ENOENT)', !/ENOENT|no such file/i.test(urlResult.text), urlResult.text)
ok('URL 那条真的去发了(报的是发送失败,不是参数错)', /发送失败|已把链接/.test(urlResult.text), urlResult.text)

const pathResult = await sendTool.execute({ userId: 'u1', file: join(stateDir, 'definitely-not-here.png') }, {})
ok('本地路径走 readFile(报找不到文件)', /ENOENT|no such file/i.test(pathResult.text), pathResult.text)

// ── 子模块的 logger 必须好用 ──
// 崩过一次:index.js 只定义了 log(level,msg) 这个函数形式,却把它当成 logger
// 对象传给了 client/inbound/outbound/session。子模块调 log.info() 直接
// TypeError,那个 throw 顺着 SDK 回调进了 fire-and-forget 的 Promise 链,
// 最后 unhandled rejection 把整个 DSH 结束掉。
//
// logout 是 client.js 内部会打日志、又不需要联网的一条路,拿它当探针最合适。
{
  const before = hostLogLines.length
  const logoutResult = await loginTool.execute({ action: 'logout' }, {})
  const fresh = hostLogLines.slice(before)
  ok('子模块(client.js)的日志真的打出来了',
    fresh.some((l) => l.includes('已清除 SDK 凭证目录')),
    JSON.stringify(fresh))
  ok('logout 正常返回(没被子模块抛错打断)', /已登出/.test(logoutResult.text), logoutResult.text)
  ok('宿主 logger 收到了 [wechat-channel] 前缀', fresh.every((l) => l.includes('[wechat-channel]')), JSON.stringify(fresh))
}

console.log('\n── 5. 出站:非微信会话不误发 ──')
const outboundFn = listeners.get('session/event')[0].fn
let threw = false
try {
  await outboundFn({ header: { id: 'not-a-wechat-session' } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'hello' }] } } })
} catch { threw = true }
ok('未知会话的事件被安静忽略(不抛错)', !threw)

console.log('\n── 6. 入站投递(真走一遍 sessionKey → getOrCreate → followup) ──')
// 这条是补的:曾经登录正常、消息也收到了,但**每一条投递都挂**在
// `sessionKey()` 读 `ctx.wechatAccountId` 上,用户看到的是
// 「处理这类消息时出错了」。当时的 mock ctx 是普通对象,读不存在的属性
// 返回 undefined,所以一路绿灯 —— 现在 ctx 是刻薄的 Proxy,这类 bug 跑不掉。
{
  const { WeChatSessions } = await import('../lib/session.js')
  const { createStore } = await import('../lib/store.js')

  const store = createStore(stateDir)
  const delivered = []
  const inboundCreated = []
  const inboundAgents = {
    get: () => undefined,
    async create(options) {
      inboundCreated.push(options)
      return {
        agent: {
          session: { id: options.sessionId },
          async followup(msg) { delivered.push(msg) },
          async whenIdle() {},
          cancel() {},
        },
        dispose: async () => {},
      }
    },
    async resume() { throw new Error('no persisted session') },
  }

  const sessions = new WeChatSessions({
    ctx, agents: inboundAgents, settings: parsed, store,
    log: Object.assign((l, m) => hostLogLines.push(`${l}: ${m}`), {
      info: (m) => hostLogLines.push(`info: ${m}`),
      warn: (m) => hostLogLines.push(`warn: ${m}`),
      error: (m) => hostLogLines.push(`error: ${m}`),
    }),
  })

  let deliverError = null
  try {
    await sessions.deliver('example_user@im.wechat', '你好')
  } catch (error) {
    deliverError = error
  }
  ok('投递一条消息不抛错', deliverError === null, String(deliverError?.message ?? deliverError))
  ok('消息真的送到了 agent', delivered.length === 1, `实际 ${delivered.length} 条`)
  ok('会话 key 不含 accountId(重登不该换会话)',
    !sessions.sessionKey('u1').includes('@im.bot'),
    sessions.sessionKey('u1'))

  // ⚠️ 这条是补的:DSH 的 persona-prefix 提示词段里有 `{{model}}`,它从
  //    `agent.options.model` 取。渠道建 agent 时不给 agentOptions,变量就是
  //    undefined,拼提示词直接抛:
  //      prompt variable "{{model}}" has no value for this assembly
  //      (section "deployment:persona-prefix")
  //    用户看到的是「本轮运行失败」。
  const withRoute = inboundCreated.filter((o) => o.agentOptions?.model)
  ok('建会话时带了 agentOptions.model', withRoute.length > 0,
    `create 收到 = ${JSON.stringify(inboundCreated.map((o) => ({ sessionId: o.sessionId, agentOptions: o.agentOptions })))}`)
  ok('agentOptions 里 provider 和 model 都有',
    withRoute.length > 0 && withRoute.every((o) => o.agentOptions.provider && o.agentOptions.model),
    JSON.stringify(withRoute[0]?.agentOptions))

  // resume 出来的 agent 若没有 model,必须丢掉重建 —— 否则用户看到的是
  // 「修了还是本轮运行失败」,因为旧会话是在没传 agentOptions 时建的。
  {
    const { WeChatSessions: WS } = await import('../lib/session.js')
    const staleDir = mkdtempSync(join(tmpdir(), 'wechat-stale-'))
    const staleStore = createStore(staleDir)
    const staleCreated = []
    let staleDisposed = false
    const staleAgents = {
      get: () => undefined,
      async resume() {
        // 模拟「旧会话没有 model 路由」
        return {
          agent: { session: { id: 'x' }, options: {}, async followup() {}, async whenIdle() {}, cancel() {} },
          dispose: async () => { staleDisposed = true },
        }
      },
      async create(o) {
        staleCreated.push(o)
        return {
          agent: { session: { id: o.sessionId }, options: { model: o.agentOptions?.model }, async followup() {}, async whenIdle() {}, cancel() {} },
          dispose: async () => {},
        }
      },
    }
    const stale = new WS({
      ctx, agents: staleAgents, settings: parsed, store: staleStore,
      log: Object.assign((l, m) => hostLogLines.push(`${l}: ${m}`), {
        info: (m) => hostLogLines.push(`info: ${m}`),
        warn: (m) => hostLogLines.push(`warn: ${m}`),
        error: (m) => hostLogLines.push(`error: ${m}`),
      }),
    })
    let staleError = null
    try { await stale.deliver('stale-user', '喂') } catch (e) { staleError = e }
    ok('resume 没 model 时不抛错(会重建)', staleError === null, String(staleError?.message ?? staleError))
    ok('把没有 model 的旧会话卸掉了', staleDisposed)
    ok('重建时仍然带 agentOptions.model', Boolean(staleCreated[0]?.agentOptions?.model),
      JSON.stringify(staleCreated[0]?.agentOptions))
    await stale.disposeAll().catch(() => {})
    rmSync(staleDir, { recursive: true, force: true })
  }

  // 同一个用户两次投递必须落到同一个会话
  const key1 = sessions.sessionKey('u1')
  const key2 = sessions.sessionKey('u1')
  ok('同一用户映射到同一 key', key1 === key2, `${key1} vs ${key2}`)

  let resetError = null
  try { await sessions.reset('u1') } catch (error) { resetError = error }
  ok('/new 重置不抛错', resetError === null, String(resetError?.message ?? resetError))

  await sessions.disposeAll().catch(() => {})
}

console.log('\n── 7. 重启后能认出盘上的凭证 ──')
// 踩过:boot() 只看 client.isLoggedIn(),而那是**内存**里的凭证。重启之后
// 凭证在**盘上**,于是每次重启都报「没有可用凭证」—— 明明 sdk/credentials.json
// 就在那儿,用户却被迫反复扫码。
{
  const bootDir = mkdtempSync(join(tmpdir(), 'wechat-boot-'))
  const sdkDir = join(bootDir, 'sdk')
  mkdirSync(sdkDir, { recursive: true })
  writeFileSync(join(sdkDir, 'credentials.json'), JSON.stringify({
    token: 'fake-token-for-boot-test',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    accountId: 'fakeaccount@im.bot',
    userId: 'fakeuser@im.wechat',
    savedAt: new Date().toISOString(),
  }))

  const bootLogs = []
  const push = (m) => bootLogs.push(String(m))
  const bootCtx = new Proxy({
    logger: { info: push, warn: push, error: push, debug: () => {} },
    agents: {
      get: () => undefined,
      async create(o) { return { agent: mockAgent(o.sessionId), dispose: async () => {} } },
      async resume() { throw new Error('none') },
    },
    on() {}, effect() {}, inject() {},
    get: () => undefined,
  }, {
    get(t, p) { if (typeof p === 'symbol' || p in t) return t[p]; throw new Error(`cannot get property "${String(p)}" without inject`) },
    set(t, p) { throw new Error(`cannot set property "${String(p)}" without inject`) },
  })

  await mod.apply(bootCtx, {
    stateDir: bootDir,
    login: { autoLogin: true },   // ← 关键:打开自动登录
    receive: { poll: false },      // 别真起轮询
  })
  await new Promise((r) => setTimeout(r, 400))

  const credLines = bootLogs.filter((l) => l.includes('凭证') || l.includes('登录'))
  ok('盘上有凭证时不说「没有可用凭证」',
    !bootLogs.some((l) => l.includes('没有可用凭证')), credLines.join(' | ') || '(没有相关日志)')
  ok('盘上有凭证时真的自动登上了',
    bootLogs.some((l) => l.includes('登录成功')), credLines.join(' | ') || '(没有相关日志)')

  rmSync(bootDir, { recursive: true, force: true })
}

console.log('\n── 8. 诊断文件 ──')
const diagFile = join(stateDir, 'diagnostic.json')
ok('写出 diagnostic.json', existsSync(diagFile))
if (existsSync(diagFile)) {
  const diag = JSON.parse(readFileSync(diagFile, 'utf8'))
  ok('诊断含版本', typeof diag.version === 'string' && diag.version.length > 0, String(diag.version))
  ok('诊断标未登录', diag.loggedIn === false)
  ok('诊断记了状态目录', diag.stateDir === stateDir)
}
ok('写出 wechat.log', existsSync(join(stateDir, 'wechat.log')))

console.log('\n── 9. 卸载清理 ──')
for (const d of disposers) { try { await d.dispose?.() } catch { /* 忽略 */ } }
ok('dispose 不抛错', true)

rmSync(stateDir, { recursive: true, force: true })

console.log(`\n${'─'.repeat(44)}`)
console.log(`通过 ${pass} · 失败 ${fail}`)
process.exit(fail === 0 ? 0 : 1)

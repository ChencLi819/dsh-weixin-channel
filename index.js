// ENTRY_VERSION = '0.1.0+34'
// dsh-weixin-channel —— 把 agent 接进微信(单聊)。
//
// 走的是腾讯官方 iLink Bot API(不是客户端逆向):扫码授权出一个「机器人身份」,
// 然后长轮询收消息、按 context_token 回消息。协议实现内置在 vendor/wechatbot
// (MIT,零运行时依赖),所以这个插件不联网装包、也不依赖 OpenClaw。
//
// 安全边界:
//   · 只放行白名单,名单为空时退化成「只放行登录者本人」—— 绝不默认放行所有人;
//   · 只支持单聊(微信机器人协议本身就没有群);
//   · 工具权限不在这里放开,靠 DSH 的会话/预设配置收口。
//
// 三个接线点:
//   1. 入站:长轮询 → 白名单 → 落盘 → 投给 DSH 会话;
//   2. 出站:ctx.on('session/event') → 按 sessionId 反查微信会话 → 发回微信;
//   3. 工具:wechat_login / wechat_status / wechat_send。
import Schema from '@deepseek-ai/schemastery'
import { mergeConfig, stateDirOf, qrDirOf, DEFAULT_PROMPT, LIB_VERSION } from './lib/config.js'
import { createLogger } from './lib/log.js'
import { createStore } from './lib/store.js'
import { createClient } from './lib/client.js'
import { WeChatSessions } from './lib/session.js'
import { createInbound, selftestAttachments } from './lib/inbound.js'
import { createOutbound } from './lib/outbound.js'
import { createQrPage } from './lib/qr-page.js'
import { resolveModel } from './lib/model.js'
import { join } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

export const name = 'wechat-channel'
export const inject = ['agents']

export const Config = Schema.object({
  enabled: Schema.boolean().default(true).description('是否启用微信渠道'),
  stateDir: Schema.string().default('').description('状态目录(默认 ~/.dsh/wechat-channel)'),
  baseUrl: Schema.string().default('https://ilinkai.weixin.qq.com').description('iLink Bot API 基址'),
  botAgent: Schema.string().default('dsh-weixin-channel/0.1').description('调用方标识'),
  cwd: Schema.string().default('').description('微信会话的工作目录(默认继承进程)'),
  login: Schema.object({
    autoLogin: Schema.boolean().default(true).description('启动时用已有凭证自动登录'),
    qrDir: Schema.string().default('').description('二维码落盘目录'),
    qrScale: Schema.number().default(8).description('二维码每模块像素'),
    qrQuiet: Schema.number().default(4).description('二维码静默区模块数'),
    timeoutMs: Schema.number().default(180_000).description('扫码等待超时(ms)'),
    expiredCooldownMs: Schema.number().default(3_600_000).description('会话过期后的冷却时间(ms)'),
  }).default({}),
  allow: Schema.object({
    users: Schema.array(Schema.string()).default([]).description('白名单微信 user id'),
    selfOnly: Schema.boolean().default(true).description('只放行登录者本人'),
    silentDrop: Schema.boolean().default(true).description('丢弃非白名单消息时不打日志'),
  }).default({}),
  session: Schema.object({
    prefix: Schema.string().default('wechat').description('会话 key 前缀'),
    resetCommand: Schema.string().default('/new').description('重置会话的指令(留空则关闭)'),
    preset: Schema.string().default('wechat').description('agent preset id —— 决定这个会话挂哪些插件,也就决定了工具面;留空 = 宿主默认(工具全开)'),
  }).default({}),
  model: Schema.object({
    provider: Schema.string().default('').description('微信会话用的 provider;留空则问宿主(agentDefaultModel),再退回兜底'),
    model: Schema.string().default('').description('微信会话用的 model id;留空则同上'),
  }).default({}),
  tts: Schema.object({
    apiKeyEnv: Schema.string().default('DASHSCOPE_API_KEY')
      .description('从环境变量或 ~/.dsh/.credentials.yaml 里找这个 key 名'),
    apiKey: Schema.string().default('').description('直接给 key(留空则按 apiKeyEnv 找)'),
    baseURL: Schema.string().default('').description('TTS 接口地址(留空 = 阿里云百炼)'),
    model: Schema.string().default('qwen3-tts-flash').description('TTS 模型'),
    voice: Schema.string().default('Cherry').description('音色'),
    timeoutMs: Schema.number().default(60_000).description('TTS 超时(ms)'),
  }).default({}),
  send: Schema.object({
    maxChars: Schema.number().default(2000).description('单条文本上限'),
    typing: Schema.boolean().default(true).description('发送前显示「正在输入」'),
    maxPerMinute: Schema.number().default(12).description('出站限流(条/分钟,0=不限)'),
  }).default({}),
  receive: Schema.object({
    poll: Schema.boolean().default(true).description('是否开启长轮询收消息'),
    dedupeSize: Schema.number().default(500).description('去重窗口大小'),
  }).default({}),
  tools: Schema.object({
    enabled: Schema.boolean().default(true).description('是否注册 wechat_* 工具'),
    restrict: Schema.boolean().default(true).description('工具收口:把微信会话能看到的工具限制成 allow 里那几个'),
    allow: Schema.array(Schema.string()).default(['wechat_login', 'wechat_status', 'wechat_send'])
      .description('收口后只保留这些全局工具;空数组 = 一个都不留(纯聊天)'),
    deny: Schema.array(Schema.string()).default([]).description('在 allow 之外再排除这些'),
  }).default({}),
  promptEnabled: Schema.boolean().default(true).description('是否注入微信场景提示'),
  promptText: Schema.string().default('').description('自定义场景提示(留空用默认)'),
})

const TEXT_OUTPUT = {
  schema: {
    type: 'object',
    properties: { text: { type: 'string' } },
    required: ['text'],
    additionalProperties: false,
  },
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

const sessionIdOf = (exec) => {
  try {
    return String(exec?.agent?.session?.id ?? exec?.agent?.id ?? '')
  } catch {
    return ''
  }
}

export function apply(ctx, config = {}) {
  const settings = mergeConfig(config)
  const stateDir = stateDirOf(settings)
  const fileLog = createLogger(stateDir, ctx.logger ?? console)
  /**
   * 日志:两种调用风格**都要支持**。
   *
   *   log('info', '消息')    —— index.js 自己习惯写成函数调用
   *   log.info('消息')       —— 子模块(client/inbound/outbound/session)收的是对象
   *
   * ⚠️ 这里踩过一次大的:早先只定义了函数形式,然后把 `log` 传给了子模块,
   *    于是 `log.info(...)` 全是 undefined。renderQr 写完二维码后调 log.info
   *    抛 TypeError → 顺着 SDK 回调让 client.login() 拒绝 → 落进
   *    wechat_login 的 .catch() → 那里又调 log.error → 再抛一次 →
   *    变成 unhandled rejection,Node 24 默认直接**结束进程**,整个 DSH 崩掉。
   *
   *    所以现在两种形式都挂上,传下去也安全;index.js 里无论写哪种都不会炸。
   */
  const log = (level, message) => fileLog.log(level, message)
  log.info = (message) => fileLog.info(message)
  log.warn = (message) => fileLog.warn(message)
  log.error = (message) => fileLog.error(message)
  log.file = fileLog.file

  if (settings.enabled === false) {
    log('info', '插件已停用(enabled: false)')
    return
  }

  const agents = ctx.agents
  if (!agents?.create) {
    log('error', 'agents 服务不可用(DSH 版本不匹配?),微信渠道没起来')
    return
  }

  const store = createStore(stateDir)
  const sessions = new WeChatSessions({ ctx, agents, settings, log, store })

  // ── 体检文件:桌面版看不到 stdout 时,看这个就知道插件起没起、登没登、收到几条 ──
  const diagnostics = {
    version: LIB_VERSION,
    startedAt: new Date().toISOString(),
    stateDir,
    loggedIn: false,
    running: false,
    accountId: '',
    selfUserId: '',
    qrFile: '',
    received: 0,
    sent: 0,
    lastError: '',
    allowedUsers: [],
    scanned: false,
    qrPageUrl: '',
    modelRoute: '',
    preset: settings.session.preset || '(宿主默认)',
    presetAvailable: null,
    toolRestriction: settings.tools.restrict
      ? `只保留 [${(settings.tools.allow ?? []).join(', ') || '(空,纯聊天)'}]${(settings.tools.deny ?? []).length ? ` 排除 [${settings.tools.deny.join(', ')}]` : ''}`
      : '(关闭:工具全开)',
    toolRestrictionAvailable: null,
    attachmentsAvailable: null,
  }
  const diagFile = join(stateDir, 'diagnostic.json')
  const writeDiagnostics = () => {
    try {
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(diagFile, `${JSON.stringify({ ...diagnostics, updatedAt: new Date().toISOString() }, null, 2)}\n`)
    } catch { /* 写不动就算了 */ }
  }

  const client = createClient({
    settings,
    store,
    log,
    hooks: {
      onLogin: (creds) => {
        diagnostics.loggedIn = true
        diagnostics.scanned = false
        diagnostics.lastError = ''
        diagnostics.accountId = creds?.accountId ?? ''
        diagnostics.selfUserId = creds?.userId ?? ''
        // ⚠️ 不要把值挂在 ctx 上。
        //    DSH 的 ctx 是 Proxy,读一个没在 inject 里声明过的属性会直接抛
        //    `cannot get property "xxx" without inject` —— 踩过:登录正常、
        //    消息也收到了,但每一条投递都挂在读取处,用户看到的是
        //    「处理这类消息时出错了」。跨模块传值一律走 store。
        writeDiagnostics()
      },
      onSessionExpired: () => {
        diagnostics.loggedIn = false
        diagnostics.lastError = '会话过期(-14),需要重新扫码'
        writeDiagnostics()
      },
      onReloginExhausted: ({ consecutive } = {}) => {
        // 熔断之后不能再装作「还在重试」—— 轮询已经停了,消息收不到。
        diagnostics.loggedIn = false
        diagnostics.running = false
        diagnostics.lastError =
          `自动重登连续失败 ${consecutive ?? '?'} 次,已停止重试。需要重新扫码(打开 ${qrPageUrl ?? 'wechat_login'} 生成新码)`
        writeDiagnostics()
      },
      onScanned: () => {
        diagnostics.scanned = true
        writeDiagnostics()
      },
      onQr: (qr) => {
        diagnostics.qrFile = qr?.latest ?? ''
        // 新二维码来了 = 之前扫的那张作废,状态回到「等扫码」
        diagnostics.scanned = false
        diagnostics.lastError = ''
        writeDiagnostics()
      },
    },
  })

  /**
   * 发起一次登录(不 await —— 要等用户扫码,可能好几分钟)。
   *
   * 抽出来是因为两个入口都要用它:wechat_login 工具,和实时二维码页面上的
   * 「重新生成二维码」按钮。
   */
  const startLogin = () => {
    void client.login({ force: true })
      .then(() => client.start())
      .then(() => {
        diagnostics.running = true
        writeDiagnostics()
        log('info', '扫码登录完成,已开始收消息')
      })
      .catch((error) => {
        diagnostics.lastError = String(error?.message ?? error)
        diagnostics.running = false
        writeDiagnostics()
        log.error(`登录失败:${error?.stack ?? error}`)
      })
      // ⚠️ 最后这一层是保命的。上面那个 .catch 处理器自己抛错的话,会产生
      //    新的 rejected promise;没人接就是 unhandled rejection,Node 24
      //    默认**直接结束进程** —— 真崩过一次 DSH,原因就是 .catch 里调了
      //    一个不存在的 log.error。任何 fire-and-forget 的链都必须以
      //    一个「什么都不会抛」的 catch 收尾。
      .catch(() => { /* 绝不能再抛 */ })
  }

  /**
   * 实时二维码页面(可选,依赖 DSH 的 webServer 服务)。
   *
   * 为什么值得单独做:扫码要的是「一张**当前有效**的图」。服务端会换码,
   * 聊天里贴的静态图从贴出去那一刻就在变旧 —— 而且轮询超时后的重试还会
   * 再换一张。页面自己盯着 /status 和 /qr.png,变了才换图,所以永远是新的。
   */
  let qrPageUrl = null
  let qrPage = { dispose: () => {} }

  const mountQrPage = (sctx) => {
    let webServer
    let webStartup
    try { webServer = sctx.get?.('webServer') } catch { webServer = undefined }
    try { webStartup = sctx.get?.('webStartup') } catch { webStartup = undefined }
    if (!webServer?.register) {
      log.warn('webServer 拿到了但没有 register —— 实时二维码页面没注册')
      return
    }
    try {
      qrPage = createQrPage({
        webServer, webStartup, settings, log, stateDir,
        qrDir: qrDirOf(settings),
        client,
        getStatus: () => ({
          loggedIn: diagnostics.loggedIn,
          qrReady: Boolean(client.lastQr),
          scanned: Boolean(diagnostics.scanned),
          userId: diagnostics.selfUserId || store.getMeta('userId') || '',
          error: diagnostics.lastError || '',
          qrAt: client.lastQr?.at ?? '',
        }),
        startLogin,
      })
      qrPageUrl = qrPage.url
      diagnostics.qrPageUrl = qrPageUrl
      // 不在这里再打一行:qr-page.js 里已经打过「实时二维码页面已注册」了
    } catch (error) {
      log.warn(`实时二维码页面注册失败:${error?.message ?? error}(不影响 wechat_login)`)
    }
  }

  // ⚠️ 这里**不能只抓一次**。
  //
  // webServer 是另一个插件提供的,加载顺序不保证 —— 实测踩过:插件先加载时
  // `ctx.get('webServer')` 是 undefined,三条路由全没注册,浏览器那边只看到
  // 404(而且卡片上只显示一句莫名其妙的 JSON 解析错误)。换一次启动顺序又好了,
  // 所以是竞态不是配置问题。
  //
  // ctx.inject 会在服务出现时才回调,顺序就无所谓了。
  let webServerReady = false
  try { webServerReady = Boolean(ctx.get?.('webServer')?.register) } catch { webServerReady = false }
  if (webServerReady) {
    mountQrPage(ctx)
  } else {
    log.info('webServer 还没就绪 —— 等它起来再注册二维码页面')
    try {
      ctx.inject(['webServer'], (sctx) => {
        mountQrPage(sctx)
        // 卸载时把路由摘掉,不然热重载会留下重复路由
        sctx.effect?.(() => () => { try { qrPage.dispose() } catch { /* 已停 */ } })
      })
    } catch (error) {
      log.warn(`等 webServer 失败:${error?.message ?? error} —— 二维码页面没注册`)
    }
  }

  const outbound = createOutbound({
    settings, log, client, sessions,
    // 计数。之前 diagnostics.sent 从头到尾没人加过 —— wechat_status 永远
    // 报「发出 0 条」,明明发出去好几条。状态工具报假数是会误导排查的。
    onSent: () => { diagnostics.sent += 1; writeDiagnostics() },
  })

  /**
   * DSH 的 attachments 服务(可选)。
   *
   * 有它,入站图片就变成一个原生图片块直接进模型视野 —— 不依赖任何工具。
   * 这点在工具收口之后尤其重要:微信会话没有文件工具,「落盘 + 正文写路径」
   * 那条路等于图发进来模型看不见。
   *
   * 用 get 而不是 inject:服务可能没装,拿不到就回落到路径写法,不该因为
   * 缺一个可选服务就让整个渠道起不来。
   */
  let attachments
  try { attachments = ctx.get?.('attachments') } catch { attachments = undefined }
  diagnostics.attachmentsAvailable = Boolean(attachments?.saveImage)
  if (attachments?.saveImage) {
    log('info', 'attachments 服务可用:入站图片会直接进模型视野')
  } else {
    log('info', 'attachments 服务不可用:入站图片走落盘 + 正文写路径(需要文件工具才能读)')
  }

  const handleInbound = createInbound({
    settings, store, log, sessions, client, stateDir, attachments,
    onDelivered: () => { diagnostics.received += 1; writeDiagnostics() },
  })

  // ── 出站接线 ──
  ctx.on('session/event', (session, event) => {
    void outbound.onSessionEvent(session, event)
      .catch((error) => { log.error(`出站处理失败:${error?.stack ?? error}`) })
      .catch(() => { /* 上面的处理器自己抛错也不能变成 unhandled rejection */ })
  })

  // ── 场景提示注入 ──
  if (settings.promptEnabled !== false) {
    const text = settings.promptText || DEFAULT_PROMPT
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = await next()
      const sessionId = context?.agent?.session?.id ?? context?.agent?.id
      if (!sessionId || !sessions.findBySessionId(sessionId)) return assembled
      return {
        ...assembled,
        sections: [...(assembled?.sections ?? []), { name: 'wechat-channel:prompt', order: 90, text }],
      }
    })
  }

  // ── 工具 ──
  if (settings.tools.enabled !== false) {
    ctx.inject(['tools'], (scope) => {
      const tools = scope.tools
      if (!tools?.register) {
        log('warn', 'tools 服务不可用,wechat_* 工具没注册')
        return
      }

      tools.register({
        name: 'wechat_status',
        description: '看微信渠道的状态:登录没有、二维码在哪、收到/发出多少条、白名单是谁。'
          + '用户问「微信连上了吗」时用。selftest=true 会**真的建一次会话**来验证工具收口'
          + '(会给出权威结论:哪些工具名有效、哪些不存在),平时不用开。',
        parameters: {
          type: 'object',
          properties: {
            selftest: {
              type: 'boolean',
              description: '真的建一次会话,验证工具收口名单是否有效(默认 false)',
            },
          },
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args) {
          // ── 自检:把会话真的建起来,好让 restrict() 跑一遍 ──
          //
          // 为什么需要它:工具名单是否有效,只有 restrict() 自己知道(它算的
          // scope 才作数,别处拿 tools.view(undefined) 拿到的是另一张表)。
          // 而 restrict() 只在建会话时跑 —— 也就是要等到有人在微信里说话。
          //
          // 这里主动建一次:不调 followup,所以**不会给对方发任何东西**,
          // 只是让收口真的装上、结论落进 store。
          let selftestLine = ''
          if (args?.selftest) {
            const selfId = settings.allow.users[0] || store.getMeta('userId')
            if (!selfId) {
              selftestLine = '自检:跳过(还不知道本人 userId,先扫码登录)'
            } else {
              try {
                const record = await sessions.getOrCreate(selfId)
                selftestLine = `自检:会话已建立(${record?.sessionId ?? '?'}),收口已生效 —— 详见下面一行`

                // 再探一层:这个 agent **实际**能看到哪些工具?
                //
                // 为什么值得探:restrict 只过滤「全局工具」,而有些工具(实测
                // web_search / web_fetch / read / glob / grep / schedule_* 等)
                // 压根不在这个 scope 的可收口清单里 —— 说明它们要么本来就不可见,
                // 要么不受 allow 约束。两种情况的处理方式完全不同,不能靠猜。
                try {
                  const agentCtx = record?.agent?.ctx
                  const at = agentCtx?.get?.('tools')
                  const names = ['web_search', 'web_fetch', 'read', 'glob', 'grep',
                    'schedule_create', 'todo_write', 'skill', 'pwsh', 'write', 'edit',
                    'wechat_send', 'mood_now', 'feed_scroll']
                  const seen = []
                  const missing = []
                  for (const n of names) {
                    let hit
                    try { hit = at?.get?.(n, agentCtx) ?? at?.get?.(n) } catch { hit = undefined }
                    if (hit) seen.push(n); else missing.push(n)
                  }
                  selftestLine += `\n  agent 视角:可见 [${seen.join(', ') || '无'}]`
                    + ` / 不可见 [${missing.join(', ') || '无'}]`
                } catch (probeError) {
                  selftestLine += `\n  agent 视角探测失败:${probeError?.message ?? probeError}`
                }
              } catch (error) {
                selftestLine = `自检:建会话失败 ${error?.message ?? error}`
              }

              // 再验一条:入站图片 → attachments 原生图片块。
              //
              // 这是入站图片**唯一**的通路 —— 收口之后微信会话没有文件工具,
              // 图片要是只落了路径没变成原生块,模型就完全看不见那张图,而现象
              // 是「她收到了图但答非所问」,很难联想到是这条路断了。
              // 用一张 1x1 PNG,不碰网络也不碰微信,随时能跑。
              try {
                const probe = await selftestAttachments(attachments, {
                  info: (m) => log('info', `[自检] ${m}`),
                  warn: (m) => log('warn', `[自检] ${m}`),
                })
                selftestLine += probe.ok
                  ? `\n  入站图片通路:✓ attachments 收下了(引用 ${JSON.stringify(probe.ref)?.slice(0, 120)})`
                  : `\n  入站图片通路:✗ ${probe.reason}`
              } catch (probeError) {
                selftestLine += `\n  入站图片通路:✗ ${probeError?.message ?? probeError}`
              }
            }
          }

          const creds = client.credentials
          const qr = client.lastQr
          // 三个状态要分清,不然重启后会误报「未登录」:
          //   内存里有凭证  → 这次进程已经登录
          //   盘上有凭证    → 登录过,重启后 autoLogin 会用
          //   两样都没有    → 真没登录,要扫码
          const inMemory = Boolean(creds)
          const onDisk = client.hasStoredCredentials?.() ?? false
          const loginLine = inMemory
            ? '已登录:是'
            : onDisk
              ? '已登录:否(盘上有凭证,下次启动会自动登录;也可以现在 start)'
              : '已登录:否(没有凭证,需要扫码)'
          const lines = [
            loginLine,
            creds ? `账号:${creds.accountId ?? '?'} · 本人:${creds.userId ?? '?'}` : '',
            `收消息:${client.isRunning ? '进行中' : '已停止'}`,
            `收到 ${diagnostics.received} 条 · 发出 ${diagnostics.sent} 条 · 状态目录 ${stateDir}`,
            qr ? `最近二维码:${qr.latest || qr.file || '(没落盘)'}` : '',
            `白名单:${(settings.allow.users.length ? settings.allow.users : [store.getMeta('userId') || '(登录后自动确定)']).join(', ')}`,
            `工具收口 preset:${diagnostics.preset}${diagnostics.presetAvailable === false ? '(不可用!当前工具面没收窄)' : ''}`,
            `工具面:${diagnostics.toolRestriction}`,
            `模型路由:${diagnostics.modelRoute || '(还没建过会话)'}`,
            // 名单校验 —— 按需查,拿到的永远是**当前**完整的工具表。
            //
            // 为什么放这儿而不是启动时:boot() 跑的时候别的插件还没加载完,
            // 那时候查会把正常名字误报成未知(试过,误报 16 个)。这个工具是
            // 人/模型主动调的,那时插件早就就位了。
            toolNamesReport(),
            selftestLine,
          ]
          return { text: lines.filter(Boolean).join('\n') }
        },
      })

      tools.register({
        name: 'wechat_login',
        description:
          '微信扫码登录。action=start 生成二维码(返回图片路径,让用户用微信扫);' +
          'action=verify 提交手机上显示的配对码(code 参数);action=logout 清除登录状态。' +
          '用户说「连微信」「扫个码」「微信掉线了」时用 start。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: 'start | verify | logout' },
            code: { type: 'string', description: '配对码(action=verify 时必填)' },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args) {
          const action = String(args.action ?? 'start').trim()
          if (action === 'verify') {
            const ok = client.submitVerifyCode(args.code)
            return { text: ok ? '配对码已提交,等微信确认。' : '现在没有在等配对码(可能已经超时,重新 start 一次)。' }
          }
          if (action === 'logout') {
            // 只清内存 meta 是不够的:凭证还在 <stateDir>/sdk,重启时 autoLogin
            // 会拿旧凭证又登回来。client.logout() 连凭证目录一起清。
            await client.logout()
            store.clearContexts()
            store.setMeta('userId', '')
            store.setMeta('accountId', '')
            diagnostics.loggedIn = false
            diagnostics.running = false
            diagnostics.accountId = ''
            diagnostics.selfUserId = ''
            diagnostics.qrFile = ''
            writeDiagnostics()
            return { text: '已登出:轮询停了,本地凭证和 context_token 都清了。再 start 一次可以重新扫码。' }
          }
          // start:不 await 整个登录(要等用户扫码,可能好几分钟),但要等二维码就绪。
          // 不等的话第一次调用只能拿到 null,用户得再问一次 —— 而扫码本来就是个
          // 「现在就要看到图」的动作。
          startLogin()

          const deadline = Date.now() + 10_000
          while (!client.lastQr && Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 200))
          }
          const qr = client.lastQr
          if (!qr) {
            return { text: `二维码还没就绪(目录 ${qrDirOf(settings)})。等几秒再调一次 wechat_login。` }
          }
          diagnostics.qrFile = qr.latest || qr.file
          writeDiagnostics()
          // 首选给「实时页面」的链接:静态图是快照,服务端换码之后聊天里那张
          // 就过期了,而页面会自动跟着换。拿不到 webServer 才退回文件路径。
          if (qrPageUrl) {
            return {
              text: [
                `打开这个链接扫码:${qrPageUrl}`,
                '页面会自己刷新二维码 —— 服务端换码它跟着换,不用再找我要新图。',
                '用微信扫页面上的码,扫完手机上可能要求确认。',
                '如果让你输配对码,把那个码发我:wechat_login action=verify code=<码>。',
                `(纯图片路径:${qr.latest || qr.file})`,
              ].join('\n'),
            }
          }
          return {
            text: [
              `二维码已生成:${qr.latest || qr.file}`,
              '用微信扫它,扫完手机上可能要求确认。',
              '如果让你输配对码,把那个码发我:wechat_login action=verify code=<码>。',
              '二维码会过期,过期了就再调一次 wechat_login。',
            ].join('\n'),
          }
        },
      })

      tools.register({
        name: 'wechat_send',
        description:
          '给微信里的人发东西(图片/文件/文字)。**回复对方不用调这个** —— '
          + '你的正文会自动发到当前会话。这个工具用于:发图/发文件,或者主动给**别人**发消息。'
          + 'userId 留空 = 当前会话的对方。file 可以是 http(s) 链接(插件自己下载)'
          + '或本地绝对路径。'
          + '**发表情包走这条路**:先用 meme_list 搜出图的 path,再把那个绝对路径给 file。'
          + '(别用 send_meme —— 它吐的是别的渠道的标记格式,微信里发不出去。)'
          + 'text 和 file 同时给会拆成两条消息发(微信不接受图配文一起发)。',
        parameters: {
          type: 'object',
          properties: {
            userId: { type: 'string', description: '微信 user id(留空 = 当前会话的对方)' },
            text: { type: 'string', description: '要发的文字' },
            file: {
              type: 'string',
              description: 'http(s) 链接(图片/文件,插件自己下载)或本地绝对路径',
            },
          },
          additionalProperties: false,
        },
        output: TEXT_OUTPUT,
        async execute(args, exec) {
          const sessionId = sessionIdOf(exec)
          const record = sessions.findBySessionId(sessionId)
          const userId = String(args.userId ?? record?.userId ?? '').trim()
          if (!userId) return { text: '不知道发给谁:这个会话不是微信会话,请显式给 userId。' }
          const text = String(args.text ?? '').trim()
          const file = String(args.file ?? '').trim()
          if (!text && !file) return { text: 'text 和 file 至少给一个。' }

          try {
            if (file) {
              // ⚠️ 图和文字要**分两条发**。
              //
              // iLink 一条消息只认一种内容类型:把 file 和 text 塞进同一次
              // 发送,服务端直接回 `invalid arguments`(实测复现过,而 SDK 和
              // 我们的代码里都没有这句话 —— 它是服务端返回的 errmsg)。
              // 拆开发既绕开了限制,也更像人:先甩图,再补一句。
              const name = /^https?:\/\//i.test(file)
                ? (() => { try { return decodeURIComponent(new URL(file).pathname.split('/').pop() || '链接内容') } catch { return '链接内容' } })()
                : (await import('node:path')).basename(file)

              if (/^https?:\/\//i.test(file)) {
                // 链接走 sendUrl:SDK 自己下载 + 判类型。这条路不需要文件工具,
                // 所以工具收口之后「发图」仍然是通的。
                await client.sendUrl(userId, file)
              } else {
                const { readFile } = await import('node:fs/promises')
                const { basename } = await import('node:path')
                const data = await readFile(file)
                await client.sendFile(userId, data, basename(file))
              }

              // 发图/发文件走的是 client 直连,不经过 outbound —— 得单独计数
              diagnostics.sent += 1
              writeDiagnostics()

              if (text) {
                await outbound.sendTo(userId, text)
                outbound.noteManualTextSend(userId, text)
                return { text: `已把 ${name} 发给 ${userId},文字另发了一条(服务端不接受图配文一起发)。` }
              }
              return { text: `已把 ${name} 发给 ${userId}。` }
            }
            await outbound.sendTo(userId, text)
            // 登记一笔:这一轮的正文要是写了同样的话,就别再自动发一遍。
            outbound.noteManualTextSend(userId, text)
            return { text: `已发给 ${userId}。` }
          } catch (error) {
            return { text: `发送失败:${error?.message ?? error}` }
          }
        },
      })

      log('info', 'wechat_* 工具已注册')
    })
  }

  // ── 启动 ──
  // ⚠️ 绝不能 await 登录:扫码要等人,而 DSH 的 boot 会等 Loader 树稳定。
  //    在这里 await 会让 Host 一直不 ready(桌面版进不去、Web URL 出不来)。
  /**
   * 启动时校验工具收口的 preset 是否真的存在。
   *
   * 为什么值得单独查:preset 不存在时插件会回落到宿主默认组合(工具全开),
   * 而那是**静默**的 —— 看日志一切正常,实际上该收的口没收。宁可在这里
   * 明确报出来。
   */
  const checkPreset = async () => {
    const presetId = settings.session.preset
    if (!presetId) {
      diagnostics.presetAvailable = null
      return
    }
    let presets
    try { presets = ctx.get?.('agentPresets') } catch { presets = undefined }
    if (!presets?.resolve) {
      diagnostics.presetAvailable = false
      log('warn', `agentPresets 服务不可用 —— preset ${presetId} 无法应用,工具**没有**收窄`)
      return
    }
    try {
      const resolved = await presets.resolve(presetId)
      diagnostics.presetAvailable = true
      log('info', `工具收口 preset 已就绪:${resolved?.id ?? presetId}`)
    } catch (error) {
      diagnostics.presetAvailable = false
      // 失败时把服务实际认到的 preset 列出来 —— 否则只能看到一句
      // "Unknown agent preset",不知道是路径不对、文件格式不对、还是名字不对。
      let roster = '(无法列出)'
      try {
        const methods = new Set()
        for (let p = presets; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
          for (const k of Object.getOwnPropertyNames(p)) methods.add(k)
        }
        const listFn = ['list', 'roster', 'discover', 'all', 'names', 'entries'].find((k) => typeof presets[k] === 'function')
        if (listFn) {
          const value = await presets[listFn]()
          roster = JSON.stringify(value)?.slice(0, 400) ?? String(value)
        } else {
          roster = `服务方法: ${[...methods].filter((m) => !m.startsWith('_') && m !== 'constructor').join(', ')}`
        }
      } catch (probeError) {
        roster = `列举失败:${probeError?.message ?? probeError}`
      }
      log('warn', `preset ${presetId} 不存在或加载失败(${error?.message ?? error})—— 微信会话会回落到宿主默认组合,工具**没有**收窄。`
        + `\n  用户 preset 目录应为 ${join(stateDir, '..', '.agent-presets', presetId, 'agent.cordis.yml')}`
        + `\n  服务实际认到的:${roster}`)
    }
  }

  /**
   * 启动时确认运行时的 tools 服务真的有 restrict。
   *
   * 为什么值得单独查:工具收口靠的就是它。如果这个部署的 DSH 版本没有
   * restrict,收口会在**每次建会话时**才失败 —— 那时候人已经在微信里说话了,
   * 而失败是「静默放过」的。宁可启动时就报出来。
   */
  const checkToolRestriction = () => {
    if (!settings.tools.restrict) {
      diagnostics.toolRestrictionAvailable = null
      log('warn', 'tools.restrict 关着 —— 微信会话的工具面**没有**收窄')
      return
    }
    let tools
    try { tools = ctx.get?.('tools') } catch { tools = undefined }
    const available = typeof tools?.restrict === 'function'
    diagnostics.toolRestrictionAvailable = available
    if (available) {
      const allow = settings.tools.allow ?? []
      log('info', `工具收口可用:只保留 [${allow.join(', ') || '(空,纯聊天)'}]`)

      // ⚠️ 这里**不做**名单校验 —— 时机不对。
      //
      // 试过在启动时拿 tools.view(undefined).restrictableNames 对名单,结果是
      // **误报**:boot() 跑的时候别的插件还没加载完,看到的是一份不完整的工具表
      // (连本插件自己刚注册的 wechat_* 都不在里面),于是 16 个完全正常的名字
      // 被报成「不存在」。
      //
      // 真正的校验放在 lib/session.js 的 #applyToolRestriction 里(建会话时),
      // 那时候插件都就位了。这里只记一笔数量,供参考。
      try {
        const size = tools.view?.(undefined)?.restrictableNames?.size
        if (typeof size === 'number' && size > 0) {
          log('info', `(启动时可见的全局工具 ${size} 个 —— 插件还在加载,这个数会涨,仅供参考)`)
        }
      } catch { /* 拿不到就算了 */ }
    } else {
      log('warn', 'tools 服务没有 restrict 方法 —— 这个 DSH 版本不支持工具收口,'
        + '微信会话会拿到**全部工具**。要么升级 DSH,要么接受这一点。')
    }
  }

  /**
   * 把 tools.allow/deny 里的名字和「当前可收口的全局工具」对一遍。
   *
   * 为什么值得有:dsh-tools 的 restrict() 遇到不认识的工具名是**抛错**,不是
   * 忽略那一个。抛出去收口就没装上 —— 工具面**全开**,而现象只是「少了某个
   * 功能」,很难联想到安全边界塌了。
   *
   * 时机:只能按需查。boot() 里查会误报(插件还没加载完,工具表不完整)。
   *
   * @returns 一行给人看的结论;查不了就返回空串
   */
  /**
   * 报告上一次**建会话时**(也就是真正调用 restrict 的那次)的收口结论。
   *
   * ⚠️ 为什么不是在这里现查:试过用 tools.view(undefined).restrictableNames,
   *    但那个 scope **不对** —— 它看不到 web_search / read / glob / grep /
   *    schedule_* / todo_write / skill 这些完全正常的全局工具,会把 13 个正常
   *    名字误报成「不存在」,正好把要放行的那批全砍了。
   *
   *    restrict() 自己算的 scope(scopeOf(this.ctx))才作数,所以结论由
   *    lib/session.js 在收口成功后记进 store,这里只负责读出来。
   *    没建过会话就老实说没校验过。
   */
  const toolNamesReport = () => {
    if (!settings.tools.restrict) return '工具收口:关着(工具面没收窄)'
    const recorded = store.getMeta?.('toolRestriction')
    if (!recorded?.at) {
      return '工具收口:还没建过会话,名单还没被 restrict 校验过'
    }
    const when = new Date(recorded.at).toLocaleTimeString('zh-CN')
    if (recorded.unknown?.length) {
      return `工具收口:⚠️ ${when} 校验时发现 ${recorded.unknown.length} 个名字不存在 → `
        + `${recorded.unknown.map((n) => `"${n}"`).join(', ')}`
        + `\n  已摘掉它们再收口(否则 restrict 抛错 = 工具全开)。请改配置。`
        + `\n  那个 scope 能收口的工具(${recorded.known?.length ?? 0} 个):`
        + `${(recorded.known ?? []).join(', ')}`
    }
    return `工具收口:✓ ${when} 校验通过,${recorded.allow?.length ?? 0} 个名字全部有效`
  }

  const boot = async () => {
    try {
      checkToolRestriction()
      await checkPreset()
      // 先把模型路由解析出来写进诊断。它必须能解析出一个 model ——
      // 提示词里的 {{model}} 就来自它,拿不到会直接抛「本轮运行失败」。
      try {
        const route = resolveModel({ ctx, settings, log })
        diagnostics.modelRoute = `${route.provider}/${route.model} (来自 ${route.source})`
        log('info', `模型路由:${diagnostics.modelRoute}`)
      } catch (error) {
        diagnostics.modelRoute = `解析失败:${error?.message ?? error}`
        log('error', `模型路由解析失败:${error?.stack ?? error}`)
      }
      writeDiagnostics()
      if (!settings.login.autoLogin) {
        log('info', 'autoLogin 已关闭,等 wechat_login 手动触发')
        return
      }
      if (!client.isLoggedIn() && !client.hasStoredCredentials?.()) {
        // ⚠️ 两个都要看。只看 isLoggedIn() 是错的:它查的是**内存**里的凭证,
        //    而重启之后凭证在**盘上**。实测踩过 —— sdk/credentials.json
        //    明明在,启动却报「没有可用凭证」,于是每次重启都得重新扫码。
        log('info', '没有可用凭证,等 wechat_login 扫码')
        writeDiagnostics()
        return
      }
      await client.login()
      if (settings.receive.poll) {
        await client.start()
        diagnostics.running = true
      }
      log('info', '微信渠道已就绪')
    } catch (error) {
      diagnostics.lastError = String(error?.message ?? error)
      log('error', `启动失败:${error?.stack ?? error}`)
    } finally {
      writeDiagnostics()
    }
  }
  // boot 内部已有 try/catch;这层防的是 catch 处理器自己抛 —— 那会变成
  // unhandled rejection 把宿主进程带走(已经崩过一次,见 log 那里的注释)。
  void boot().catch(() => { /* 绝不能再抛 */ })

  // 收消息:SDK 的长轮询在 client.start() 之后自己跑,这里只把回调接上
  ctx.effect(() => {
    // 把解析后的目录打出来:曾经因为没走 stateDirOf 解析,stateDir 是空串,
    // 二维码落不了盘、凭证还会写到进程 CWD。目录一眼可见就不会再犯。
    log('info', `微信渠道插件加载 v${LIB_VERSION} · 状态目录 ${stateDir} · 二维码目录 ${qrDirOf(settings)} · 凭证目录 ${join(stateDir, 'sdk')}`)
    return () => {
      try { client.dispose() } catch { /* 已停 */ }
      try { qrPage.dispose() } catch { /* 路由已摘 */ }
      void sessions.disposeAll().catch(() => { /* 卸载路径也不能抛 */ })
      writeDiagnostics()
    }
  }, 'wechat-channel.lifecycle')

  // 把入站回调挂到 client 上(放在这里是为了让 client 先构造完)
  client.bot.on('message', (msg) => {
    void handleInbound(msg)
      .catch((error) => { log.error(`入站处理失败:${error?.stack ?? error}`) })
      .catch(() => { /* 同上:处理器抛错不能连坐 */ })
  })

  writeDiagnostics()
}

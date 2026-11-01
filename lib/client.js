// iLink 客户端封装:把 @wechatbot/wechatbot 包成插件好用的形状。
//
// 分工:SDK 负责协议细节(鉴权头、长轮询、媒体加解密、SILK 语音、context_token 回带),
// 这一层只负责「插件需要的东西」——扫码出图、凭证落盘、事件转成插件回调、限流。
import { writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { WeChatBot } from '../vendor/wechatbot/dist/index.js'
import { encodeMatrix, toPng, toAscii } from './qr.js'
import { stateDirOf, qrDirOf } from './config.js'

/**
 * 这个错误值不值得重试?
 *
 * 只有「网络层的瞬时故障」才重试:超时、连接重置/中断、DNS 抖动。
 * 协议层错误(参数错、凭证缺失、被服务端拒绝)重试多少次都一样,直接抛。
 */
export function isTransientNetworkError(error) {
  if (!error) return false
  const name = String(error.name ?? '')
  if (name === 'AbortError' || name === 'TimeoutError') return true
  const code = String(error.code ?? error.cause?.code ?? '')
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EPIPE', 'EAI_AGAIN', 'ENOTFOUND', 'UND_ERR_CONNECT_TIMEOUT'].includes(code)) return true
  const message = String(error.message ?? '')
  return /timed? ?out|timeout|socket hang up|network|fetch failed/i.test(message)
}

/** 出站限流:滑动窗口,超了排队等 */
function createRateLimiter(maxPerMinute) {
  if (!maxPerMinute || maxPerMinute <= 0) {
    return { take: async () => {} }
  }
  const windowMs = 60_000
  const stamps = []
  return {
    async take() {
      for (;;) {
        const now = Date.now()
        while (stamps.length && now - stamps[0] > windowMs) stamps.shift()
        if (stamps.length < maxPerMinute) {
          stamps.push(now)
          return
        }
        const wait = windowMs - (now - stamps[0]) + 20
        await new Promise((r) => setTimeout(r, Math.min(wait, 5_000)))
      }
    },
  }
}

export function createClient({ settings, store, log, hooks = {} }) {
  // ⚠️ 必须走 stateDirOf/qrDirOf 解析默认值,不能直接用 settings.stateDir ——
  //    DEFAULTS 里 stateDir 是空串,直接用会得到 '' → mkdir '' 抛 ENOENT,
  //    二维码存不下来;更阴的是 storageDir 会变成相对路径 'sdk',凭证写到进程
  //    CWD 里去,下次启动就找不到了。
  const stateDir = stateDirOf(settings)
  const qrDir = qrDirOf(settings)
  const limiter = createRateLimiter(settings.send.maxPerMinute)

  /** 待用户回填的配对码:登录流程会 await 这个 promise */
  let verifyCodeWaiter = null
  let lastQr = null
  let credentials = null
  let started = false
  // 正在跑的那条登录流程(并发保护用,见 login() 的注释)
  let loginInFlight = null
  // 已卸载:登录回调看到它就主动抛错把在跑的登录打断;start() 看到它就不起轮询。
  // 注意和 stop() 分开 —— logout() 也会 stop(),但之后还要能重新登录。
  let disposed = false

  const bot = new WeChatBot({
    baseUrl: settings.baseUrl,
    botAgent: settings.botAgent,
    storage: 'file',
    storageDir: join(stateDir, 'sdk'),
    logLevel: 'warn',
  })

  // 凭证目录。SDK 的 FileStorage 把每个 key 写成一个 json 文件
  // (credentials.json / cursor.json / context_tokens.json …)。
  // 登出要连它一起清 —— 只清内存里的 meta 的话,重启时 autoLogin 会拿旧凭证
  // 又登回来,等于没登出。
  const sdkStorageDir = join(stateDir, 'sdk')

  /**
   * 只留最近几张带时间戳的二维码。
   *
   * 为什么要清:SDK 在会话过期时会自己重新申请二维码,加上登录重试,一次
   * 出问题就能堆出几十张(实测 34 张)。它们除了占地方没有任何用 —— 真正
   * 给人看的是 login-qr.png 这个「最新」别名。
   */
  const pruneQrFiles = (keep = 5) => {
    try {
      const stamped = readdirSync(qrDir)
        .filter((name) => /^login-qr-.*\.png$/.test(name))
        .sort()
      for (const name of stamped.slice(0, Math.max(0, stamped.length - keep))) {
        try { rmSync(join(qrDir, name), { force: true }) } catch { /* 删不掉就算了 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  const renderQr = (url) => {
    try {
      mkdirSync(qrDir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const file = join(qrDir, `login-qr-${stamp}.png`)
      writeFileSync(file, toPng(url, { scale: settings.login.qrScale, quiet: settings.login.qrQuiet }))
      const latest = join(qrDir, 'login-qr.png')
      try { writeFileSync(latest, toPng(url, { scale: settings.login.qrScale, quiet: settings.login.qrQuiet })) } catch { /* 覆盖不了就算了 */ }
      pruneQrFiles()
      return { file, latest, ascii: toAscii(url, { quiet: 2 }), version: encodeMatrix(url).version }
    } catch (error) {
      log.warn(`二维码落盘失败:${error?.message ?? error}`)
      return { file: '', latest: '', ascii: toAscii(url, { quiet: 2 }), version: encodeMatrix(url).version }
    }
  }

  const loginCallbacks = {
    onQrUrl(url) {
      // 卸载后必须把正在跑的登录打断。
      //
      // 为什么:插件重载时旧实例的 dispose 只会 client.stop(),而一个已经
      // 进入 qrLogin 的登录流程不受影响 —— 它会继续申请二维码、继续轮询,
      // 而它引用的还是**旧版本的模块**。实测重载后新实例明明没登录,日志里
      // 却还在每 2 秒刷 "QR code expired" —— 就是旧实例在跑。
      // 回调是登录流程里唯一由我们控制的点,从这里抛出去正好能中断它。
      if (disposed) throw new Error('插件已卸载,登录流程中止')
      const rendered = renderQr(url)
      lastQr = { url, ...rendered, at: new Date().toISOString() }
      log.info(`二维码已就绪:${rendered.file || '(落盘失败)'} (版本 ${rendered.version})`)
      hooks.onQr?.(lastQr)
    },
    onScanned() {
      log.info('已扫码,等待手机上确认…')
      hooks.onScanned?.()
    },
    onExpired() {
      log.warn('二维码已过期,将重新申请')
      hooks.onExpired?.()
    },
    async onVerifyCode(isRetry) {
      log.info(`服务端要求配对码${isRetry ? '(上一次不正确,重试)' : ''}`)
      if (typeof hooks.onVerifyCodeNeeded === 'function') {
        hooks.onVerifyCodeNeeded(isRetry)
      }
      return await new Promise((resolve) => {
        verifyCodeWaiter = resolve
        // 等不到就返回空串,让服务端判错重来,而不是永远挂着
        setTimeout(() => {
          if (verifyCodeWaiter === resolve) {
            verifyCodeWaiter = null
            resolve('')
          }
        }, 120_000)
      })
    },
  }

  // ── 事件接线 ──
  bot.on('login', (creds) => {
    credentials = creds
    store.setMeta('accountId', creds.accountId)
    store.setMeta('userId', creds.userId)
    store.setMeta('lastLoginAt', new Date().toISOString())
    log.info(`登录成功:accountId=${creds.accountId} userId=${creds.userId}`)
    hooks.onLogin?.(creds)
  })
  bot.on('session:expired', () => {
    log.warn('会话过期(服务端返回 -14),需要重新扫码')
    store.setMeta('expiredAt', new Date().toISOString())
    hooks.onSessionExpired?.()
  })
  /**
   * SDK 连续自动重登失败后放弃了。
   *
   * 这个事件很重要:不接住的话,渠道层会以为「还在重试」,而实际上轮询已经
   * 停了 —— 消息收不到,用户却看到「已登录」。要明确翻成「掉线了,要重新
   * 扫码」并让 wechat_status 说出来。
   */
  bot.on('relogin:exhausted', ({ consecutive } = {}) => {
    log.error(`自动重登连续失败 ${consecutive ?? '?'} 次,已停下 —— 需要用户重新扫码`)
    started = false
    store.setMeta('reloginExhaustedAt', new Date().toISOString())
    hooks.onReloginExhausted?.({ consecutive })
  })
  bot.on('session:restored', (creds) => {
    credentials = creds
    // 也要写 meta:白名单的空名单分支靠 store 里的 userId 认「本人」。
    // 万一 state.json 被清过而凭证还在(或者只恢复了会话没走 login),
    // 不写的话登录看着正常、消息却全被拒 —— 那是最难查的一类问题。
    if (creds?.userId) store.setMeta('userId', creds.userId)
    if (creds?.accountId) store.setMeta('accountId', creds.accountId)
    log.info(`会话已自动恢复:userId=${creds?.userId ?? '?'}`)
    hooks.onSessionRestored?.(creds)
  })
  bot.on('poll:start', () => log.info('开始收消息(长轮询)'))
  bot.on('poll:stop', () => log.info('停止收消息'))
  bot.on('error', (error) => log.warn(`SDK 报错:${error?.message ?? error}`))
  bot.on('message', (msg) => {
    try {
      hooks.onMessage?.(msg)
    } catch (error) {
      log.error(`消息处理回调抛错:${error?.stack ?? error}`)
    }
  })

  const isLoggedIn = () => {
    try {
      return Boolean(bot.getCredentials())
    } catch {
      return false
    }
  }

  /**
   * 登录:有凭证就直接用,否则走扫码。
   *
   * 为什么要在 SDK 外面再包一层重试:SDK 的扫码轮询只处理协议层的状态
   * (expired / scaned / confirmed / need_verifycode …),**不接网络异常**。
   * 一次 `get_qrcode_status` 请求超时或连接被重置,整个登录就抛出去结束了
   * —— 而用户这时候可能正拿着手机对着二维码。
   *
   * 只对「瞬时错误」重试(超时 / 连接类);协议错误(比如凭证缺失)直接抛,
   * 重试也没用。重试会请求一张新二维码,由 onQr 钩子重新落盘并通知。
   *
   * ⚠️ 定义成独立函数而不是对象的方法:早先写成 `async runLogin()` 挂在返回
   *    的对象上,却用裸名 `runLogin(...)` 调用 —— 那是 `undefined`,
   *    登录直接 `ReferenceError: runLogin is not defined`。
   */
  const runLogin = async ({ force }) => {
    const MAX_ATTEMPTS = 5
    let lastError
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        // 只有第一次带 force:重试时若还 force,会再打一次「强制重新登录」,
        // 而这时我们只是想把中断的轮询接上。
        const creds = await bot.login({ force: force && attempt === 1, callbacks: loginCallbacks })
        credentials = creds
        return creds
      } catch (error) {
        lastError = error
        if (!isTransientNetworkError(error)) throw error
        if (attempt === MAX_ATTEMPTS) break
        const waitMs = Math.min(2000 * attempt, 10000)
        log('warn', `登录轮询被瞬时错误打断(${error?.name ?? ''} ${error?.message ?? error}),`
          + `${waitMs}ms 后重试(${attempt}/${MAX_ATTEMPTS - 1})`)
        await new Promise((resolve) => setTimeout(resolve, waitMs))
      }
    }
    throw lastError
  }

  return {
    bot,
    /** 解析后的目录(诊断/测试用):必须是绝对路径,否则说明默认值没解析 */
    stateDir,
    qrDir,
    get lastQr() { return lastQr },
    get credentials() { return credentials ?? safeCreds(bot) },
    get isRunning() { return started && bot.isRunning },
    isLoggedIn,

    /** 提交用户填的配对码(由工具或消息触发) */
    submitVerifyCode(code) {
      const text = String(code ?? '').trim()
      if (!text) return false
      if (!verifyCodeWaiter) return false
      const resolve = verifyCodeWaiter
      verifyCodeWaiter = null
      resolve(text)
      return true
    },

    /**
     * 登录:有凭证就直接用,否则走扫码。
     *
     * 为什么要在外面包一层重试:SDK 的扫码轮询(`qrLogin`)只处理协议层的
     * 状态(expired / scaned / confirmed / need_verifycode …),**不接网络异常**。
     * 单次 `get_qrcode_status` 请求默认 15 秒超时,一旦超时或连接被重置,
     * 整个登录就抛出去结束了 —— 而用户这时候可能正拿着手机对着二维码。
     *
     * 只对「瞬时错误」重试(超时 / 连接类);协议错误(比如凭证缺失)直接抛,
     * 重试也没用。重试会请求一张新二维码,由 onQr 钩子重新落盘并通知。
     */
    async login({ force = false } = {}) {
      // ⚠️ 并发保护:绝不允许两条登录流程同时跑。
      //
      // 每次扫码登录都会在服务端创建一个**新的机器人身份**。两条并发的登录
      // 会互相把对方踢下线:实测同一分钟内跑出过 4 个不同的 accountId
      // (a1b2c3d4e5f6 / 0f1e2d3c4b5a / 9a8b7c6d5e4f / 1234567890ab),
      // 先登录的那个 18 秒后就收到 -14。
      //
      // 而 SDK 在 -14 时会 clearAll() + 重新扫码 —— 于是变成自激循环,
      // 一路跑出 483 次过期、34 张二维码。
      if (loginInFlight) {
        log('warn', '已经有一条登录流程在跑,这次直接复用它(并发登录会互相踢下线)')
        return loginInFlight
      }
      loginInFlight = runLogin({ force }).finally(() => { loginInFlight = null })
      return loginInFlight
    },

    async start() {
      // 卸载之后不能再把轮询拉起来。
      // 踩过:登录流程是 fire-and-forget 的,插件卸载之后它的
      // `.then(() => client.start())` 才跑完 —— 于是旧实例的轮询在「已经
      // 卸载」之后又起来了,日志里能看到「停止收消息」后面紧跟一句
      // 「扫码登录完成,已开始收消息」。
      if (disposed) {
        log('warn', '插件已卸载,不再启动轮询')
        return
      }
      if (started) return

      // ⚠️ 千万不要 await bot.start()。
      //
      // SDK 的 start() 长这样:
      //     this.runPromise = this.poller.start(baseUrl, token);
      //     await this.runPromise;          // ← 挂到轮询循环结束为止
      // 而 poller.start() 是个 `while (!stopped)` 死循环 —— 也就是说
      // `await bot.start()` **永远不返回**。踩过:boot() 里 await 它之后,
      // 后面的 `diagnostics.running = true` 和「微信渠道已就绪」永远执行
      // 不到,体检里明明在收消息却显示 running: false。
      //
      // 正确做法:把它当长跑任务发出去,自己接住它的失败,不等它。
      started = true
      const running = bot.start()
      running
        .catch((error) => {
          log.warn(`轮询异常退出:${error?.message ?? error}`)
          started = false
        })
        .catch(() => { /* 连日志都挂了也不能抛 */ })
    },

    stop() {
      try { bot.stop() } catch { /* 已停 */ }
      started = false
    },

    /**
     * 插件卸载。
     *
     * ⚠️ 和 stop() 分开:logout() 也会 stop(),但登出之后还要能重新登录,
     *    所以那个不能置「已卸载」。
     */
    dispose() {
      disposed = true
      this.stop()
    },

    /**
     * 登出:停轮询 + 清掉 SDK 落盘的凭证。
     *
     * 只清内存 meta 是不够的 —— 凭证还在 <stateDir>/sdk/credentials.json,
     * 下次启动 autoLogin 会拿它直接登回来,「登出」等于没发生。
     *
     * 清的是整个 sdk 目录里的 json(credentials / cursor / context_tokens /
     * typing_tickets):留着 cursor 会让下次登录从一个过期游标继续收,
     * 留着 context_tokens 会让旧会话的 token 混进来。
     */
    async logout() {
      this.stop()
      credentials = null
      lastQr = null
      try {
        await rm(sdkStorageDir, { recursive: true, force: true })
        log.info(`已清除 SDK 凭证目录:${sdkStorageDir}`)
      } catch (error) {
        log.warn(`清除凭证目录失败:${error?.message ?? error}`)
      }
      return true
    },

    /** 有没有可用的本地凭证(SDK 落盘的那份,不是内存) */
    hasStoredCredentials() {
      return existsSync(join(sdkStorageDir, 'credentials.json'))
    },

    /** 发文本(带限流) */
    async sendText(userId, text) {
      await limiter.take()
      await bot.send(userId, { text: String(text) })
    },

    /** 发图片 */
    async sendImage(userId, buffer, caption) {
      await limiter.take()
      await bot.send(userId, { image: buffer, ...(caption ? { caption: String(caption) } : {}) })
    },

    /** 发文件(按扩展名自动路由:图片/视频/文件) */
    async sendFile(userId, buffer, fileName, caption) {
      await limiter.take()
      await bot.send(userId, { file: buffer, fileName: String(fileName), ...(caption ? { caption: String(caption) } : {}) })
    },

    /**
     * 发语音。
     *
     * ⚠️ 必须走 `{ voice }` 这条路 —— 走 `{ file }` 的话 SDK 会把它当**文件**发
     * (categorizeByMime 永远不返回 'voice')。`{ voice }` 是本地补丁加的,
     * 见 vendor/wechatbot/dist/core/client.js 里的注释。
     *
     * @param silk       SILK 编码的音频(#!SILK_V3 头)
     * @param playtimeMs 时长(毫秒),客户端拿它画语音条
     */
    async sendVoice(userId, silk, playtimeMs, { sampleRate = 24000, bitsPerSample = 16 } = {}) {
      await limiter.take()
      await bot.send(userId, {
        voice: silk,
        playtime: Math.max(0, Math.round(Number(playtimeMs) || 0)),
        encodeType: 1,
        // 客户端解码要用 —— 少了这俩消息会静默丢失(服务端还是返回 message_id)
        sampleRate,
        bitsPerSample,
      })
    },

    /** 从 URL 发(自动下载 + 判类型) */
    async sendUrl(userId, url, caption) {
      await limiter.take()
      await bot.send(userId, { url: String(url), ...(caption ? { caption: String(caption) } : {}) })
    },

    /** 下载入站消息里的媒体 */
    async download(msg) {
      return await bot.download(msg)
    },

    async sendTyping(userId) {
      if (!settings.send.typing) return
      try { await bot.sendTyping(userId) } catch { /* 提示失败不影响发消息 */ }
    },

    async stopTyping(userId) {
      try { await bot.stopTyping(userId) } catch { /* 同上 */ }
    },
  }
}

function safeCreds(bot) {
  try { return bot.getCredentials() ?? null } catch { return null }
}

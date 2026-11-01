// WeChat 用户 ↔ DSH 会话 的映射与投递。
//
// 会话 id 是**确定性派生**的:sha256(sessionKey) 折成 uuid 形状。
// 好处:插件重启、进程重启、换机器,只要 sessionKey 不变,还是同一个会话,
// 上下文能 resume 回来 —— 不会因为重启就「失忆」。
import { createHash, randomUUID } from 'node:crypto'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { agentOptionsFor } from './model.js'

export class WeChatSessions {
  #ctx
  #agents
  #settings
  #log
  #store
  /** sessionKey → record */
  #records = new Map()
  /** sessionId → record(出站事件只带 sessionId,得能反查) */
  #bySessionId = new Map()
  /** 模型路由只打一次日志,免得每条消息都刷 */
  #modelLogged = false
  /** 上次收口时被 restrict 判为「不存在」的工具名(供 wechat_status 报告) */
  #lastUnknownTools = null
  /** 上次收口时那个 scope 能收口的工具名(从 restrict 的报错里抄出来) */
  #lastKnownTools = null

  constructor({ ctx, agents, settings, log, store }) {
    this.#ctx = ctx
    this.#agents = agents
    this.#settings = settings
    this.#log = log
    this.#store = store
  }

  /**
   * 会话 key:同一个用户永远映射到同一个 key。
   *
   * ⚠️ 这里**故意不含 accountId**:
   *   accountId 是每次扫码登录时服务端新建的机器人身份,重扫一次就换一个
   *   (测试中出现过多个,例如 a1b2c3d4e5f6 / 0f1e2d3c4b5a / 9a8b7c6d5e4f /
   *   1234567890ab / abcdef012345)。把它放进 key,重登就等于换了个人,
   *   聊天上下文全丢 —— 对「和自己的微信助手聊天」这个场景是错的。
   *   区分身份靠 userId 就够了:换一个微信号,userId 自然不同。
   *
   * ⚠️ 也不能读 ctx 上的自定义属性:DSH 的 ctx 是 Proxy,读一个没在
   *    inject 里声明过的属性会直接抛
   *    `cannot get property "wechatAccountId" without inject`。
   *    踩过:登录正常、消息也收到了,但每一条投递都挂在这里,用户看到的是
   *    「处理这类消息时出错了」。要跨模块传值就走 store,不要挂 ctx。
   */
  sessionKey(userId) {
    return `${this.#settings.session.prefix}:direct:${String(userId)}`
  }

  /** sha256(sessionKey) → uuid 形状的 SessionId(与 dsh-qqbot 同法) */
  deriveSessionId(sessionKey) {
    const hash = createHash('sha256').update(sessionKey).digest('hex')
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`
  }

  /**
   * 会话 id:优先用「重置覆盖值」,没有才用确定性派生。
   * ⚠️ 光靠派生做不了重置 —— 同一个 key 永远派生出同一个 id,删了重建还是它。
   *    所以 /new 要落一个随机 id 的覆盖值,存在 store 里(重启也还在)。
   */
  #sessionIdFor(key) {
    const override = this.#store?.getMeta(`sessionId:${key}`)
    if (override) return SessionId(String(override))
    return SessionId(this.deriveSessionId(key))
  }

  findBySessionId(sessionId) {
    return this.#bySessionId.get(String(sessionId))
  }

  findByUserId(userId) {
    return this.#records.get(this.sessionKey(userId))
  }

  /**
   * 工具收口:把微信会话能看到的工具限制成 allow 里那几个。
   *
   * 用 tools.restrict —— 它过滤的是这个 scope **继承到的**全局工具面,所以模型
   * 那边直接看不到 pwsh / 文件读写 / 联网 / 子代理,而不是「看得到但不许调」。
   *
   * 为什么不用 agent preset:preset 走 dsh-agent-presets 的「用户 preset 根目录」,
   * 若部署未扫描该目录(只列出随附 preset)。restrict 是
   * 运行时直接生效的,不依赖目录发现。
   */
  async #applyToolRestriction(agentCtx) {
    const t = this.#settings.tools
    if (!t?.restrict) return undefined
    let allow = Array.isArray(t.allow) ? t.allow.map(String) : []
    let deny = Array.isArray(t.deny) ? t.deny.map(String) : []
    if (allow.length === 0 && deny.length === 0) {
      this.#log.info('tools.restrict 开着但 allow/deny 都是空的 —— 一个工具都不留(纯聊天)')
    }
    let tools
    try {
      tools = agentCtx.get?.('tools') ?? agentCtx.tools
    } catch {
      tools = undefined
    }
    if (!tools?.restrict) {
      this.#log.warn('tools 服务没有 restrict 方法(DSH 版本不匹配?)—— 本次会话工具**没有**收窄')
      return undefined
    }

    // ── 收口 + **失败往安全方向倒** ──
    //
    // dsh-tools 的 restrict() 遇到不认识的工具名是**抛错**,不是忽略那一个。
    // 抛出去收口整个装不上 —— 工具面**全开**。而现象只是「少了某个功能」,
    // 很难联想到是安全边界塌了。
    //
    // 所以:先照原样试一次;抛错且是「名字不认识」,就从**错误信息里**把那些
    // 名字抠出来,摘掉再试一次。这样写错一个名字的后果是「那一个工具不放行」,
    // 而不是「全部放行」—— 同样是错,但错的方向是安全的。
    //
    // ⚠️ 为什么不用 tools.view(undefined).restrictableNames 自己先对一遍:
    //    试过,**作用域不对**。view() 收的是 scope 参数,传 undefined 拿到的是
    //    另一个 scope 的工具表 —— 实测它看不到 web_search / read / glob / grep /
    //    schedule_* / todo_write / skill 这些**完全正常**的全局工具,于是 13 个
    //    正常名字被误判成未知,正好把要放行的那批全砍了。
    //    restrict() 自己算的 scope(scopeOf(this.ctx))才是权威的,所以改成
    //    听它的报错,而不是自己猜。
    const attempt = (a, d) => tools.restrict({
      ...(a.length ? { allow: a } : {}),
      ...(d.length ? { deny: d } : {}),
    })

    let disposer
    try {
      disposer = attempt(allow, deny)
    } catch (error) {
      const message = String(error?.message ?? error)
      // restrict 的报错长这样:
      //   tools.restrict() names unknown global tools "x", "y"; known global tools: a, b, c
      const parsed = /names unknown global tool[s]?\s+(.*?);\s*known global tools:\s*(.*)$/s.exec(message)
      if (!parsed) {
        this.#log.warn(`工具收口失败:${message} —— 本次会话工具**没有**收窄`)
        return undefined
      }
      const bad = [...parsed[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
      const knownList = parsed[2].split(',').map((s) => s.trim()).filter(Boolean)
      this.#lastUnknownTools = bad
      this.#lastKnownTools = knownList

      // ⚠️ 说清楚后果:收口失败 = 工具面**全开**,不是「少了几个」。
      this.#log.error(`⚠️ tools.allow/deny 里有 ${bad.length} 个**不存在**的工具名:`
        + `${bad.map((n) => `"${n}"`).join(', ')}。`
        + '已把它们摘掉再收口 —— 否则 restrict() 抛错,收口整个装不上,'
        + '微信会话的工具面就是**全开**的(不是「少了几个」)。请改配置。')
      if (knownList.length) {
        this.#log.error(`这个 scope 能收口的工具(${knownList.length} 个):${knownList.sort().join(', ')}`)
      }

      // allow 里摘掉未知的 = 不放行(安全方向);deny 里摘掉未知的 = 无所谓
      const badSet = new Set(bad)
      const allow2 = allow.filter((name) => !badSet.has(name))
      const deny2 = deny.filter((name) => !badSet.has(name))
      try {
        disposer = attempt(allow2, deny2)
        allow = allow2
        deny = deny2
      } catch (retryError) {
        this.#log.warn(`摘掉未知名字后重试仍然失败:${retryError?.message ?? retryError}`
          + ' —— 本次会话工具**没有**收窄')
        return undefined
      }
    }

    this.#log.info(`工具已收口:只保留 [${allow.join(', ') || '(空)'}]${deny.length ? ` 且排除 [${deny.join(', ')}]` : ''}`)
    // 把权威结论记进 store —— wechat_status 读它。为什么不在那边现查:见上面
    // 关于 scope 的注释,别的地方拿不到这个 scope 的工具表。
    try {
      this.#store?.setMeta?.('toolRestriction', {
        at: Date.now(),
        allow,
        deny,
        unknown: Array.isArray(this.#lastUnknownTools) ? this.#lastUnknownTools : [],
        known: Array.isArray(this.#lastKnownTools) ? this.#lastKnownTools : [],
      })
    } catch { /* 记不上不影响收口本身 */ }
    return typeof disposer === 'function' ? disposer : undefined
  }

  /**
   * 解析 agent preset —— **可选的**第二道收口。
   *
   * preset 决定这个会话挂哪些插件,而工具是插件带进来的,所以挂一个只含聊天能力的
   * preset 等于把工具面收窄。dsh-qqbot 用的是同一套机制。
   *
   * ⚠️ 该部署的 dsh-agent-presets 可能**未扫描用户 preset 根目录**(只列出
   * standard/ptc/minimal/cordis 等随附 preset),所以默认 session.preset 是空的 ——
   * 填了只会一直报警告。工具收口由 #applyToolRestriction 负责,那条不依赖目录发现。
   */
  async #composePreset(presetId) {
    if (!presetId) return {}
    let presets
    try {
      presets = this.#ctx.get?.('agentPresets')
    } catch {
      presets = undefined
    }
    if (!presets?.resolve || !presets?.mount) {
      this.#log.warn(`配置了 preset=${presetId},但 agentPresets 服务不可用 —— preset 没生效`)
      return {}
    }
    try {
      const resolved = await presets.resolve(presetId)
      const id = resolved?.id ?? presetId
      this.#log.info(`应用 preset:${id}`)
      return {
        agentPreset: id,
        presetSetup: async (agentCtx) => { await presets.mount(agentCtx, id) },
      }
    } catch (error) {
      let roster = ''
      try {
        const listFn = ['list', 'roster', 'discover'].find((k) => typeof presets[k] === 'function')
        if (listFn) roster = ` 服务实际认到:${JSON.stringify(await presets[listFn]())?.slice(0, 300)}`
      } catch { /* 列举失败不影响主流程 */ }
      this.#log.warn(`preset ${presetId} 不可用(${error?.message ?? error})—— 已跳过。${roster}`)
      return {}
    }
  }

  /** 取(或建/恢复)会话 */
  async getOrCreate(userId) {
    const key = this.sessionKey(userId)
    const existing = this.#records.get(key)
    if (existing) {
      existing.lastActivity = Date.now()
      return existing
    }

    const sessionId = this.#sessionIdFor(key)
    const cwd = this.#settings.cwd || process.cwd()
    const composed = await this.#composePreset(this.#settings.session.preset)

    // ⚠️ 必须给 agentOptions(至少要有 model)。
    //
    // DSH 的 persona-prefix 提示词段里有 `{{model}}`,它从
    // `agent.options.model` 取。不给的话变量是 undefined,拼提示词时直接抛
    //   prompt variable "{{model}}" has no value for this assembly
    //   (section "deployment:persona-prefix")
    // 用户看到的是「本轮运行失败」。踩过。
    const agentOptions = agentOptionsFor({ ctx: this.#ctx, settings: this.#settings, log: this.#log })
    if (!this.#modelLogged) {
      this.#modelLogged = true
      this.#log.info(`模型路由:${agentOptions?.provider ?? '?'}/${agentOptions?.model ?? '?'}`)
    }

    // 会话装配时做两件事:挂 preset(可选) + 收口工具(默认开)。
    // 合成一个 setup 传下去 —— agents.create/resume 只收一个回调。
    let liftRestriction
    const setup = async (agentCtx) => {
      if (composed.presetSetup) await composed.presetSetup(agentCtx)
      liftRestriction = await this.#applyToolRestriction(agentCtx)
    }

    let agent
    let handle

    // 顺序照抄 dsh-qqbot:活 agent → resume 历史 → 新建。
    // 先查活的:同一个 sessionId 若已经有 agent 在跑,再 create 一次会撞车。
    const live = this.#agents.get?.(sessionId)
    if (live) {
      agent = live
      handle = { agent, dispose: async () => {} }
      this.#log.info(`复用活会话:key=${key} sessionId=${sessionId}`)
    } else {
      try {
        // 先试着恢复历史(resume):能恢复就接着上次聊
        const resumed = await this.#agents.resume({
          resumeSessionId: sessionId,
          ...(agentOptions ? { agentOptions } : {}),
          setup,
        })
        // ⚠️ 恢复出来的 agent 必须带 model,否则宁可丢掉重建。
        //
        // 为什么:提示词里的 `{{model}}` 取自 `agent.options.model`,没有就是
        // undefined,拼提示词直接抛「本轮运行失败」。而**旧会话**可能是在
        // 我们还没传 agentOptions 的时候建的(踩过),resume 回来仍然没有
        // model —— 那就等于每次都失败,而且看起来像是「修了没用」。
        //
        // 丢历史总比整条会话用不了强;丢之前先把 handle 卸干净,免得
        // 留一个半死的 agent 挂在注册表里。
        if (resumed?.agent?.options?.model) {
          agent = resumed.agent
          handle = resumed
          this.#log.info(`恢复会话:key=${key} sessionId=${sessionId}`)
        } else {
          this.#log.warn(`恢复出来的会话没有 model 路由,丢掉重建:key=${key} sessionId=${sessionId}`)
          try { await resumed?.dispose?.() } catch { /* 卸不干净也得往下走 */ }
          throw new Error('resumed session has no model route')
        }
      } catch {
        const created = await this.#agents.create({
          sessionId,
          meta: {
            cwd,
            ...(composed.agentPreset ? { agentPreset: composed.agentPreset } : {}),
          },
          ...(agentOptions ? { agentOptions } : {}),
          setup,
        })
        agent = created.agent
        handle = created
        // 建完再确认一次:这里若没有 model,后面每条消息都会「本轮运行失败」,
        // 与其让用户猜,不如在日志里说明白。
        if (!agent?.options?.model) {
          this.#log.error('新建的会话也没有 model 路由 —— 提示词里的 {{model}} 会拼不出来,'
            + '每条消息都会失败。检查插件 model 配置或宿主的 agentDefaultModel。')
        }
        this.#log.info(`新建会话:key=${key} sessionId=${sessionId} preset=${composed.agentPreset || '(宿主默认)'}`)
      }
    }

    const record = {
      sessionKey: key,
      sessionId,
      agent,
      handle: handle ?? { agent, dispose: async () => {} },
      userId: String(userId),
      agentPreset: composed.agentPreset ?? '',
      liftRestriction,
      lastActivity: Date.now(),
    }
    this.#records.set(key, record)
    this.#bySessionId.set(String(sessionId), record)
    return record
  }

  /**
   * 把一条用户消息投给会话。
   * followup 之后再 whenIdle 等本轮收敛 —— 不等的话,下一条消息会在 turn 跑一半时插进去。
   *
   * content 优先:入站层已经组好了块(文本 + 原生图片附件),直接用它。
   * 没有就退回纯文本 —— 保持老调用方式可用。
   */
  async deliver(userId, text, { attachments = [], content } = {}) {
    const record = await this.getOrCreate(userId)
    let blocks = Array.isArray(content) && content.length ? content : null
    if (!blocks) {
      blocks = [{ type: 'text', text: String(text) }]
      for (const file of attachments) blocks.push(file)
    }
    const message = createUserMessage({ content: blocks, source: { kind: 'user' } })
    record.agent.followup(message)
    record.lastActivity = Date.now()
    try {
      await record.agent.whenIdle()
    } catch (error) {
      this.#log.warn(`whenIdle 拒绝:${error?.message ?? error}`)
    }
    return record
  }

  /** 重置会话:落一个新的随机 sessionId 覆盖值,上下文就断了 */
  async reset(userId) {
    const key = this.sessionKey(userId)
    const record = this.#records.get(key)
    if (record) {
      this.#records.delete(key)
      this.#bySessionId.delete(String(record.sessionId))
      this.#liftFor(record)
      try { await record.handle.dispose() } catch { /* 已经没了 */ }
    }
    this.#store?.setMeta(`sessionId:${key}`, randomUUID())
    this.#log.info(`会话已重置:${key} → ${this.#store?.getMeta(`sessionId:${key}`)}`)
    return await this.getOrCreate(userId)
  }

  /** 解开这个会话的工具收口(有的话)。 */
  #liftFor(record) {
    if (typeof record?.liftRestriction !== 'function') return
    try { record.liftRestriction() } catch (error) {
      this.#log.warn(`解除工具收口失败:${error?.message ?? error}`)
    }
    record.liftRestriction = undefined
  }

  /** 插件卸载时清干净,别把 agent 泄漏在后台跑 */
  async disposeAll() {
    for (const record of this.#records.values()) {
      this.#liftFor(record)
      try { await record.handle.dispose() } catch { /* 忽略 */ }
    }
    this.#records.clear()
    this.#bySessionId.clear()
  }
}

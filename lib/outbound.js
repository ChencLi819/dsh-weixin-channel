// 出站:DSH 助手回复 → 微信消息。
//
// 挂 ctx.on('session/event') 上,按 sessionId 反查是不是微信会话。
// 只认 assistant/message(durable 的最终消息),不接流式 —— 微信不是流式界面,
// 一条条改消息比等完整再发体验更差。
const TAG_RE = /<\/?[a-zA-Z][^>]*>/g

/** 从 assistant/message 的 content 块里抽纯文本 */
export function extractText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'text' && block.text) parts.push(block.text)
  }
  // 用 '\n' 而不是 '' 拼接:一条助手消息里可能有多个文本块(中间夹着工具调用),
  // 直接粘起来会变成「我先看看看完了」。dsh-qqbot 的 outbound 也是这么拼的。
  return parts.join('\n').trim()
}

/**
 * 按上限切分文本。优先在段落/句子边界切,别把话切一半。
 * 微信单条消息太长会被截断,所以宁可多发几条。
 */
export function chunkText(text, maxChars) {
  const limit = Number(maxChars) > 0 ? Number(maxChars) : 2000
  const source = String(text ?? '')
  if (source.length <= limit) return source ? [source] : []

  const out = []
  let rest = source
  while (rest.length > limit) {
    const window = rest.slice(0, limit)
    // 依次尝试:段落 → 换行 → 中文句末 → 英文句末 → 空格 → 硬切
    let cut = -1
    for (const boundary of ['\n\n', '\n', '。', '！', '？', '. ', '! ', '? ', ' ']) {
      const at = window.lastIndexOf(boundary)
      if (at > limit * 0.5) { cut = at + boundary.length; break }
    }
    if (cut <= 0) cut = limit
    out.push(rest.slice(0, cut).trim())
    rest = rest.slice(cut)
  }
  if (rest.trim()) out.push(rest.trim())
  return out.filter(Boolean)
}

/** 出站处理器工厂 */
export function createOutbound({ settings, log, client, sessions, onSent }) {
  /** 同一会话并发发消息要排队,否则多条消息会乱序 */
  const queues = new Map()

  const enqueue = (userId, task) => {
    const prev = queues.get(userId) ?? Promise.resolve()
    const next = prev.then(task, task)
    queues.set(userId, next.catch(() => {}))
    return next
  }

  const send = async (userId, text) => {
    const pieces = chunkText(text, settings.send.maxChars)
    for (const piece of pieces) {
      try {
        await client.sendText(userId, piece)
        log.info(`→ 发出 ${userId}: ${piece.slice(0, 120)}`)
        // 计数。以前这里没有 —— diagnostics.sent 从头到尾没人加过,
        // 于是 wechat_status 永远报「发出 0 条」,明明发出去好几条。
        try { onSent?.(userId, piece) } catch { /* 计数失败不该影响发送 */ }
      } catch (error) {
        log.error(`发送失败:${error?.message ?? error}`)
        throw error
      }
    }
  }

  /**
   * 「手动发过就别自动再发一遍」的窗口。
   *
   * 背景:助手回复的正文会被 onSessionEvent 自动发出去;而 wechat_send 也能
   * 发文字。模型要是用 wechat_send 回了话、正文又写了同样一句,对方就会收到
   * 两遍。dsh-qqbot 没这个问题是因为它的 qqbot_send_file 只发文件、不发文字。
   *
   * 判据是「同一个 userId + 一字不差的文本 + 短时间内」—— 模型不会真的想发
   * 两条一模一样的话,所以误伤的概率极低。窗口给 90 秒,够一轮 turn 跑完。
   */
  const MANUAL_WINDOW_MS = 90_000
  const manualSends = new Map()   // `${userId}\u0000${text}` → 时间戳

  const manualKey = (userId, text) => `${userId}\u0000${String(text).trim()}`

  const pruneManual = (now) => {
    for (const [key, at] of manualSends) {
      if (now - at > MANUAL_WINDOW_MS) manualSends.delete(key)
    }
  }

  return {
    /** 注册到 ctx.on('session/event') */
    async onSessionEvent(session, raw) {
      const sessionId = session?.header?.id ?? session?.id
      if (!sessionId) return
      const record = sessions.findBySessionId(sessionId)
      if (!record) return   // 不是微信会话,不管

      if (raw?.type !== 'assistant/message') return
      const text = extractText(raw?.data?.message?.content)
      if (!text) return

      // 去掉可能混进来的 XML/HTML 标签(有些模型会吐 <answer> 之类)
      const cleaned = text.replace(TAG_RE, '').trim()
      if (!cleaned) return

      // 这一轮里 wechat_send 已经手动发过一模一样的话 → 别再发一遍
      const now = Date.now()
      pruneManual(now)
      const key = manualKey(record.userId, cleaned)
      if (manualSends.has(key)) {
        manualSends.delete(key)
        log.info(`跳过自动重发(${record.userId} 刚用 wechat_send 发过同样的话)`)
        return
      }

      await enqueue(record.userId, () => send(record.userId, cleaned))
    },

    /** 工具手动发过文字时登记一笔,免得正文再自动发一遍 */
    noteManualTextSend(userId, text) {
      const value = String(text ?? '').trim()
      if (!value) return
      const now = Date.now()
      pruneManual(now)
      manualSends.set(manualKey(userId, value), now)
    },

    /** 供工具直接调用(绕过事件) */
    async sendTo(userId, text) {
      return await enqueue(userId, () => send(userId, text))
    },
  }
}

// 入站:微信消息 → DSH 会话。
//
// 这一层是安全边界,顺序不能乱:
//   1. 去重(同一条消息可能被重复投递)
//   2. 白名单(不在名单里的一律不处理 —— 这是唯一挡住「陌生人拿到机器人」的闸门)
//   3. 存 context_token(不回带它,后面就发不出消息)
//   4. 媒体落盘
//   5. 交给会话
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { extname } from 'node:path'

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'video/mp4': '.mp4', 'audio/wav': '.wav', 'audio/mpeg': '.mp3', 'audio/silk': '.silk',
  'application/pdf': '.pdf', 'application/zip': '.zip',
}

const MAX_INBOUND_MB = 25

/** 决定这条消息该不该处理 —— 安全闸门 */
export function isAllowed(msg, { settings, store, log }) {
  const userId = String(msg.userId ?? '')
  if (!userId) return false

  const allow = settings.allow
  // 明确写进白名单的,放行
  if (Array.isArray(allow.users) && allow.users.map(String).includes(userId)) return true

  // 白名单为空 → 退化成「只放行登录者本人」。
  // ⚠️ 这里绝不能写成「列表为空就放行所有人」—— 那是插件 v2.4.8 的老毛病,
  //    等于把机器人敞开给任何能找到它的人。
  if (!allow.users || allow.users.length === 0) {
    const selfId = store.getMeta('userId') || ''
    if (selfId && userId === String(selfId)) return true
    if (allow.selfOnly) {
      if (!allow.silentDrop) log.info(`丢弃非本人消息:${userId}(登录者=${selfId || '未知'})`)
      return false
    }
  }

  // 白名单非空但没命中,且没开 selfOnly → 仍然拒绝(默认拒绝,不是默认放行)
  if (!allow.silentDrop) log.info(`丢弃非白名单消息:${userId}`)
  return false
}

function safeFileName(name, fallback) {
  const base = String(name ?? '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim()
  return base && base !== '.' && base !== '..' ? base.slice(0, 120) : fallback
}

/** 把入站媒体写到 <stateDir>/media/,返回本地路径 + 原始字节(图片要再喂给 attachments) */
async function saveMedia(client, stateDir, userId, item, index, log) {
  const dir = join(stateDir, 'media', String(userId).replace(/[^A-Za-z0-9_.@-]/g, '_'))
  try {
    const downloaded = await client.download(item.message)
    if (!downloaded?.data) return null
    const bytes = downloaded.data
    if (bytes.length > MAX_INBOUND_MB * 1024 * 1024) {
      log.warn(`入站媒体超过 ${MAX_INBOUND_MB}MB,跳过`)
      return null
    }
    const ext = downloaded.fileName ? extname(downloaded.fileName) : (EXT_BY_MIME[downloaded.mimeType] ?? '.bin')
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}-${index}${ext || '.bin'}`
    mkdirSync(dir, { recursive: true })
    const file = join(dir, name)
    writeFileSync(file, bytes)
    return {
      file,
      type: downloaded.type ?? item.kind,
      bytes: bytes.length,
      fileName: downloaded.fileName,
      mimeType: downloaded.mimeType,
      data: bytes,
    }
  } catch (error) {
    log.warn(`下载入站媒体失败:${error?.message ?? error}`)
    return null
  }
}

/** attachments 只认这四种图片格式,别的还是走落盘 */
const NATIVE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif'])

/**
 * 把图片交给 DSH 的 attachments 服务,换成一个可以直接放进消息内容的引用。
 *
 * 为什么要这一步:第一版是「落盘 + 正文里写路径」,靠 agent 用文件工具去读。
 * 但工具收口之后微信会话**没有文件工具了**,路径就成了摆设 —— 图发进来模型
 * 根本看不见。attachments 让图片直接进模型视野,不依赖任何工具。
 *
 * 拿不到服务或格式不支持时返回 null,由调用方回落到路径写法。
 */
async function toImageBlock(attachments, item, log) {
  if (!attachments?.saveImage) return null
  const mime = String(item.mimeType ?? '')
  if (!NATIVE_IMAGE_TYPES.has(mime)) {
    log.info(`图片格式 ${mime || '未知'} attachments 不收,回落到落盘路径`)
    return null
  }
  try {
    const ref = await attachments.saveImage({
      data: item.data,
      mediaType: mime,
      name: item.fileName ?? undefined,
    })
    return { type: 'image', attachment: ref }
  } catch (error) {
    log.warn(`交给 attachments 失败:${error?.message ?? error} —— 回落到落盘路径`)
    return null
  }
}

/**
 * 自检:走一遍「入站图片 → attachments 原生图片块」这条路。
 *
 * 为什么值得单独验:这是**入站图片唯一的通路**。收口之后微信会话没有文件工具,
 * 图片要是没变成原生块、只落了个路径,模型就完全看不见那张图 —— 而现象是
 * 「她收到了图但答非所问」,很难联想到是这条路断了。
 *
 * 用一张 1x1 的 PNG,不碰网络、不碰微信,所以可以随时跑。
 *
 * @returns {{ok: boolean, reason?: string, ref?: unknown}}
 */
export async function selftestAttachments(attachments, log) {
  if (!attachments?.saveImage) {
    return { ok: false, reason: 'attachments 服务拿不到(启动日志里应该有说明)' }
  }
  // 1x1 透明 PNG
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  )
  const item = {
    kind: 'image',
    file: '(selftest)',
    fileName: 'selftest.png',
    mimeType: 'image/png',
    bytes: png.length,
    data: png,
  }
  const block = await toImageBlock(attachments, item, log)
  if (!block) return { ok: false, reason: 'saveImage 没成功(失败原因见日志)' }
  return { ok: true, ref: block.attachment }
}

/**
 * 把一条 IncomingMessage 整理成给 agent 的内容。
 * 微信里常见的形态:一段文字、一张图、一条语音(可能带平台转写)、一个文件。
 *
 * 返回:
 *   body    —— 文本正文(日志和兜底用)
 *   content —— 真正投给会话的内容数组:文本块 + 原生图片块
 *   attachments —— 落盘的文件信息(仍是落盘的,语音/文件/视频走这条路)
 */
export async function buildAgentBody(msg, { client, settings, stateDir, log, attachments }) {
  const parts = []
  const saved = []

  const items = []
  for (const image of msg.images ?? []) items.push({ kind: 'image', message: { ...msg, raw: msg.raw }, image })
  for (const voice of msg.voices ?? []) items.push({ kind: 'voice', message: { ...msg, raw: msg.raw }, voice })
  for (const file of msg.files ?? []) items.push({ kind: 'file', message: { ...msg, raw: msg.raw }, file })
  for (const video of msg.videos ?? []) items.push({ kind: 'video', message: { ...msg, raw: msg.raw }, video })

  for (let i = 0; i < items.length; i++) {
    const savedOne = await saveMedia(client, stateDir, msg.userId, items[i], i, log)
    if (savedOne) saved.push({ ...savedOne, kind: items[i].kind })
  }

  // 文本正文
  const text = String(msg.text ?? '').trim()
  if (text) parts.push(text)

  // 语音:平台自带转写优先(不花钱、最准),没有就提示有语音文件
  for (const voice of msg.voices ?? []) {
    const transcript = String(voice.text ?? '').trim()
    if (transcript) parts.push(transcript)
  }

  // 图片优先走 attachments(原生进模型);成功的话正文里就不再写路径。
  const imageBlocks = []
  const nativeImages = new Set()
  for (const item of saved) {
    if (item.kind !== 'image') continue
    const block = await toImageBlock(attachments, item, log)
    if (block) {
      imageBlocks.push(block)
      nativeImages.add(item.file)
    }
  }

  for (const item of saved) {
    if (item.kind === 'image') {
      if (!nativeImages.has(item.file)) parts.push(`[图片] ${item.file}`)
    } else if (item.kind === 'voice') parts.push(`[语音] ${item.file}`)
    else if (item.kind === 'video') parts.push(`[视频] ${item.file}`)
    else parts.push(`[文件] ${item.file}${item.fileName ? ` (原名 ${item.fileName})` : ''}`)
  }

  if (msg.quotedMessage?.text) parts.push(`(引用了一条消息:${msg.quotedMessage.text})`)

  const body = parts.filter(Boolean).join('\n').trim()
  // 内容顺序:先文字说明,再图片 —— 和微信里「配文 + 图」的阅读顺序一致。
  const content = []
  if (body) content.push({ type: 'text', text: body })
  for (const block of imageBlocks) content.push(block)
  // 纯图片没配文时也得有内容,否则会话收到空消息
  if (content.length === 0 && saved.length > 0) {
    content.push({ type: 'text', text: '(对方发来了媒体,但没能取到内容)' })
  }

  return {
    body: body || (imageBlocks.length ? '(发来一张图片)' : ''),
    content,
    attachments: saved,
    nativeImageCount: imageBlocks.length,
  }
}

/** 组装入站处理器 */
export function createInbound({ settings, store, log, sessions, client, stateDir, onDelivered, attachments }) {
  return async function handleInbound(msg) {
    const userId = String(msg.userId ?? '')
    if (!userId) return

    // 1. 去重:message_id 或 client_id 都行,优先 message_id
    const raw = msg.raw ?? {}
    const msgId = String(raw.message_id ?? raw.client_id ?? '')
    if (msgId) {
      if (store.hasSeen(msgId)) return
      store.markSeen(msgId, settings.receive.dedupeSize)
    }

    // 2. 白名单 —— 必须在任何下载/投递之前
    if (!isAllowed(msg, { settings, store, log })) return

    // 3. context_token:出站回带用,必须存
    if (msg._contextToken) store.setContext(userId, msg._contextToken)

    // 4. 媒体落盘 + 组正文(图片会另外换成 attachments 引用,直接进模型)
    const { body, content, nativeImageCount } = await buildAgentBody(msg, { client, settings, stateDir, log, attachments })
    if (!body) return
    if (nativeImageCount) log.info(`其中 ${nativeImageCount} 张图片已交给 attachments(不依赖文件工具)`)

    // 5. 重置指令
    const resetCommand = String(settings.session.resetCommand ?? '').trim()
    if (resetCommand && body.trim() === resetCommand) {
      await sessions.reset(userId)
      await client.sendText(userId, '好，重新开始。')
      log.info(`会话已重置:${userId}`)
      return
    }

    log.info(`← 收到 ${userId}: ${body.slice(0, 160)}`)
    try {
      await client.sendTyping(userId)
    } catch { /* 提示失败不影响 */ }

    try {
      await sessions.deliver(userId, body, { content })
    } catch (error) {
      log.error(`投递失败:${error?.stack ?? error}`)
      try {
        await client.sendText(userId, '⚠️ 处理这条消息时出错了,稍后再试。')
      } catch { /* 兜底也失败就算了 */ }
    } finally {
      try { await client.stopTyping(userId) } catch { /* 忽略 */ }
    }
    onDelivered?.(userId)
  }
}

// ═══════════════════════════════════════════════════════════════════════
// @wechatbot/wechatbot — WeChat iLink Bot SDK
//
// A modular, extensible, production-grade SDK for building WeChat bots.
//
// Architecture layers:
//   Transport → Protocol → Services → Application
//                              ↑
//                        Middleware Chain
//
// Quick start:
//   import { WeChatBot } from '@wechatbot/wechatbot'
//
//   const bot = new WeChatBot()
//   await bot.login()
//   bot.onMessage(async (msg) => {
//     await bot.reply(msg, `Echo: ${msg.text}`)
//   })
//   await bot.start()
// ═══════════════════════════════════════════════════════════════════════
// ── Core ────────────────────────────────────────────────────────────────
export { WeChatBot } from './core/client.js';
export { TypedEmitter } from './core/events.js';
export { ApiError, AuthError, MediaError, NoContextError, TransportError, WeChatBotError, } from './core/errors.js';
// ── Message ─────────────────────────────────────────────────────────────
export { MessageBuilder } from './message/builder.js';
// ── Middleware ───────────────────────────────────────────────────────────
export { MiddlewareEngine } from './middleware/engine.js';
export { filterMiddleware, loggingMiddleware, rateLimitMiddleware, typeFilterMiddleware, } from './middleware/builtins.js';
// ── Media ───────────────────────────────────────────────────────────────
export { MediaDownloader, MediaUploader } from './media/index.js';
export { categorizeByMime, getExtensionFromContentTypeOrUrl, getExtensionFromMime, getMimeFromFilename, } from './media/mime.js';
export { silkToWav, SILK_SAMPLE_RATE } from './media/voice.js';
export { downloadFromUrl } from './media/remote.js';
export { stripMarkdown } from './media/markdown.js';
// ── Storage ─────────────────────────────────────────────────────────────
export { FileStorage, MemoryStorage } from './storage/index.js';
// ── Logger ──────────────────────────────────────────────────────────────
export { createLogger, BotLogger, StderrTransport } from './logger/logger.js';
// ── Protocol (advanced) ─────────────────────────────────────────────────
export { MessageType, MessageState, MessageItemType, MediaType, } from './protocol/types.js';
//# sourceMappingURL=index.js.map
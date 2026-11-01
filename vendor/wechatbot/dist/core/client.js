import { TypedEmitter } from './events.js';
import { NoContextError } from './errors.js';
import { Authenticator } from '../auth/index.js';
import { createLogger } from '../logger/index.js';
import { MediaDownloader, MediaUploader, categorizeByMime, getMimeFromFilename, downloadFromUrl, silkToWav, } from '../media/index.js';
import { MessageBuilder, MessageParser } from '../message/index.js';
import { MiddlewareEngine } from '../middleware/index.js';
import { ContextStore, MessagePoller, MessageSender, TypingService } from '../messaging/index.js';
import { ILinkApi } from '../protocol/api.js';
import { DEFAULT_BASE_URL, MediaType } from '../protocol/types.js';
import { FileStorage, MemoryStorage } from '../storage/index.js';
import { HttpClient } from '../transport/http.js';
// ═══════════════════════════════════════════════════════════════════════
// Main Client
// ═══════════════════════════════════════════════════════════════════════
/**
 * WeChatBot — the main entry point.
 *
 * ## Quick Start
 *
 * ```typescript
 * const bot = new WeChatBot()
 * await bot.login()
 *
 * bot.onMessage(async (msg) => {
 *   // Simple text reply
 *   await bot.reply(msg, 'Echo: ' + msg.text)
 *
 *   // Image reply
 *   await bot.reply(msg, { image: imgBuffer, caption: 'Here!' })
 *
 *   // File reply (auto-routes: .png → image, .mp4 → video, .pdf → file)
 *   await bot.reply(msg, { file: data, fileName: 'report.pdf' })
 *
 *   // Send from URL
 *   await bot.reply(msg, { url: 'https://example.com/photo.jpg' })
 *
 *   // Download media from incoming message
 *   const media = await bot.download(msg)
 *   if (media) console.log(media.type, media.data.length)
 * })
 *
 * await bot.start()
 * ```
 */
export class WeChatBot extends TypedEmitter {
    // ── Public components (accessible for advanced use) ─────────────────
    logger;
    storage;
    uploader;
    downloader;
    // ── Internal services ───────────────────────────────────────────────
    http;
    api;
    auth;
    parser;
    middleware;
    contextStore;
    poller;
    sender;
    typing;
    // ── State ───────────────────────────────────────────────────────────
    baseUrl;
    credentials;
    messageHandlers = [];
    runPromise = null;
    constructor(options = {}) {
        super();
        // Initialize foundational components
        this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
        this.logger = options.logger ?? createLogger({ level: options.logLevel ?? 'info' });
        this.storage = resolveStorage(options);
        // Build the layered architecture
        this.http = new HttpClient({ logger: this.logger });
        this.api = new ILinkApi(this.http, options.botAgent);
        this.auth = new Authenticator(this.api, this.storage, this.logger);
        this.parser = new MessageParser();
        this.middleware = new MiddlewareEngine();
        this.contextStore = new ContextStore(this.storage, this.logger);
        this.poller = new MessagePoller(this.api, this.storage, this.logger);
        this.sender = new MessageSender(this.api, this.contextStore, this.logger);
        this.typing = new TypingService(this.api, this.contextStore, this.logger);
        this.uploader = new MediaUploader(this.api, undefined, this.logger);
        this.downloader = new MediaDownloader(undefined, this.logger);
        // Wire up internal events
        this.setupPollerEvents();
    }
    // ═══════════════════════════════════════════════════════════════════
    // Auth
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Login to WeChat. Uses stored credentials if available, otherwise starts QR flow.
     */
    async login(options = {}) {
        const creds = await this.auth.login({
            force: options.force,
            baseUrl: this.baseUrl,
            callbacks: options.callbacks,
        });
        this.setCredentials(creds);
        this.emit('login', creds);
        return creds;
    }
    /** Get current credentials (undefined if not logged in). */
    getCredentials() {
        return this.credentials;
    }
    // ═══════════════════════════════════════════════════════════════════
    // Middleware
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Register middleware for the message processing pipeline.
     * Middleware runs before message handlers, in order of registration.
     *
     * @example
     *   bot.use(loggingMiddleware(bot.logger))
     *   bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
     */
    use(middleware) {
        this.middleware.use(middleware);
        return this;
    }
    // ═══════════════════════════════════════════════════════════════════
    // Message Handlers
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Register a message handler.
     * Called after middleware for every incoming user message.
     */
    onMessage(handler) {
        this.messageHandlers.push(handler);
        return this;
    }
    on(event, handler) {
        if (event === 'message') {
            return this.onMessage(handler);
        }
        return super.on(event, handler);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Sending — two methods: reply() and send()
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Reply to an incoming message.
     * Automatically uses the correct context_token and cancels typing.
     *
     * @example
     *   // Text
     *   await bot.reply(msg, 'Hello!')
     *   await bot.reply(msg, { text: 'Hello!' })
     *
     *   // Image with optional caption
     *   await bot.reply(msg, { image: pngBuffer, caption: 'Screenshot' })
     *
     *   // File (auto-routes by extension: .png → image, .mp4 → video, else → file)
     *   await bot.reply(msg, { file: data, fileName: 'report.pdf' })
     *   await bot.reply(msg, { file: data, fileName: 'photo.png' })  // sent as image
     *
     *   // Video
     *   await bot.reply(msg, { video: mp4Buffer })
     *
     *   // From URL (auto-download, auto-detect type)
     *   await bot.reply(msg, { url: 'https://example.com/image.jpg' })
     */
    async reply(message, content) {
        const creds = this.requireCredentials();
        this.contextStore.set(message.userId, message._contextToken);
        await this.sendContent(message.userId, message._contextToken, content);
        this.typing.stopTyping(creds.baseUrl, creds.token, message.userId).catch(() => { });
    }
    /**
     * Send content to a user by ID.
     * Requires a prior context_token from that user (i.e., they messaged you first).
     *
     * Same content options as reply().
     *
     * @example
     *   await bot.send(userId, 'Hello!')
     *   await bot.send(userId, { image: buffer })
     *   await bot.send(userId, { file: data, fileName: 'doc.pdf' })
     *   await bot.send(userId, { url: 'https://example.com/img.png' })
     */
    async send(userId, content) {
        const ctx = this.contextStore.get(userId);
        if (!ctx)
            throw new NoContextError(userId);
        await this.sendContent(userId, ctx, content);
    }
    /**
     * Send a pre-built message payload (advanced use with MessageBuilder).
     */
    async sendRaw(payload) {
        const creds = this.requireCredentials();
        await this.sender.sendRaw(creds.baseUrl, creds.token, payload);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Downloading — one method: download()
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Download media from an incoming message.
     *
     * Detects and downloads the first media item found.
     * Priority: image > file > video > voice.
     * Voice is auto-transcoded from SILK to WAV (if silk-wasm is installed).
     *
     * Returns null if the message has no media.
     *
     * @example
     *   bot.onMessage(async (msg) => {
     *     const media = await bot.download(msg)
     *     if (media) {
     *       console.log(media.type)     // 'image' | 'file' | 'video' | 'voice'
     *       console.log(media.data)     // Buffer
     *       console.log(media.fileName) // 'report.pdf' (for files)
     *       console.log(media.format)   // 'wav' | 'silk' (for voice)
     *     }
     *   })
     */
    async download(message) {
        // Image
        const img = message.images[0];
        if (img?.media) {
            const data = await this.downloader.download(img.media, img.aeskey);
            return { data, type: 'image' };
        }
        // File
        const file = message.files[0];
        if (file?.media) {
            const data = await this.downloader.download(file.media);
            return { data, type: 'file', fileName: file.fileName ?? 'file.bin' };
        }
        // Video
        const video = message.videos[0];
        if (video?.media) {
            const data = await this.downloader.download(video.media);
            return { data, type: 'video' };
        }
        // Voice (auto-transcode)
        const voice = message.voices[0];
        if (voice?.media) {
            const silkBuf = await this.downloader.download(voice.media);
            const wav = await silkToWav(silkBuf, this.logger);
            if (wav)
                return { data: wav, type: 'voice', format: 'wav' };
            return { data: silkBuf, type: 'voice', format: 'silk' };
        }
        return null;
    }
    /**
     * Download and decrypt a media file from a raw CDN reference.
     * For advanced use when you need direct access to CDNMedia objects.
     */
    async downloadRaw(media, aeskeyOverride) {
        return this.downloader.download(media, aeskeyOverride);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Upload (advanced)
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Upload a file to WeChat CDN and return the CDN reference.
     * Does NOT send a message — use reply()/send() for the full pipeline.
     * For advanced use when you need to compose complex messages via MessageBuilder.
     */
    async upload(options) {
        const creds = this.requireCredentials();
        return this.uploader.upload(creds.baseUrl, creds.token, options);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Typing
    // ═══════════════════════════════════════════════════════════════════
    /** Show "typing..." indicator to a user. */
    async sendTyping(userId) {
        const creds = this.requireCredentials();
        await this.typing.startTyping(creds.baseUrl, creds.token, userId);
    }
    /** Cancel "typing..." indicator for a user. */
    async stopTyping(userId) {
        const creds = this.requireCredentials();
        await this.typing.stopTyping(creds.baseUrl, creds.token, userId);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Lifecycle
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Start receiving messages (long-poll loop).
     * Call login() first if not already authenticated.
     */
    async start() {
        if (this.runPromise)
            return this.runPromise;
        const creds = this.requireCredentials();
        // Load persisted state
        await Promise.all([
            this.contextStore.load(),
            this.poller.loadCursor(),
        ]);
        // Tell the server we're coming online (non-fatal)
        await this.api.notifyStart(creds.baseUrl, creds.token).catch((error) => {
            this.logger.warn(`notifyStart failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
        });
        this.emit('poll:start');
        this.runPromise = this.poller.start(creds.baseUrl, creds.token);
        try {
            await this.runPromise;
        }
        finally {
            this.runPromise = null;
            // Tell the server we're going offline (non-fatal).
            // Credentials may have rotated after a mid-poll re-login, so re-read them.
            const current = this.credentials ?? creds;
            await this.api.notifyStop(current.baseUrl, current.token).catch((error) => {
                this.logger.warn(`notifyStop failed (ignored): ${error instanceof Error ? error.message : String(error)}`);
            });
            this.emit('poll:stop');
        }
    }
    /**
     * Convenience method: login + start in one call.
     * Equivalent to `await bot.login(); await bot.start()`.
     */
    async run(options) {
        await this.login(options);
        await this.start();
    }
    /** Stop the bot gracefully. */
    stop() {
        this.poller.stop();
        this.contextStore.flush().catch(() => { });
        this.emit('close');
    }
    /** Whether the bot is currently polling for messages. */
    get isRunning() {
        return this.poller.isRunning;
    }
    // ═══════════════════════════════════════════════════════════════════
    // Utility
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Create a MessageBuilder for composing complex messages.
     */
    createMessage(userId) {
        const ctx = this.contextStore.get(userId);
        if (!ctx)
            throw new NoContextError(userId);
        return MessageBuilder.to(userId, ctx);
    }
    // ═══════════════════════════════════════════════════════════════════
    // Internal: unified send pipeline
    // ═══════════════════════════════════════════════════════════════════
    /**
     * Core send implementation. All public send methods route through here.
     */
    async sendContent(userId, contextToken, content) {
        const creds = this.requireCredentials();
        // String shorthand → text
        if (typeof content === 'string') {
            await this.sender.sendText(creds.baseUrl, creds.token, userId, content, contextToken);
            return;
        }
        // { text }
        if ('text' in content) {
            await this.sender.sendText(creds.baseUrl, creds.token, userId, content.text, contextToken);
            return;
        }
        // { url } → download then re-route
        if ('url' in content) {
            const result = await downloadFromUrl(content.url, { logger: this.logger });
            const fileName = content.fileName ?? result.filename;
            return this.sendContent(userId, contextToken, {
                file: result.data,
                fileName,
                caption: content.caption,
            });
        }
        // { image }
        if ('image' in content) {
            await this.sendMediaBuffer(creds, userId, contextToken, content.image, MediaType.IMAGE, (builder, result) => {
                builder.image({ media: result.media, midSize: result.encryptedFileSize });
            }, content.caption);
            return;
        }
        // { video }
        if ('video' in content) {
            await this.sendMediaBuffer(creds, userId, contextToken, content.video, MediaType.VIDEO, (builder, result) => {
                builder.video({ media: result.media, videoSize: result.encryptedFileSize });
            }, content.caption);
            return;
        }
        // { voice, playtime } — 本地补丁(上游没有)
        // 显式指定才走语音:不去改 categorizeByMime,免得发个 mp3 文件
        // 被悄悄变成语音消息。
        if ('voice' in content) {
            await this.sendMediaBuffer(creds, userId, contextToken, content.voice, MediaType.VOICE, (builder, result) => {
                builder.voice({
                    media: result.media,
                    playtime: content.playtime,
                    encodeType: content.encodeType ?? 1,
                    bitsPerSample: content.bitsPerSample ?? 16,
                    sampleRate: content.sampleRate ?? 24000,
                });
            });
            return;
        }
        // { file, fileName } — auto-route by extension
        if ('file' in content) {
            const mime = getMimeFromFilename(content.fileName);
            const category = categorizeByMime(mime);
            if (category === 'image') {
                return this.sendContent(userId, contextToken, {
                    image: content.file,
                    caption: content.caption,
                });
            }
            if (category === 'video') {
                return this.sendContent(userId, contextToken, {
                    video: content.file,
                    caption: content.caption,
                });
            }
            // Generic file
            if (content.caption) {
                await this.sender.sendText(creds.baseUrl, creds.token, userId, content.caption, contextToken);
            }
            await this.sendMediaBuffer(creds, userId, contextToken, content.file, MediaType.FILE, (builder, result) => {
                builder.file({ media: result.media, fileName: content.fileName, size: content.file.length });
            });
            return;
        }
    }
    /**
     * Upload buffer to CDN and send as a message item.
     */
    async sendMediaBuffer(creds, userId, contextToken, data, mediaType, buildItem, caption) {
        const result = await this.uploader.upload(creds.baseUrl, creds.token, {
            data,
            userId,
            mediaType,
        });
        const builder = MessageBuilder.to(userId, contextToken);
        if (caption)
            builder.text(caption);
        buildItem(builder, result);
        await this.sender.sendRaw(creds.baseUrl, creds.token, builder.build());
        this.logger.info('Sent media', { userId, mediaType, size: data.length });
    }
    // ═══════════════════════════════════════════════════════════════════
    // Internal wiring
    // ═══════════════════════════════════════════════════════════════════
    setupPollerEvents() {
        // Process incoming messages through the pipeline
        this.poller.on('messages', async (messages) => {
            for (const wire of messages) {
                // Always remember context tokens
                this.contextStore.remember(wire);
                // Parse to user-friendly format
                const incoming = this.parser.parse(wire);
                if (!incoming)
                    continue;
                // Run through middleware chain
                const ctx = await this.middleware.run(incoming);
                if (ctx.handled)
                    continue;
                // Dispatch to message handlers
                this.emit('message', incoming);
                await this.dispatchToHandlers(incoming);
            }
            // Persist context tokens after batch
            this.contextStore.flush().catch(() => { });
        });
        // Handle session expiry.
        //
        // LOCAL PATCH (see vendor/NOTICE.md): 这里**不再自动重登**。
        //
        // 原来的自动重登有两个致命问题:
        //
        //   1. 它调 `this.login({ force: true })` 时**不传 callbacks**,于是
        //      申请来的二维码不会交给任何人 —— 不落盘、不进实时页面、用户
        //      根本看不见,只能等它自己过期。实测刷出过 63 次
        //      "QR code expired 3 times — login aborted",而二维码文件数是 0。
        //   2. 每次扫码登录都会在服务端创建一个**新的机器人身份**,把上一个
        //      踢下线。如果 token 本身有问题,这就成了自激循环(实测 483 次
        //      -14)。
        //
        // 会话过期时唯一能真正修好它的是**人去扫一次码**。所以这里停下来,
        // 把事件交给渠道层 —— 渠道层带着完整的 callbacks 重新发起登录,
        // 那时二维码才会落盘、才会进实时页面,用户也才扫得到。
        this.poller.on('session:expired', async (info) => {
            const consecutive = info?.consecutive ?? 1;
            this.emit('session:expired');
            this.logger.error(`会话过期(连续第 ${consecutive} 次)—— 停止轮询,等渠道层重新发起登录`);
            this.poller.stop();
            this.emit('relogin:exhausted', { consecutive, reason: 'session-expired' });
        });
        // Forward poller errors
        this.poller.on('error', (error) => {
            this.emit('error', error);
        });
    }
    async dispatchToHandlers(message) {
        const results = await Promise.allSettled(this.messageHandlers.map((handler) => handler(message)));
        for (const result of results) {
            if (result.status === 'rejected') {
                this.logger.error(`Handler error: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
                this.emit('error', result.reason);
            }
        }
    }
    setCredentials(creds) {
        const previousToken = this.credentials?.token;
        this.credentials = creds;
        this.baseUrl = creds.baseUrl;
        // If token changed, clear stale state
        if (previousToken && previousToken !== creds.token) {
            this.contextStore.clear().catch(() => { });
            this.typing.clearCache();
            this.poller.resetCursor().catch(() => { });
        }
    }
    requireCredentials() {
        if (!this.credentials) {
            throw new Error('Not logged in. Call login() first.');
        }
        return this.credentials;
    }
}
// ── Helpers ─────────────────────────────────────────────────────────────
function resolveStorage(options) {
    if (options.storage === undefined || options.storage === 'file') {
        return new FileStorage(options.storageDir);
    }
    if (options.storage === 'memory') {
        return new MemoryStorage();
    }
    return options.storage; // Custom Storage instance
}
//# sourceMappingURL=client.js.map
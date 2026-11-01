import { TypedEmitter, type BotEventMap } from './events.js';
import { type Credentials, type QrLoginCallbacks } from '../auth/index.js';
import { type Logger, type LogLevel } from '../logger/index.js';
import { MediaDownloader, MediaUploader, type UploadOptions, type UploadResult } from '../media/index.js';
import { MessageBuilder, type IncomingMessage } from '../message/index.js';
import { type Middleware } from '../middleware/index.js';
import { type CDNMedia } from '../protocol/types.js';
import { type Storage } from '../storage/index.js';
export interface WeChatBotOptions {
    /** Base URL for the iLink API (default: https://ilinkai.weixin.qq.com) */
    baseUrl?: string;
    /** Storage backend: 'file', 'memory', or a custom Storage instance */
    storage?: 'file' | 'memory' | Storage;
    /** Directory for file storage (only used when storage is 'file') */
    storageDir?: string;
    /** Log level */
    logLevel?: LogLevel;
    /** Custom logger instance */
    logger?: Logger;
    /** QR login callbacks (for rendering QR codes, etc.) */
    loginCallbacks?: QrLoginCallbacks;
    /**
     * UA-style identifier of the app driving this bot, sent as `base_info.bot_agent`
     * on every API request (e.g. "MyApp/1.2 (prod)"). Invalid values fall back to
     * "WeChatBot/<version>".
     */
    botAgent?: string;
}
/**
 * What to send. Exactly one of text/image/file/video/url must be provided.
 *
 * @example
 *   // Text
 *   await bot.reply(msg, { text: 'Hello!' })
 *
 *   // Image with caption
 *   await bot.reply(msg, { image: imgBuffer, caption: 'Here you go' })
 *
 *   // File
 *   await bot.reply(msg, { file: pdfBuffer, fileName: 'report.pdf' })
 *
 *   // Video
 *   await bot.reply(msg, { video: videoBuffer, caption: 'Check this out' })
 *
 *   // Auto-detect type from filename
 *   await bot.reply(msg, { file: data, fileName: 'photo.png' })  // → sent as image
 *
 *   // Remote URL (auto-download + auto-detect type)
 *   await bot.reply(msg, { url: 'https://example.com/photo.jpg' })
 */
export type SendContent = string | {
    text: string;
} | {
    image: Buffer;
    caption?: string;
} | {
    video: Buffer;
    caption?: string;
} | {
    file: Buffer;
    fileName: string;
    caption?: string;
} | {
    url: string;
    fileName?: string;
    caption?: string;
};
export interface DownloadedMedia {
    data: Buffer;
    type: 'image' | 'file' | 'video' | 'voice';
    fileName?: string;
    /** Voice format after transcoding: 'wav' or 'silk' */
    format?: string;
}
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
export declare class WeChatBot extends TypedEmitter<BotEventMap> {
    readonly logger: Logger;
    readonly storage: Storage;
    readonly uploader: MediaUploader;
    readonly downloader: MediaDownloader;
    private readonly http;
    private readonly api;
    private readonly auth;
    private readonly parser;
    private readonly middleware;
    private readonly contextStore;
    private readonly poller;
    private readonly sender;
    private readonly typing;
    private baseUrl;
    private credentials?;
    private messageHandlers;
    private runPromise;
    constructor(options?: WeChatBotOptions);
    /**
     * Login to WeChat. Uses stored credentials if available, otherwise starts QR flow.
     */
    login(options?: {
        force?: boolean;
        callbacks?: QrLoginCallbacks;
    }): Promise<Credentials>;
    /** Get current credentials (undefined if not logged in). */
    getCredentials(): Credentials | undefined;
    /**
     * Register middleware for the message processing pipeline.
     * Middleware runs before message handlers, in order of registration.
     *
     * @example
     *   bot.use(loggingMiddleware(bot.logger))
     *   bot.use(rateLimitMiddleware({ maxMessages: 10, windowMs: 60_000 }))
     */
    use(middleware: Middleware): this;
    /**
     * Register a message handler.
     * Called after middleware for every incoming user message.
     */
    onMessage(handler: (msg: IncomingMessage) => void | Promise<void>): this;
    /**
     * Event-style alias for onMessage.
     */
    on(event: 'message', handler: (msg: IncomingMessage) => void | Promise<void>): this;
    on<K extends keyof BotEventMap>(event: K, handler: (...args: BotEventMap[K]) => void | Promise<void>): this;
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
    reply(message: IncomingMessage, content: SendContent): Promise<void>;
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
    send(userId: string, content: SendContent): Promise<void>;
    /**
     * Send a pre-built message payload (advanced use with MessageBuilder).
     */
    sendRaw(payload: ReturnType<MessageBuilder['build']>): Promise<void>;
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
    download(message: IncomingMessage): Promise<DownloadedMedia | null>;
    /**
     * Download and decrypt a media file from a raw CDN reference.
     * For advanced use when you need direct access to CDNMedia objects.
     */
    downloadRaw(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer>;
    /**
     * Upload a file to WeChat CDN and return the CDN reference.
     * Does NOT send a message — use reply()/send() for the full pipeline.
     * For advanced use when you need to compose complex messages via MessageBuilder.
     */
    upload(options: UploadOptions): Promise<UploadResult>;
    /** Show "typing..." indicator to a user. */
    sendTyping(userId: string): Promise<void>;
    /** Cancel "typing..." indicator for a user. */
    stopTyping(userId: string): Promise<void>;
    /**
     * Start receiving messages (long-poll loop).
     * Call login() first if not already authenticated.
     */
    start(): Promise<void>;
    /**
     * Convenience method: login + start in one call.
     * Equivalent to `await bot.login(); await bot.start()`.
     */
    run(options?: {
        force?: boolean;
        callbacks?: QrLoginCallbacks;
    }): Promise<void>;
    /** Stop the bot gracefully. */
    stop(): void;
    /** Whether the bot is currently polling for messages. */
    get isRunning(): boolean;
    /**
     * Create a MessageBuilder for composing complex messages.
     */
    createMessage(userId: string): MessageBuilder;
    /**
     * Core send implementation. All public send methods route through here.
     */
    private sendContent;
    /**
     * Upload buffer to CDN and send as a message item.
     */
    private sendMediaBuffer;
    private setupPollerEvents;
    private dispatchToHandlers;
    private setCredentials;
    private requireCredentials;
}
//# sourceMappingURL=client.d.ts.map
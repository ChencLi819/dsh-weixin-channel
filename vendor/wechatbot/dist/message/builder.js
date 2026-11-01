import { randomUUID } from 'node:crypto';
import { MessageItemType, MessageState, MessageType, } from '../protocol/types.js';
/**
 * Fluent builder for outgoing messages.
 * Supports composing text + media items before sending.
 *
 * Usage:
 *   const payload = MessageBuilder.to(userId, contextToken)
 *     .text("Here's your image:")
 *     .image({ media, midSize: 12345 })
 *     .build()
 */
export class MessageBuilder {
    userId;
    contextToken;
    items = [];
    clientId = randomUUID();
    constructor(userId, contextToken) {
        this.userId = userId;
        this.contextToken = contextToken;
    }
    static to(userId, contextToken) {
        return new MessageBuilder(userId, contextToken);
    }
    /** Set a custom client_id (default: random UUID). */
    withClientId(id) {
        this.clientId = id;
        return this;
    }
    /** Add a text item. */
    text(content) {
        this.items.push({
            type: MessageItemType.TEXT,
            text_item: { text: content },
        });
        return this;
    }
    /** Add an image item with CDN media reference. */
    image(options) {
        this.items.push({
            type: MessageItemType.IMAGE,
            image_item: {
                media: options.media,
                mid_size: options.midSize,
                thumb_media: options.thumbMedia,
                thumb_size: options.thumbSize,
                thumb_width: options.thumbWidth,
                thumb_height: options.thumbHeight,
            },
        });
        return this;
    }
    /** Add a file item with CDN media reference. */
    file(options) {
        this.items.push({
            type: MessageItemType.FILE,
            file_item: {
                media: options.media,
                file_name: options.fileName,
                md5: options.md5,
                len: options.size?.toString(),
            },
        });
        return this;
    }
    /**
     * Add a voice item with CDN media reference.
     *
     * ── 本地补丁(上游没有) ──
     * 上游的 MessageBuilder 只有 text/image/file/video,**没有 voice**,
     * 而且 categorizeByMime() 也永远不返回 'voice'(只认 image/video/file),
     * 所以 bot.send({file}) 发音频只会当**文件**发出去。
     * 但协议是支持的:MessageItemType.VOICE = 3、MediaType.VOICE = 4,
     * 入站解析器也在读 item.voice_item —— 字段名照它抄。
     */
    voice(options) {
        this.items.push({
            type: MessageItemType.VOICE,
            voice_item: {
                media: options.media,
                playtime: options.playtime,
                encode_type: options.encodeType,
                // 这两个**不能省**:微信客户端要靠它们解码 SILK。
                // 协议里 VoiceItem 有 bits_per_sample / sample_rate,
                // 只给 media+playtime+encode_type 的话服务端照收(返回 message_id),
                // 但消息根本送不到 —— 实测过,静默丢失。
                bits_per_sample: options.bitsPerSample,
                sample_rate: options.sampleRate,
            },
        });
        return this;
    }
    /** Add a video item with CDN media reference. */
    video(options) {
        this.items.push({
            type: MessageItemType.VIDEO,
            video_item: {
                media: options.media,
                video_size: options.videoSize,
                play_length: options.playLength,
                thumb_media: options.thumbMedia,
            },
        });
        return this;
    }
    /** Build the wire-format message payload. */
    build() {
        if (this.items.length === 0) {
            throw new Error('Cannot build message with no items');
        }
        return {
            from_user_id: '',
            to_user_id: this.userId,
            client_id: this.clientId,
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: this.contextToken,
            item_list: this.items,
        };
    }
}
//# sourceMappingURL=builder.js.map
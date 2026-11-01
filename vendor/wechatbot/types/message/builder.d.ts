import { type CDNMedia, type SendMessageRequest } from '../protocol/types.js';
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
export declare class MessageBuilder {
    private readonly userId;
    private readonly contextToken;
    private readonly items;
    private clientId;
    private constructor();
    static to(userId: string, contextToken: string): MessageBuilder;
    /** Set a custom client_id (default: random UUID). */
    withClientId(id: string): this;
    /** Add a text item. */
    text(content: string): this;
    /** Add an image item with CDN media reference. */
    image(options: {
        media: CDNMedia;
        midSize?: number;
        thumbMedia?: CDNMedia;
        thumbSize?: number;
        thumbWidth?: number;
        thumbHeight?: number;
    }): this;
    /** Add a file item with CDN media reference. */
    file(options: {
        media: CDNMedia;
        fileName: string;
        md5?: string;
        size?: number;
    }): this;
    /** Add a video item with CDN media reference. */
    video(options: {
        media: CDNMedia;
        videoSize?: number;
        playLength?: number;
        thumbMedia?: CDNMedia;
    }): this;
    /** Build the wire-format message payload. */
    build(): SendMessageRequest['msg'];
}
//# sourceMappingURL=builder.d.ts.map
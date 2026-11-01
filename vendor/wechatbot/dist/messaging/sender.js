import { NoContextError } from '../core/errors.js';
const MAX_TEXT_LENGTH = 4_000;
/**
 * Message sending service.
 * Handles text chunking, context_token resolution, and message dispatch.
 */
export class MessageSender {
    api;
    contextStore;
    logger;
    constructor(api, contextStore, logger) {
        this.api = api;
        this.contextStore = contextStore;
        this.logger = logger.child('sender');
    }
    /**
     * Send a text message to a user.
     * Long texts are automatically chunked at 2000 character boundaries.
     */
    async sendText(baseUrl, token, userId, text, contextToken) {
        const ctx = contextToken ?? this.contextStore.get(userId);
        if (!ctx)
            throw new NoContextError(userId);
        if (text.length === 0) {
            throw new Error('Message text cannot be empty');
        }
        const chunks = chunkText(text, MAX_TEXT_LENGTH);
        for (const chunk of chunks) {
            const msg = this.api.buildTextMessagePayload(userId, ctx, chunk);
            await this.api.sendMessage(baseUrl, token, msg);
        }
        this.logger.debug(`Sent text to ${userId}`, {
            length: text.length,
            chunks: chunks.length,
        });
    }
    /**
     * Send a pre-built message payload (for media, custom items, etc.)
     */
    async sendRaw(baseUrl, token, msg) {
        await this.api.sendMessage(baseUrl, token, msg);
        this.logger.debug(`Sent raw message to ${msg.to_user_id}`);
    }
    /**
     * Send media items (image, file, video) to a user.
     */
    async sendMedia(baseUrl, token, userId, items, contextToken) {
        const ctx = contextToken ?? this.contextStore.get(userId);
        if (!ctx)
            throw new NoContextError(userId);
        const msg = this.api.buildMediaMessagePayload(userId, ctx, items);
        await this.api.sendMessage(baseUrl, token, msg);
        this.logger.debug(`Sent media to ${userId}`, { itemCount: items.length });
    }
}
/**
 * Split text into chunks at natural boundaries.
 * Priority: paragraph break → line break → space → hard cut.
 */
function chunkText(text, limit) {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let remaining = text;
    while (remaining.length > 0) {
        if (remaining.length <= limit) {
            chunks.push(remaining);
            break;
        }
        // Try to find a natural break point
        let splitAt = -1;
        const searchWindow = remaining.slice(0, limit);
        // Priority 1: paragraph break
        const paraBreak = searchWindow.lastIndexOf('\n\n');
        if (paraBreak > limit * 0.3) {
            splitAt = paraBreak + 2;
        }
        // Priority 2: line break
        if (splitAt === -1) {
            const lineBreak = searchWindow.lastIndexOf('\n');
            if (lineBreak > limit * 0.3) {
                splitAt = lineBreak + 1;
            }
        }
        // Priority 3: space
        if (splitAt === -1) {
            const space = searchWindow.lastIndexOf(' ');
            if (space > limit * 0.3) {
                splitAt = space + 1;
            }
        }
        // Priority 4: hard cut
        if (splitAt === -1) {
            splitAt = limit;
        }
        chunks.push(remaining.slice(0, splitAt));
        remaining = remaining.slice(splitAt);
    }
    return chunks.length > 0 ? chunks : [''];
}
export { chunkText };
//# sourceMappingURL=sender.js.map
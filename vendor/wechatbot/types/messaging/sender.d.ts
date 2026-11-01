import type { Logger } from '../logger/types.js';
import type { ILinkApi } from '../protocol/api.js';
import type { SendMessageRequest, WireMessageItem } from '../protocol/types.js';
import type { ContextStore } from './context.js';
/**
 * Message sending service.
 * Handles text chunking, context_token resolution, and message dispatch.
 */
export declare class MessageSender {
    private readonly api;
    private readonly contextStore;
    private readonly logger;
    constructor(api: ILinkApi, contextStore: ContextStore, logger: Logger);
    /**
     * Send a text message to a user.
     * Long texts are automatically chunked at 2000 character boundaries.
     */
    sendText(baseUrl: string, token: string, userId: string, text: string, contextToken?: string): Promise<void>;
    /**
     * Send a pre-built message payload (for media, custom items, etc.)
     */
    sendRaw(baseUrl: string, token: string, msg: SendMessageRequest['msg']): Promise<void>;
    /**
     * Send media items (image, file, video) to a user.
     */
    sendMedia(baseUrl: string, token: string, userId: string, items: WireMessageItem[], contextToken?: string): Promise<void>;
}
/**
 * Split text into chunks at natural boundaries.
 * Priority: paragraph break → line break → space → hard cut.
 */
declare function chunkText(text: string, limit: number): string[];
export { chunkText };
//# sourceMappingURL=sender.d.ts.map
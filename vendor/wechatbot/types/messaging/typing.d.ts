import type { Logger } from '../logger/types.js';
import type { ILinkApi } from '../protocol/api.js';
import type { ContextStore } from './context.js';
/**
 * Typing indicator service.
 * Manages the getconfig → sendtyping flow with ticket caching.
 */
export declare class TypingService {
    private readonly api;
    private readonly contextStore;
    private readonly logger;
    /** Cache typing tickets to avoid repeated getconfig calls */
    private readonly ticketCache;
    private static readonly TICKET_TTL_MS;
    constructor(api: ILinkApi, contextStore: ContextStore, logger: Logger);
    /** Show "typing..." indicator to a user. */
    startTyping(baseUrl: string, token: string, userId: string): Promise<void>;
    /** Cancel "typing..." indicator. */
    stopTyping(baseUrl: string, token: string, userId: string): Promise<void>;
    /** Clear ticket cache (e.g. on re-login). */
    clearCache(): void;
    private getTicket;
}
//# sourceMappingURL=typing.d.ts.map
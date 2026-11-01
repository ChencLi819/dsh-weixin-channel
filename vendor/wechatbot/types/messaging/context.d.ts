import type { Logger } from '../logger/types.js';
import { type WireMessage } from '../protocol/types.js';
import type { Storage } from '../storage/interface.js';
/**
 * Manages context_token lifecycle.
 * Tokens are cached in-memory for speed and persisted to storage for restart survival.
 */
export declare class ContextStore {
    private readonly storage;
    private readonly tokens;
    private readonly logger;
    private dirty;
    constructor(storage: Storage, logger: Logger);
    /** Load persisted context tokens from storage. */
    load(): Promise<void>;
    /** Get the cached context_token for a user. */
    get(userId: string): string | undefined;
    /** Cache a context_token for a user. */
    set(userId: string, token: string): void;
    /** Extract and cache context_token from a wire message. */
    remember(message: WireMessage): void;
    /** Persist dirty tokens to storage. */
    flush(): Promise<void>;
    /** Clear all tokens from memory and storage. */
    clear(): Promise<void>;
}
//# sourceMappingURL=context.d.ts.map
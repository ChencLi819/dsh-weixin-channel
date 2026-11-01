import { MessageType } from '../protocol/types.js';
import { STORAGE_KEYS } from '../storage/interface.js';
/**
 * Manages context_token lifecycle.
 * Tokens are cached in-memory for speed and persisted to storage for restart survival.
 */
export class ContextStore {
    storage;
    tokens = new Map();
    logger;
    dirty = false;
    constructor(storage, logger) {
        this.storage = storage;
        this.logger = logger.child('context');
    }
    /** Load persisted context tokens from storage. */
    async load() {
        const stored = await this.storage.get(STORAGE_KEYS.CONTEXT_TOKENS);
        if (stored) {
            for (const [k, v] of Object.entries(stored)) {
                this.tokens.set(k, v);
            }
            this.logger.debug(`Loaded ${this.tokens.size} context tokens from storage`);
        }
    }
    /** Get the cached context_token for a user. */
    get(userId) {
        return this.tokens.get(userId);
    }
    /** Cache a context_token for a user. */
    set(userId, token) {
        this.tokens.set(userId, token);
        this.dirty = true;
    }
    /** Extract and cache context_token from a wire message. */
    remember(message) {
        const userId = message.message_type === MessageType.USER
            ? message.from_user_id
            : message.to_user_id;
        if (userId && message.context_token) {
            this.set(userId, message.context_token);
        }
    }
    /** Persist dirty tokens to storage. */
    async flush() {
        if (!this.dirty)
            return;
        const obj = Object.fromEntries(this.tokens);
        await this.storage.set(STORAGE_KEYS.CONTEXT_TOKENS, obj);
        this.dirty = false;
    }
    /** Clear all tokens from memory and storage. */
    async clear() {
        this.tokens.clear();
        this.dirty = false;
        await this.storage.delete(STORAGE_KEYS.CONTEXT_TOKENS);
    }
}
//# sourceMappingURL=context.js.map
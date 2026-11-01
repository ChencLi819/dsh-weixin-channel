import type { Storage } from './interface.js';
/**
 * In-memory storage. Fast, but state is lost on restart.
 * Good for testing and ephemeral bots.
 */
export declare class MemoryStorage implements Storage {
    private readonly store;
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    clear(): Promise<void>;
}
//# sourceMappingURL=memory.d.ts.map
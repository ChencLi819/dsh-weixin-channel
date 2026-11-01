import type { Storage } from './interface.js';
/**
 * File-based storage — each key is a JSON file.
 * Credentials and state survive restarts.
 */
export declare class FileStorage implements Storage {
    private readonly dir;
    constructor(dir?: string);
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
    delete(key: string): Promise<void>;
    has(key: string): Promise<boolean>;
    clear(): Promise<void>;
    private filePath;
    private ensureDir;
}
//# sourceMappingURL=file.d.ts.map
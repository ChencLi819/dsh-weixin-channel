import { mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
const DEFAULT_DIR = path.join(os.homedir(), '.wechatbot');
/**
 * File-based storage — each key is a JSON file.
 * Credentials and state survive restarts.
 */
export class FileStorage {
    dir;
    constructor(dir) {
        this.dir = dir ?? DEFAULT_DIR;
    }
    async get(key) {
        try {
            const raw = await readFile(this.filePath(key), 'utf8');
            return JSON.parse(raw);
        }
        catch (err) {
            if (err.code === 'ENOENT')
                return undefined;
            throw err;
        }
    }
    async set(key, value) {
        await this.ensureDir();
        await writeFile(this.filePath(key), JSON.stringify(value, null, 2) + '\n', {
            mode: 0o600,
        });
    }
    async delete(key) {
        await rm(this.filePath(key), { force: true });
    }
    async has(key) {
        try {
            await readFile(this.filePath(key));
            return true;
        }
        catch {
            return false;
        }
    }
    async clear() {
        try {
            const files = await readdir(this.dir);
            await Promise.all(files
                .filter((f) => f.endsWith('.json'))
                .map((f) => rm(path.join(this.dir, f), { force: true })));
        }
        catch (err) {
            if (err.code !== 'ENOENT')
                throw err;
        }
    }
    filePath(key) {
        // Sanitize key for filesystem safety
        const safe = key.replace(/[^a-zA-Z0-9_-]/g, '_');
        return path.join(this.dir, `${safe}.json`);
    }
    async ensureDir() {
        await mkdir(this.dir, { recursive: true, mode: 0o700 });
    }
}
//# sourceMappingURL=file.js.map
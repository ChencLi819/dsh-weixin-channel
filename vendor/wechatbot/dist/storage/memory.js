/**
 * In-memory storage. Fast, but state is lost on restart.
 * Good for testing and ephemeral bots.
 */
export class MemoryStorage {
    store = new Map();
    async get(key) {
        return this.store.get(key);
    }
    async set(key, value) {
        this.store.set(key, value);
    }
    async delete(key) {
        this.store.delete(key);
    }
    async has(key) {
        return this.store.has(key);
    }
    async clear() {
        this.store.clear();
    }
}
//# sourceMappingURL=memory.js.map
/**
 * Minimal typed event emitter — no external dependencies.
 */
export class TypedEmitter {
    listeners = new Map();
    on(event, listener) {
        let set = this.listeners.get(event);
        if (!set) {
            set = new Set();
            this.listeners.set(event, set);
        }
        set.add(listener);
        return this;
    }
    off(event, listener) {
        this.listeners.get(event)?.delete(listener);
        return this;
    }
    once(event, listener) {
        const wrapper = (...args) => {
            this.off(event, wrapper);
            return listener(...args);
        };
        return this.on(event, wrapper);
    }
    emit(event, ...args) {
        const set = this.listeners.get(event);
        if (!set)
            return;
        for (const listener of set) {
            try {
                const result = listener(...args);
                // Swallow promise rejections on fire-and-forget events
                if (result && typeof result.catch === 'function') {
                    ;
                    result.catch(() => { });
                }
            }
            catch {
                // Listener threw synchronously — swallow to avoid breaking emit loop
            }
        }
    }
    removeAllListeners(event) {
        if (event) {
            this.listeners.delete(event);
        }
        else {
            this.listeners.clear();
        }
        return this;
    }
    listenerCount(event) {
        return this.listeners.get(event)?.size ?? 0;
    }
}
//# sourceMappingURL=events.js.map
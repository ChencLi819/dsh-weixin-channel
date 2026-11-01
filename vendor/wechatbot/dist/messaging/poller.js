import { setTimeout as delay } from 'node:timers/promises';
import { ApiError } from '../core/errors.js';
import { TypedEmitter } from '../core/events.js';
import { STORAGE_KEYS } from '../storage/interface.js';
import { isAbortError } from '../transport/http.js';
/**
 * Isolated long-poll loop.
 * Emits `messages` events with batches of wire messages.
 * Handles cursor management, exponential backoff, and session expiry detection.
 */
export class MessagePoller extends TypedEmitter {
    api;
    storage;
    cursor = '';
    stopped = true;
    pollController = null;
    logger;
    constructor(api, storage, logger) {
        super();
        this.api = api;
        this.storage = storage;
        this.logger = logger.child('poller');
    }
    /** Load persisted cursor from storage. */
    async loadCursor() {
        const stored = await this.storage.get(STORAGE_KEYS.CURSOR);
        if (stored) {
            this.cursor = stored;
            this.logger.debug('Loaded cursor from storage');
        }
    }
    /** Reset cursor (e.g. on re-login). */
    async resetCursor() {
        this.cursor = '';
        await this.storage.delete(STORAGE_KEYS.CURSOR);
    }
    /** Start the long-poll loop. */
    async start(baseUrl, token) {
        if (!this.stopped)
            return;
        this.stopped = false;
        this.logger.info('Long-poll loop starting');
        let retryDelayMs = 1_000;
        // LOCAL PATCH (see vendor/NOTICE.md): count consecutive -14s since the
        // last successful poll and hand the number to the `session:expired`
        // listener. Without it the client's auto-re-login forms a feedback
        // loop: -14 → clearAll() → new QR login → a fresh bot identity that
        // invalidates the previous one → -14 … Measured: 483 expiries and 34
        // QR codes in one run before anyone noticed.
        let consecutiveExpired = 0;
        while (!this.stopped) {
            try {
                this.pollController = new AbortController();
                const updates = await this.api.getUpdates(baseUrl, token, this.cursor, this.pollController.signal);
                this.pollController = null;
                consecutiveExpired = 0;
                // Update cursor
                if (updates.get_updates_buf) {
                    this.cursor = updates.get_updates_buf;
                    // Persist cursor asynchronously — don't block the poll loop
                    this.storage.set(STORAGE_KEYS.CURSOR, this.cursor).catch(() => { });
                }
                retryDelayMs = 1_000;
                // Emit messages if any
                if (updates.msgs?.length > 0) {
                    this.emit('messages', updates.msgs);
                }
            }
            catch (error) {
                this.pollController = null;
                if (this.stopped && isAbortError(error)) {
                    break;
                }
                if (error instanceof ApiError && error.isSessionExpired) {
                    consecutiveExpired++;
                    this.logger.warn(`Session expired — emitting session:expired (连续第 ${consecutiveExpired} 次)`);
                    this.emit('session:expired', { consecutive: consecutiveExpired });
                    // Pause until the client handles re-login
                    await delay(2_000);
                    continue;
                }
                if (!isAbortError(error)) {
                    this.logger.error(`Poll error: ${error instanceof Error ? error.message : String(error)}`);
                    this.emit('error', error);
                }
                await delay(retryDelayMs);
                retryDelayMs = Math.min(retryDelayMs * 2, 10_000);
            }
        }
        this.logger.info('Long-poll loop stopped');
    }
    /** Stop the poll loop. */
    stop() {
        this.stopped = true;
        this.pollController?.abort();
        this.pollController = null;
    }
    get isRunning() {
        return !this.stopped;
    }
}
//# sourceMappingURL=poller.js.map
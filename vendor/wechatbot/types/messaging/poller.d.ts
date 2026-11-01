import { TypedEmitter } from '../core/events.js';
import type { Logger } from '../logger/types.js';
import type { ILinkApi } from '../protocol/api.js';
import type { WireMessage } from '../protocol/types.js';
import type { Storage } from '../storage/interface.js';
type PollerEventMap = {
    messages: [messages: WireMessage[]];
    'session:expired': [];
    error: [error: unknown];
};
/**
 * Isolated long-poll loop.
 * Emits `messages` events with batches of wire messages.
 * Handles cursor management, exponential backoff, and session expiry detection.
 */
export declare class MessagePoller extends TypedEmitter<PollerEventMap> {
    private readonly api;
    private readonly storage;
    private cursor;
    private stopped;
    private pollController;
    private readonly logger;
    constructor(api: ILinkApi, storage: Storage, logger: Logger);
    /** Load persisted cursor from storage. */
    loadCursor(): Promise<void>;
    /** Reset cursor (e.g. on re-login). */
    resetCursor(): Promise<void>;
    /** Start the long-poll loop. */
    start(baseUrl: string, token: string): Promise<void>;
    /** Stop the poll loop. */
    stop(): void;
    get isRunning(): boolean;
}
export {};
//# sourceMappingURL=poller.d.ts.map
import type { IncomingMessage } from '../message/types.js';
import type { Credentials } from '../auth/types.js';
/**
 * Strongly-typed event map for WeChatBot.
 * Using mapped types ensures type safety for on/emit.
 */
export type BotEventMap = {
    /** Fired when a user message is received (after middleware). */
    message: [message: IncomingMessage];
    /** Fired when login completes. */
    login: [credentials: Credentials];
    /** Fired when session expires and re-login is needed. */
    'session:expired': [];
    /** Fired when re-login completes after session expiry. */
    'session:restored': [credentials: Credentials];
    /** Fired when the long-poll loop starts. */
    'poll:start': [];
    /** Fired when the long-poll loop stops. */
    'poll:stop': [];
    /** Fired on recoverable errors. */
    error: [error: unknown];
    /** Fired when the bot is fully stopped. */
    close: [];
};
type Listener<Args extends unknown[]> = (...args: Args) => void | Promise<void>;
/**
 * Minimal typed event emitter — no external dependencies.
 */
export declare class TypedEmitter<EventMap extends {
    [K: string]: unknown[];
} = {
    [K: string]: unknown[];
}> {
    private readonly listeners;
    on<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this;
    off<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this;
    once<K extends keyof EventMap>(event: K, listener: Listener<EventMap[K]>): this;
    emit<K extends keyof EventMap>(event: K, ...args: EventMap[K]): void;
    removeAllListeners(event?: keyof EventMap): this;
    listenerCount(event: keyof EventMap): number;
}
export {};
//# sourceMappingURL=events.d.ts.map
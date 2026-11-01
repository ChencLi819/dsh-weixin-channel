import type { Logger } from '../logger/types.js';
import type { Middleware } from './types.js';
/**
 * Built-in middleware: log every incoming message.
 */
export declare function loggingMiddleware(logger: Logger): Middleware;
/**
 * Built-in middleware: filter messages by text pattern.
 * If the pattern doesn't match, the message is skipped (next is not called).
 */
export declare function filterMiddleware(pattern: RegExp): Middleware;
/**
 * Built-in middleware: only process messages of certain types.
 */
export declare function typeFilterMiddleware(...types: Array<'text' | 'image' | 'voice' | 'file' | 'video'>): Middleware;
/**
 * Built-in middleware: rate limit per user.
 * Drops messages if a user exceeds the limit within the window.
 */
export declare function rateLimitMiddleware(options: {
    maxMessages: number;
    windowMs: number;
    logger?: Logger;
}): Middleware;
//# sourceMappingURL=builtins.d.ts.map
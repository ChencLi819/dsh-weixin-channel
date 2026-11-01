import type { IncomingMessage } from '../message/types.js';
import type { MessageContext, Middleware } from './types.js';
/**
 * Middleware engine — executes a chain of middleware functions
 * in order, each calling next() to pass control forward.
 *
 * Inspired by Koa/Express middleware patterns.
 *
 * Usage:
 *   const engine = new MiddlewareEngine()
 *   engine.use(loggingMiddleware)
 *   engine.use(filterMiddleware)
 *   engine.use(handlerMiddleware)
 *   await engine.run(message)
 */
export declare class MiddlewareEngine {
    private readonly stack;
    /** Add a middleware to the end of the chain. */
    use(middleware: Middleware): this;
    /** Remove all middleware. */
    clear(): this;
    /** Get the number of registered middleware. */
    get size(): number;
    /**
     * Execute the middleware chain for an incoming message.
     * Returns the final context after all middleware have run.
     */
    run(message: IncomingMessage): Promise<MessageContext>;
    private execute;
}
//# sourceMappingURL=engine.d.ts.map
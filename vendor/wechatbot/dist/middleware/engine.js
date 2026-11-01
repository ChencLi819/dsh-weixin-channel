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
export class MiddlewareEngine {
    stack = [];
    /** Add a middleware to the end of the chain. */
    use(middleware) {
        this.stack.push(middleware);
        return this;
    }
    /** Remove all middleware. */
    clear() {
        this.stack.length = 0;
        return this;
    }
    /** Get the number of registered middleware. */
    get size() {
        return this.stack.length;
    }
    /**
     * Execute the middleware chain for an incoming message.
     * Returns the final context after all middleware have run.
     */
    async run(message) {
        const ctx = {
            message,
            state: new Map(),
            handled: false,
        };
        await this.execute(ctx, 0);
        return ctx;
    }
    async execute(ctx, index) {
        if (ctx.handled || index >= this.stack.length)
            return;
        const middleware = this.stack[index];
        let nextCalled = false;
        const next = async () => {
            if (nextCalled)
                return; // Prevent double-calling
            nextCalled = true;
            await this.execute(ctx, index + 1);
        };
        await middleware(ctx, next);
    }
}
//# sourceMappingURL=engine.js.map
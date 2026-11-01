import type { LogEntry, Logger, LogLevel, LogTransport } from './types.js';
export declare class StderrTransport implements LogTransport {
    write(entry: LogEntry): void;
}
export declare class BotLogger implements Logger {
    private readonly transport;
    private readonly level;
    private readonly context?;
    private readonly levelThreshold;
    constructor(transport: LogTransport, level?: LogLevel, context?: string | undefined);
    debug(message: string, data?: Record<string, unknown>): void;
    info(message: string, data?: Record<string, unknown>): void;
    warn(message: string, data?: Record<string, unknown>): void;
    error(message: string, data?: Record<string, unknown>): void;
    child(context: string): Logger;
    private log;
}
export declare function createLogger(options?: {
    level?: LogLevel;
    transport?: LogTransport;
}): Logger;
//# sourceMappingURL=logger.d.ts.map
const LOG_LEVELS = {
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
    silent: 4,
};
export class StderrTransport {
    write(entry) {
        const ts = entry.timestamp.toISOString();
        const ctx = entry.context ? ` [${entry.context}]` : '';
        const lvl = entry.level.toUpperCase().padEnd(5);
        const data = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
        process.stderr.write(`${ts} ${lvl}${ctx} ${entry.message}${data}\n`);
    }
}
export class BotLogger {
    transport;
    level;
    context;
    levelThreshold;
    constructor(transport, level = 'info', context) {
        this.transport = transport;
        this.level = level;
        this.context = context;
        this.levelThreshold = LOG_LEVELS[level];
    }
    debug(message, data) {
        this.log('debug', message, data);
    }
    info(message, data) {
        this.log('info', message, data);
    }
    warn(message, data) {
        this.log('warn', message, data);
    }
    error(message, data) {
        this.log('error', message, data);
    }
    child(context) {
        const prefix = this.context ? `${this.context}:${context}` : context;
        return new BotLogger(this.transport, this.level, prefix);
    }
    log(level, message, data) {
        if (LOG_LEVELS[level] < this.levelThreshold)
            return;
        this.transport.write({
            level,
            message,
            timestamp: new Date(),
            context: this.context,
            data,
        });
    }
}
export function createLogger(options = {}) {
    const transport = options.transport ?? new StderrTransport();
    return new BotLogger(transport, options.level ?? 'info');
}
//# sourceMappingURL=logger.js.map
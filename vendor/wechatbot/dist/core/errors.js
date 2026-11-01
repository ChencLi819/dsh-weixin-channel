/**
 * Base error class for all SDK errors.
 * Provides structured error info for programmatic handling.
 */
export class WeChatBotError extends Error {
    code;
    constructor(code, message, options) {
        super(message, options);
        this.name = 'WeChatBotError';
        this.code = code;
    }
}
/**
 * API-level error returned by iLink server.
 */
export class ApiError extends WeChatBotError {
    httpStatus;
    errcode;
    payload;
    constructor(message, options) {
        super('API_ERROR', message);
        this.name = 'ApiError';
        this.httpStatus = options.httpStatus;
        this.errcode = options.errcode;
        this.payload = options.payload;
    }
    get isSessionExpired() {
        return this.errcode === -14;
    }
}
/**
 * Authentication errors (QR expired, login failed, etc.)
 */
export class AuthError extends WeChatBotError {
    constructor(message, options) {
        super('AUTH_ERROR', message, options);
        this.name = 'AuthError';
    }
}
/**
 * No context_token available for a user.
 */
export class NoContextError extends WeChatBotError {
    userId;
    constructor(userId) {
        super('NO_CONTEXT', `No context_token cached for user ${userId}. A message from this user must be received first.`);
        this.name = 'NoContextError';
        this.userId = userId;
    }
}
/**
 * Media processing errors (encryption, upload, download).
 */
export class MediaError extends WeChatBotError {
    constructor(message, options) {
        super('MEDIA_ERROR', message, options);
        this.name = 'MediaError';
    }
}
/**
 * Transport-level network errors.
 */
export class TransportError extends WeChatBotError {
    constructor(message, options) {
        super('TRANSPORT_ERROR', message, options);
        this.name = 'TransportError';
    }
}
//# sourceMappingURL=errors.js.map
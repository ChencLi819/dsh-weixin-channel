/**
 * Base error class for all SDK errors.
 * Provides structured error info for programmatic handling.
 */
export declare class WeChatBotError extends Error {
    readonly code: string;
    constructor(code: string, message: string, options?: ErrorOptions);
}
/**
 * API-level error returned by iLink server.
 */
export declare class ApiError extends WeChatBotError {
    readonly httpStatus: number;
    readonly errcode?: number;
    readonly payload?: unknown;
    constructor(message: string, options: {
        httpStatus: number;
        errcode?: number;
        payload?: unknown;
    });
    get isSessionExpired(): boolean;
}
/**
 * Authentication errors (QR expired, login failed, etc.)
 */
export declare class AuthError extends WeChatBotError {
    constructor(message: string, options?: ErrorOptions);
}
/**
 * No context_token available for a user.
 */
export declare class NoContextError extends WeChatBotError {
    readonly userId: string;
    constructor(userId: string);
}
/**
 * Media processing errors (encryption, upload, download).
 */
export declare class MediaError extends WeChatBotError {
    constructor(message: string, options?: ErrorOptions);
}
/**
 * Transport-level network errors.
 */
export declare class TransportError extends WeChatBotError {
    constructor(message: string, options?: ErrorOptions);
}
//# sourceMappingURL=errors.d.ts.map
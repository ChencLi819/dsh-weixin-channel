import type { Logger } from '../logger/types.js';
import type { HttpRequestOptions, HttpResponse, RetryPolicy } from './types.js';
/**
 * HTTP client with timeout, retry, and structured error extraction.
 * Uses Node.js 22 built-in fetch — zero runtime dependencies.
 */
export declare class HttpClient {
    private readonly retryPolicy;
    private readonly logger;
    constructor(options: {
        logger: Logger;
        retryPolicy?: Partial<RetryPolicy>;
    });
    /**
     * Execute an HTTP request with retries.
     */
    request<T>(options: HttpRequestOptions): Promise<HttpResponse<T>>;
    /**
     * Execute a JSON POST to the iLink API.
     * Handles the iLink-specific `ret` / `errcode` error format.
     */
    apiPost<T>(baseUrl: string, endpoint: string, body: unknown, headers: Record<string, string>, options?: {
        timeoutMs?: number;
        signal?: AbortSignal;
    }): Promise<T>;
    /**
     * Execute a GET request to the iLink API.
     */
    apiGet<T>(baseUrl: string, path: string, headers?: Record<string, string>): Promise<T>;
    private executeRequest;
}
declare function isAbortError(error: unknown): boolean;
export { isAbortError };
//# sourceMappingURL=http.d.ts.map
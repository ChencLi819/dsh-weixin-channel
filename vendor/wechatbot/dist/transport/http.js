import { ApiError, TransportError } from '../core/errors.js';
const DEFAULT_RETRY_POLICY = {
    maxRetries: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 10_000,
    isRetryable: (error) => {
        if (error instanceof ApiError)
            return false; // API errors are definitive
        if (error instanceof Error) {
            return error.name === 'AbortError' || error.name === 'TimeoutError';
        }
        return false;
    },
};
/**
 * HTTP client with timeout, retry, and structured error extraction.
 * Uses Node.js 22 built-in fetch — zero runtime dependencies.
 */
export class HttpClient {
    retryPolicy;
    logger;
    constructor(options) {
        this.logger = options.logger.child('http');
        this.retryPolicy = { ...DEFAULT_RETRY_POLICY, ...options.retryPolicy };
    }
    /**
     * Execute an HTTP request with retries.
     */
    async request(options) {
        let lastError;
        for (let attempt = 0; attempt <= this.retryPolicy.maxRetries; attempt++) {
            try {
                return await this.executeRequest(options);
            }
            catch (error) {
                lastError = error;
                if (attempt < this.retryPolicy.maxRetries && this.retryPolicy.isRetryable(error)) {
                    const delay = Math.min(this.retryPolicy.baseDelayMs * 2 ** attempt, this.retryPolicy.maxDelayMs);
                    this.logger.debug(`Retry ${attempt + 1}/${this.retryPolicy.maxRetries} in ${delay}ms`, {
                        url: options.url,
                    });
                    await sleep(delay);
                    continue;
                }
                throw error;
            }
        }
        throw lastError;
    }
    /**
     * Execute a JSON POST to the iLink API.
     * Handles the iLink-specific `ret` / `errcode` error format.
     */
    async apiPost(baseUrl, endpoint, body, headers, options) {
        const url = new URL(endpoint, normalizeBaseUrl(baseUrl)).toString();
        const response = await this.request({
            method: 'POST',
            url,
            headers: { 'Content-Type': 'application/json', ...headers },
            body,
            timeoutMs: options?.timeoutMs ?? 15_000,
            signal: options?.signal,
        });
        return response.data;
    }
    /**
     * Execute a GET request to the iLink API.
     *
     * LOCAL PATCH (see vendor/NOTICE.md): `options.timeoutMs` / `options.signal`
     * added. Some iLink GET endpoints long-poll and hold the connection far
     * past the previous hardcoded 15s.
     */
    async apiGet(baseUrl, path, headers, options) {
        const url = new URL(path, normalizeBaseUrl(baseUrl)).toString();
        const response = await this.request({
            method: 'GET',
            url,
            headers,
            timeoutMs: options?.timeoutMs ?? 15_000,
            signal: options?.signal,
        });
        return response.data;
    }
    async executeRequest(options) {
        const { method, url, headers, body, timeoutMs = 15_000, signal } = options;
        const timeoutSignal = AbortSignal.timeout(timeoutMs);
        const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
        let response;
        try {
            response = await fetch(url, {
                method,
                headers,
                body: body !== undefined ? JSON.stringify(body) : undefined,
                signal: requestSignal,
            });
        }
        catch (error) {
            if (isAbortError(error))
                throw error;
            throw new TransportError(`Network error: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
        }
        const text = await response.text();
        const data = text ? JSON.parse(text) : {};
        // Check HTTP status
        if (!response.ok) {
            const message = data.errmsg ??
                `HTTP ${response.status} from ${method} ${url}`;
            throw new ApiError(message, {
                httpStatus: response.status,
                errcode: data.errcode,
                payload: data,
            });
        }
        // Check iLink business-level errors (ret !== 0 or errcode !== 0)
        const ret = data.ret;
        const errcode = data.errcode;
        if ((typeof ret === 'number' && ret !== 0) || (typeof errcode === 'number' && errcode !== 0)) {
            const code = errcode ?? ret ?? 0;
            const errmsg = data.errmsg ?? `API error ret=${ret} errcode=${errcode}`;
            throw new ApiError(errmsg, {
                httpStatus: response.status,
                errcode: code,
                payload: data,
            });
        }
        // Extract response headers
        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            responseHeaders[key] = value;
        });
        return {
            status: response.status,
            headers: responseHeaders,
            data: data,
            raw: response,
        };
    }
}
function normalizeBaseUrl(baseUrl) {
    return baseUrl.replace(/\/+$/, '') + '/';
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function isAbortError(error) {
    return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}
export { isAbortError };
//# sourceMappingURL=http.js.map
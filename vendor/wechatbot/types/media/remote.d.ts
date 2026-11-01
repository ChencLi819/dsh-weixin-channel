import type { Logger } from '../logger/types.js';
/**
 * Result of downloading a remote media file.
 */
export interface RemoteDownloadResult {
    /** Downloaded file content. */
    data: Buffer;
    /** MIME type from Content-Type header, or null. */
    contentType: string | null;
    /** Inferred file extension (e.g. '.jpg'). */
    extension: string;
    /** Suggested filename. */
    filename: string;
}
/**
 * Download a file from a remote HTTP/HTTPS URL.
 *
 * Used for forwarding media from external sources (e.g. AI-generated images,
 * agent tool outputs) into WeChat messages.
 *
 * @param url - HTTP or HTTPS URL
 * @param options.timeoutMs - Download timeout (default: 60_000)
 * @param options.logger - Optional logger
 */
export declare function downloadFromUrl(url: string, options?: {
    timeoutMs?: number;
    logger?: Logger;
}): Promise<RemoteDownloadResult>;
//# sourceMappingURL=remote.d.ts.map
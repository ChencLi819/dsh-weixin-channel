import type { Logger } from '../logger/types.js';
import type { ILinkApi } from '../protocol/api.js';
import { type CDNMedia, type MediaType } from '../protocol/types.js';
export interface UploadResult {
    /** CDNMedia reference to include in sendmessage */
    media: CDNMedia;
    /** The AES key used (raw 16 bytes) */
    aesKey: Buffer;
    /** Encrypted file size */
    encryptedFileSize: number;
}
export interface UploadOptions {
    /** File content as Buffer */
    data: Buffer;
    /** Target user ID */
    userId: string;
    /** Media type for the upload */
    mediaType: MediaType;
}
/**
 * Handles file encryption and CDN upload.
 * Implements the full upload pipeline: getuploadurl → encrypt → CDN POST.
 * Retries CDN upload up to 3 times on server errors; client errors (4xx) abort immediately.
 */
export declare class MediaUploader {
    private readonly api;
    private readonly cdnBaseUrl;
    private readonly logger;
    constructor(api: ILinkApi, cdnBaseUrl: string | undefined, logger: Logger);
    upload(baseUrl: string, token: string, options: UploadOptions): Promise<UploadResult>;
}
//# sourceMappingURL=uploader.d.ts.map
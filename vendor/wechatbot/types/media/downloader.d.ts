import type { Logger } from '../logger/types.js';
import { type CDNMedia } from '../protocol/types.js';
/**
 * Downloads and decrypts media files from the WeChat CDN.
 */
export declare class MediaDownloader {
    private readonly cdnBaseUrl;
    private readonly logger;
    constructor(cdnBaseUrl: string | undefined, logger: Logger);
    /**
     * Download and decrypt a file from CDN.
     * @param media - The CDNMedia reference from the message
     * @param aeskeyOverride - Optional direct hex aeskey (from image_item.aeskey)
     */
    download(media: CDNMedia, aeskeyOverride?: string): Promise<Buffer>;
}
//# sourceMappingURL=downloader.d.ts.map
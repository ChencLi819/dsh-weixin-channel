import { MediaError } from '../core/errors.js';
import { getExtensionFromContentTypeOrUrl } from './mime.js';
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
export async function downloadFromUrl(url, options) {
    const logger = options?.logger;
    const timeoutMs = options?.timeoutMs ?? 60_000;
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
        throw new MediaError(`Invalid URL scheme — only http:// and https:// are supported: ${url}`);
    }
    logger?.debug('Downloading remote media', { url: url.slice(0, 120) });
    const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
        throw new MediaError(`Remote media download failed: HTTP ${response.status} ${response.statusText} — ${url.slice(0, 120)}`);
    }
    const data = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get('content-type');
    const extension = getExtensionFromContentTypeOrUrl(contentType, url);
    // Try to extract filename from Content-Disposition, URL path, or generate one
    let filename = `download${extension}`;
    const disposition = response.headers.get('content-disposition');
    if (disposition) {
        const match = disposition.match(/filename[*]?=(?:UTF-8''|"?)([^";]+)/i);
        if (match)
            filename = decodeURIComponent(match[1]);
    }
    else {
        try {
            const urlPath = new URL(url).pathname;
            const urlFilename = urlPath.split('/').pop();
            if (urlFilename && urlFilename.includes('.'))
                filename = urlFilename;
        }
        catch {
            // Invalid URL, use default
        }
    }
    logger?.debug('Remote download complete', {
        size: data.length,
        contentType,
        extension,
        filename,
    });
    return { data, contentType, extension, filename };
}
//# sourceMappingURL=remote.js.map
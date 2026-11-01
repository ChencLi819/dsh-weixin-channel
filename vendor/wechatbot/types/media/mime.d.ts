/**
 * Get MIME type from a filename or path.
 * Returns `application/octet-stream` for unknown extensions.
 */
export declare function getMimeFromFilename(filename: string): string;
/**
 * Get file extension from a MIME type.
 * Returns `.bin` for unknown types.
 */
export declare function getExtensionFromMime(mimeType: string): string;
/**
 * Get file extension from a Content-Type header or URL path.
 * Tries Content-Type first, then falls back to URL extension.
 * Returns `.bin` for unknown.
 */
export declare function getExtensionFromContentTypeOrUrl(contentType: string | null | undefined, url: string): string;
/**
 * Determine the MediaType enum value from a MIME type.
 * Used for auto-routing uploads.
 */
export type MediaCategory = 'image' | 'video' | 'file';
export declare function categorizeByMime(mime: string): MediaCategory;
//# sourceMappingURL=mime.d.ts.map
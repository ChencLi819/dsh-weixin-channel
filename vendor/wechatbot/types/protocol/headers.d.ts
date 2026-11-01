/**
 * Generate the X-WECHAT-UIN header value.
 * Algorithm: random uint32 → decimal string → base64
 */
export declare function randomWechatUin(): string;
/**
 * Build common headers included in both GET and POST requests.
 */
export declare function buildCommonHeaders(): Record<string, string>;
/**
 * Build the standard iLink Bot API headers for POST requests.
 */
export declare function buildAuthHeaders(token: string): Record<string, string>;
//# sourceMappingURL=headers.d.ts.map
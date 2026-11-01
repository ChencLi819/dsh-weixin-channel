/**
 * AES-128-ECB encryption used by WeChat CDN.
 * All media files are encrypted before upload and decrypted after download.
 */
export declare function encryptAesEcb(plaintext: Buffer, key: Buffer): Buffer;
export declare function decryptAesEcb(ciphertext: Buffer, key: Buffer): Buffer;
/**
 * Generate a random 16-byte AES key.
 */
export declare function generateAesKey(): Buffer;
/**
 * Calculate the encrypted file size (AES-128-ECB with PKCS7 padding).
 * Formula: ceil((rawsize + 1) / 16) * 16
 */
export declare function encryptedSize(rawSize: number): number;
/**
 * Decode an aes_key from the protocol.
 * Handles both formats:
 *   - Format A: base64(raw 16 bytes) → 16-byte key
 *   - Format B: base64(hex string 32 chars) → hex decode → 16-byte key
 *   - Direct hex string (32 chars) from image_item.aeskey
 */
export declare function decodeAesKey(encoded: string): Buffer;
/**
 * Encode an AES key for the getuploadurl request (hex string format).
 */
export declare function encodeAesKeyHex(key: Buffer): string;
/**
 * Encode an AES key for the sendmessage CDNMedia.aes_key field.
 * Uses base64(hex string) format for compatibility with official implementation.
 */
export declare function encodeAesKeyBase64(key: Buffer): string;
//# sourceMappingURL=crypto.d.ts.map
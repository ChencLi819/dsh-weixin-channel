import type { Logger } from '../logger/types.js';
/** Default sample rate for WeChat voice messages (SILK codec). */
declare const SILK_SAMPLE_RATE = 24000;
/**
 * Transcode SILK audio buffer to WAV.
 *
 * Uses `silk-wasm` for decoding. Returns WAV Buffer on success, or null
 * if silk-wasm is not installed or decoding fails. Callers should fall
 * back to the raw SILK buffer when null is returned.
 *
 * Install silk-wasm for voice support:
 *   npm install silk-wasm
 */
export declare function silkToWav(silkBuf: Buffer, logger?: Logger): Promise<Buffer | null>;
export { SILK_SAMPLE_RATE };
//# sourceMappingURL=voice.d.ts.map
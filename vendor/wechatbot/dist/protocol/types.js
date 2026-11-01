// ═══════════════════════════════════════════════════════════════════════
// Wire-level types — mirror the iLink Bot API JSON structures exactly.
// These are internal; the public API exposes friendlier abstractions.
// ═══════════════════════════════════════════════════════════════════════
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';
/** Read version from package.json for channel_version in base_info. */
function readVersionFromPackageJson() {
    try {
        const dir = dirname(fileURLToPath(import.meta.url));
        const pkgPath = resolve(dir, '..', '..', 'package.json');
        const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
        return pkg.version ?? '2.0.0';
    }
    catch {
        return '2.0.0';
    }
}
export const CHANNEL_VERSION = readVersionFromPackageJson();
// ── Enums ──────────────────────────────────────────────────────────────
export var MessageType;
(function (MessageType) {
    MessageType[MessageType["USER"] = 1] = "USER";
    MessageType[MessageType["BOT"] = 2] = "BOT";
})(MessageType || (MessageType = {}));
export var MessageState;
(function (MessageState) {
    MessageState[MessageState["NEW"] = 0] = "NEW";
    MessageState[MessageState["GENERATING"] = 1] = "GENERATING";
    MessageState[MessageState["FINISH"] = 2] = "FINISH";
})(MessageState || (MessageState = {}));
export var MessageItemType;
(function (MessageItemType) {
    MessageItemType[MessageItemType["TEXT"] = 1] = "TEXT";
    MessageItemType[MessageItemType["IMAGE"] = 2] = "IMAGE";
    MessageItemType[MessageItemType["VOICE"] = 3] = "VOICE";
    MessageItemType[MessageItemType["FILE"] = 4] = "FILE";
    MessageItemType[MessageItemType["VIDEO"] = 5] = "VIDEO";
})(MessageItemType || (MessageItemType = {}));
export var MediaType;
(function (MediaType) {
    MediaType[MediaType["IMAGE"] = 1] = "IMAGE";
    MediaType[MediaType["VIDEO"] = 2] = "VIDEO";
    MediaType[MediaType["FILE"] = 3] = "FILE";
    MediaType[MediaType["VOICE"] = 4] = "VOICE";
})(MediaType || (MediaType = {}));
//# sourceMappingURL=types.js.map
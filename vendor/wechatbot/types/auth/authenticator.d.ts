import type { Logger } from '../logger/types.js';
import type { ILinkApi } from '../protocol/api.js';
import type { Storage } from '../storage/interface.js';
import type { Credentials, QrLoginCallbacks } from './types.js';
/**
 * Handles the entire QR login flow with credential persistence.
 * Separated from the main client so it can be tested / replaced independently.
 */
export declare class Authenticator {
    private readonly api;
    private readonly storage;
    private readonly logger;
    constructor(api: ILinkApi, storage: Storage, logger: Logger);
    /**
     * Attempt to load stored credentials. Returns undefined if none exist.
     */
    loadCredentials(): Promise<Credentials | undefined>;
    /**
     * Full login: try stored credentials first, fall back to QR flow.
     */
    login(options?: {
        force?: boolean;
        baseUrl?: string;
        callbacks?: QrLoginCallbacks;
    }): Promise<Credentials>;
    /**
     * Clear stored credentials and related state.
     */
    clearAll(): Promise<void>;
    /**
     * Execute the QR code scanning login flow.
     * - Uses fixed base URL for QR requests (consistent with npm package)
     * - Handles `scaned_but_redirect` for IDC redirect
     * - Limits QR refreshes to MAX_QR_REFRESH_COUNT
     */
    private qrLogin;
    /**
     * Obtain a pairing code from the developer callback, or fall back to a
     * stdin prompt.
     */
    private promptVerifyCode;
}
//# sourceMappingURL=authenticator.d.ts.map
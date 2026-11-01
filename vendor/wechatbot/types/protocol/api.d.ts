import type { HttpClient } from '../transport/http.js';
import { type GetConfigResponse, type GetUpdatesResponse, type GetUploadUrlRequest, type GetUploadUrlResponse, type QrCodeResponse, type QrStatusResponse, type SendMessageRequest, type WireMessageItem } from './types.js';
/**
 * Low-level iLink API calls.
 * Each method maps 1:1 to an API endpoint.
 * No business logic — just wire protocol.
 */
export declare class ILinkApi {
    private readonly http;
    private readonly botAgent;
    constructor(http: HttpClient, botAgent?: string);
    private baseInfo;
    /**
     * Request a login QR code.
     * `localTokenList` carries up to 10 known local bot tokens (newest first) so
     * the server can answer `binded_redirect` for an already-bound bot instead
     * of issuing a duplicate session.
     */
    getQrCode(baseUrl: string, localTokenList?: string[]): Promise<QrCodeResponse>;
    /**
     * Poll the QR scan status.
     * `verifyCode` submits a pairing code after the server answered
     * `need_verifycode` (the digits shown in WeChat on the user's phone).
     */
    pollQrStatus(baseUrl: string, qrcode: string, verifyCode?: string): Promise<QrStatusResponse>;
    getUpdates(baseUrl: string, token: string, cursor: string, signal?: AbortSignal): Promise<GetUpdatesResponse>;
    sendMessage(baseUrl: string, token: string, msg: SendMessageRequest['msg']): Promise<Record<string, unknown>>;
    getConfig(baseUrl: string, token: string, userId: string, contextToken: string): Promise<GetConfigResponse>;
    sendTyping(baseUrl: string, token: string, userId: string, ticket: string, status: 1 | 2): Promise<Record<string, unknown>>;
    notifyStart(baseUrl: string, token: string): Promise<Record<string, unknown>>;
    notifyStop(baseUrl: string, token: string): Promise<Record<string, unknown>>;
    getUploadUrl(baseUrl: string, token: string, params: Omit<GetUploadUrlRequest, 'base_info'>): Promise<GetUploadUrlResponse>;
    buildTextMessagePayload(userId: string, contextToken: string, text: string): SendMessageRequest['msg'];
    buildMediaMessagePayload(userId: string, contextToken: string, items: WireMessageItem[]): SendMessageRequest['msg'];
}
//# sourceMappingURL=api.d.ts.map
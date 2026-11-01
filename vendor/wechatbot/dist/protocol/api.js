import { randomUUID } from 'node:crypto';
import { sanitizeBotAgent } from './bot-agent.js';
import { buildAuthHeaders, buildCommonHeaders } from './headers.js';
import { CHANNEL_VERSION, MessageItemType, MessageState, MessageType, } from './types.js';
/**
 * Low-level iLink API calls.
 * Each method maps 1:1 to an API endpoint.
 * No business logic — just wire protocol.
 */
export class ILinkApi {
    http;
    botAgent;
    constructor(http, botAgent) {
        this.http = http;
        this.botAgent = sanitizeBotAgent(botAgent);
    }
    baseInfo() {
        return { channel_version: CHANNEL_VERSION, bot_agent: this.botAgent };
    }
    // ── Auth ──────────────────────────────────────────────────────────────
    /**
     * Request a login QR code.
     * `localTokenList` carries up to 10 known local bot tokens (newest first) so
     * the server can answer `binded_redirect` for an already-bound bot instead
     * of issuing a duplicate session.
     */
    async getQrCode(baseUrl, localTokenList = []) {
        return this.http.apiPost(baseUrl, '/ilink/bot/get_bot_qrcode?bot_type=3', { local_token_list: localTokenList }, buildCommonHeaders());
    }
    /**
     * Poll the QR scan status.
     * `verifyCode` submits a pairing code after the server answered
     * `need_verifycode` (the digits shown in WeChat on the user's phone).
     *
     * LOCAL PATCH (see vendor/NOTICE.md): this endpoint is a LONG POLL — the
     * server holds the connection open until the scan state changes. Measured
     * on this deployment: a single call takes >48s before the client gives up.
     * With the default 15s timeout the SDK timed out on every single poll,
     * retried twice (15+1+15+2+15 = 48s), then threw — and every retry of the
     * login requested a BRAND NEW QR, so the one on the user's screen was
     * always stale. 90s leaves ample headroom.
     */
    async pollQrStatus(baseUrl, qrcode, verifyCode) {
        let path = `/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
        if (verifyCode) {
            path += `&verify_code=${encodeURIComponent(verifyCode)}`;
        }
        return this.http.apiGet(baseUrl, path, buildCommonHeaders(), { timeoutMs: 90_000 });
    }
    // ── Messages ──────────────────────────────────────────────────────────
    async getUpdates(baseUrl, token, cursor, signal) {
        return this.http.apiPost(baseUrl, '/ilink/bot/getupdates', { get_updates_buf: cursor, base_info: this.baseInfo() }, buildAuthHeaders(token), { timeoutMs: 40_000, signal });
    }
    async sendMessage(baseUrl, token, msg) {
        const res = await this.http.apiPost(baseUrl, '/ilink/bot/sendmessage', { msg, base_info: this.baseInfo() }, buildAuthHeaders(token));
        // ── 本地补丁(上游没有) ──
        // 上游把返回值原样丢掉,**没人看 ret**。于是服务端拒了消息
        // (ret 非 0)也一路「发送成功」,消息其实没到 —— 实测发语音就是这样:
        // 没报错,但对方什么都没收到。这种静默失败最浪费时间。
        if (process.env.DSH_WECHAT_DEBUG) {
            console.log('[debug] sendmessage 返回:', JSON.stringify(res));
            console.log('[debug] 请求体:', JSON.stringify({ msg }, null, 0).slice(0, 1200));
        }
        if (res && typeof res.ret === 'number' && res.ret !== 0) {
            const err = new Error(`sendmessage 被拒:ret=${res.ret}${res.errmsg ? ' ' + res.errmsg : ''}`);
            err.ret = res.ret;
            err.response = res;
            throw err;
        }
        return res;
    }
    // ── Typing ────────────────────────────────────────────────────────────
    async getConfig(baseUrl, token, userId, contextToken) {
        return this.http.apiPost(baseUrl, '/ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken, base_info: this.baseInfo() }, buildAuthHeaders(token));
    }
    async sendTyping(baseUrl, token, userId, ticket, status) {
        return this.http.apiPost(baseUrl, '/ilink/bot/sendtyping', { ilink_user_id: userId, typing_ticket: ticket, status, base_info: this.baseInfo() }, buildAuthHeaders(token));
    }
    // ── Lifecycle ─────────────────────────────────────────────────────────
    async notifyStart(baseUrl, token) {
        return this.http.apiPost(baseUrl, '/ilink/bot/msg/notifystart', { base_info: this.baseInfo() }, buildAuthHeaders(token));
    }
    async notifyStop(baseUrl, token) {
        return this.http.apiPost(baseUrl, '/ilink/bot/msg/notifystop', { base_info: this.baseInfo() }, buildAuthHeaders(token));
    }
    // ── Media ─────────────────────────────────────────────────────────────
    async getUploadUrl(baseUrl, token, params) {
        return this.http.apiPost(baseUrl, '/ilink/bot/getuploadurl', { ...params, base_info: this.baseInfo() }, buildAuthHeaders(token));
    }
    // ── Helpers ───────────────────────────────────────────────────────────
    buildTextMessagePayload(userId, contextToken, text) {
        return {
            from_user_id: '',
            to_user_id: userId,
            client_id: randomUUID(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: [{ type: MessageItemType.TEXT, text_item: { text } }],
        };
    }
    buildMediaMessagePayload(userId, contextToken, items) {
        return {
            from_user_id: '',
            to_user_id: userId,
            client_id: randomUUID(),
            message_type: MessageType.BOT,
            message_state: MessageState.FINISH,
            context_token: contextToken,
            item_list: items,
        };
    }
}
//# sourceMappingURL=api.js.map
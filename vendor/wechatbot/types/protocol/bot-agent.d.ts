/** Default `bot_agent` when none is configured or the configured value is invalid. */
export declare const DEFAULT_BOT_AGENT: string;
/**
 * Validate a user-supplied `botAgent` config value into a wire-safe string.
 *
 * Unlike upstream openclaw-weixin (which salvages the valid tokens out of a
 * partially invalid string), any invalid input falls back to
 * `DEFAULT_BOT_AGENT` wholesale — simpler and just as safe on the wire.
 */
export declare function sanitizeBotAgent(raw?: string): string;
//# sourceMappingURL=bot-agent.d.ts.map
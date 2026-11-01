import { type WireMessage } from '../protocol/types.js';
import type { IncomingMessage } from './types.js';
/**
 * Parses raw wire messages into user-friendly IncomingMessage objects.
 * Extracts structured content from the item_list.
 */
export declare class MessageParser {
    /**
     * Parse a wire message into an IncomingMessage.
     * Returns null if the message should be filtered (e.g. bot's own messages).
     */
    parse(wire: WireMessage): IncomingMessage | null;
}
//# sourceMappingURL=parser.d.ts.map
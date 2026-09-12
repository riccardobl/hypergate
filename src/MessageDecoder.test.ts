import { describe, expect, it } from "vitest";
import Message, { MAX_MESSAGE_LENGTH, MessageDecoder } from "./Message.js";
import { rejectUnauthenticatedFrames } from "./Peer.js";

describe("MessageDecoder limits", () => {
    it("rejects an oversized first frame before buffering its payload", () => {
        const decoder = new MessageDecoder(128);
        const header = Buffer.alloc(4);
        header.writeUInt32BE(129);
        decoder.append(header);
        expect(() => decoder.next()).toThrow("exceeds maximum");
    });

    it("can raise the limit after consuming a coalesced authentication frame", () => {
        const decoder = new MessageDecoder(128);
        const hello = Message.frame(Buffer.alloc(80, 1));
        const authorizedPayload = Buffer.alloc(1024, 2);
        decoder.append(Buffer.concat([hello, Message.frame(authorizedPayload)]));

        expect(decoder.next()).toEqual(Buffer.alloc(80, 1));
        decoder.setMaxMessageLength(MAX_MESSAGE_LENGTH);
        expect(decoder.next()).toEqual(authorizedPayload);
    });

    it("discards coalesced frames when an unauthenticated frame is rejected", () => {
        const decoder = new MessageDecoder(128);
        const frame = Message.frame(Buffer.alloc(80, 1));
        decoder.append(Buffer.concat(Array.from({ length: 1000 }, () => frame)));
        expect(decoder.next()).toEqual(Buffer.alloc(80, 1));

        let destroyed = false;
        rejectUnauthenticatedFrames(decoder, { destroy: () => { destroyed = true; } });

        expect(destroyed).toBe(true);
        expect(decoder.next()).toBeUndefined();
    });
});

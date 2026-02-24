import { RoutingTable } from "./Router.js";
export const MAX_MESSAGE_LENGTH = 10 * 1024 * 1024;
export const LENGTH_PREFIX_BYTES = 4;

export type MessageContent = {
    error?: any;
    channelPort?: number;
    gatePort?: number;
    data?: Buffer;
    auth?: Buffer;
    isGate?: boolean;
    routes?: RoutingTable;
    actionId?: number;
    fingerprint?: { [key: string]: any };
};

export enum MessageActions {
    hello = 0, // handshake
    open = 1, // open a channel
    stream = 2, // stream some data from/to a channel
    close = 3, // close a channel
    advRoutes = 4, // advertise peer routes
}

export default class Message {
    public static frame(payload: Buffer): Buffer {
        if (payload.length > MAX_MESSAGE_LENGTH) {
            throw new Error("Message too large");
        }
        const header = Buffer.alloc(LENGTH_PREFIX_BYTES);
        header.writeUInt32BE(payload.length, 0);
        return Buffer.concat([header, payload]);
    }

    public static create(actionId: number, msg: MessageContent): Buffer[] {
        if (msg.error) {
            const msgErrorBuffer = Buffer.from(JSON.stringify(msg.error), "utf8");
            if (msgErrorBuffer.length > 255) {
                throw new Error("Error message too long");
            } else if (msgErrorBuffer.length == 0) {
                throw new Error("Error alias too short");
            }
            const buffer = Buffer.alloc(1 + 1 + 4 + msgErrorBuffer.length);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(msgErrorBuffer.length, 1);
            buffer.writeUInt32BE(msg.channelPort || 0, 2);
            buffer.set(msgErrorBuffer, 1 + 1 + 4);
            return [buffer];
        }

        if (actionId == MessageActions.hello) {
            if (!msg.auth) throw new Error("Auth is required for hello message");
            const buffer = Buffer.alloc(msg.auth.length + 1 + 1 + 4);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.isGate ? 1 : 0, 2);
            buffer.set(msg.auth, 1 + 1 + 4);
            return [buffer];
        } else if (actionId == MessageActions.close) {
            if (msg.channelPort == null) throw new Error("Channel port is required for close message");
            const buffer = Buffer.alloc(4 + 1 + 1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort, 2);
            return [buffer];
        } else if (actionId == MessageActions.stream) {
            if (msg.data == null) throw new Error("Data is required for stream message");
            if (msg.channelPort == null) throw new Error("Channel port is required for stream message");
            let sent = 0;
            let total = msg.data.length;
            const output: Buffer[] = [];
            while (sent < total) {
                let chunk = msg.data.subarray(sent, Math.min(sent + 1024 * 1024, total));
                const buffer = Buffer.alloc(chunk.length + 4 + 1 + 1);
                buffer.writeUInt8(actionId, 0);
                buffer.writeUInt8(0, 1);
                buffer.writeUInt32BE(msg.channelPort, 2);
                buffer.set(chunk, 1 + 1 + 4);
                output.push(buffer);
                sent += chunk.length;
            }
            return output;
        } else if (actionId == MessageActions.advRoutes) {
            const routes = Buffer.from(JSON.stringify({ routes: msg.routes }));
            const buffer = Buffer.alloc(routes.length + 4 + 1 + 1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(0, 2);
            buffer.set(routes, 1 + 1 + 4);
            return [buffer];
        } else if (actionId == MessageActions.open) {
            const fingerprintBuffer =
                msg.fingerprint != null ? Buffer.from(JSON.stringify({ fingerprint: msg.fingerprint }), "utf8") : Buffer.alloc(0);
            const buffer = Buffer.alloc(1 + 1 + 4 + 4 + 4 + fingerprintBuffer.length);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort || 0, 2);
            buffer.writeUInt32BE(msg.gatePort || 0, 2 + 4);
            buffer.writeUInt32BE(fingerprintBuffer.length, 1 + 1 + 4 + 4);
            if (fingerprintBuffer.length > 0) {
                buffer.set(fingerprintBuffer, 1 + 1 + 4 + 4 + 4);
            }
            return [buffer];
        } else {
            throw new Error("Unknown actionId " + actionId);
        }
    }

    public static parse(data: Buffer): MessageContent {
        if (!data || data.length < 6) {
            throw new Error("Invalid message format");
        }
        const actionId = data.readUInt8(0);
        const error = data.readUInt8(1);
        const channelPort = data.readUInt32BE(2);
        data = data.subarray(2 + 4);

        if (error) {
            return {
                actionId: actionId,
                error: JSON.parse(data.toString("utf8", 0, error)),
                channelPort: channelPort,
            };
        }

        if (actionId == MessageActions.open) {
            // open
            const gatePort = data.readUInt32BE(0);
            let fingerprint: { [key: string]: any } | undefined;
            // Backward compatible:
            // old format => [gatePort]
            // new format => [gatePort][fingerprintLength][fingerprintJson]
            if (data.length >= 8) {
                const fingerprintLength = data.readUInt32BE(4);
                if (fingerprintLength > 0 && data.length >= 8 + fingerprintLength) {
                    try {
                        const parsed = JSON.parse(data.subarray(8, 8 + fingerprintLength).toString("utf8"));
                        if (parsed && typeof parsed === "object" && parsed.fingerprint && typeof parsed.fingerprint === "object") {
                            fingerprint = parsed.fingerprint;
                        }
                    } catch {
                        // ignore malformed optional fingerprint payload
                    }
                }
            }
            return {
                actionId: actionId,
                gatePort: gatePort,
                channelPort: channelPort,
                fingerprint,
            };
        } else if (actionId == MessageActions.stream) {
            // stream
            return {
                actionId: actionId,
                channelPort: channelPort,
                data: data,
            };
        } else if (actionId == MessageActions.close) {
            // close
            return {
                actionId: actionId,
                channelPort: channelPort,
            };
        } else if (actionId == MessageActions.advRoutes) {
            // get routing table
            return {
                actionId: actionId,
                routes: JSON.parse(data.toString("utf8")).routes,
                channelPort: channelPort,
            };
        } else if (actionId == MessageActions.hello) {
            // hello
            const isGate = channelPort;
            const auth = data;
            return {
                actionId: actionId,
                auth: auth,
                isGate: isGate == 1,
                channelPort: channelPort,
            };
        }
        throw new Error("Unknown actionId " + actionId);
    }
}

export class MessageDecoder {
    private buffer = Buffer.alloc(0);

    public feed(chunk: Buffer): Buffer[] {
        if (!chunk || chunk.length === 0) {
            return [];
        }
        this.buffer = Buffer.concat([this.buffer, chunk]);
        const messages: Buffer[] = [];
        while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
            const length = this.buffer.readUInt32BE(0);
            if (length > MAX_MESSAGE_LENGTH) {
                throw new Error("Received message exceeds maximum allowed size");
            }
            const total = LENGTH_PREFIX_BYTES + length;
            if (this.buffer.length < total) {
                break;
            }
            messages.push(this.buffer.subarray(LENGTH_PREFIX_BYTES, total));
            this.buffer = this.buffer.subarray(total);
        }
        return messages;
    }

    public reset(): void {
        this.buffer = Buffer.alloc(0);
    }
}

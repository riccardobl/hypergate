import {  RoutingTable } from "./Router.js";
export type MessageContent = {
    error?: any;
    channelPort?: number;
    gatePort?: number;
    data?: Buffer;
    auth?: Buffer;
    isGate?: boolean;
    routes?: RoutingTable;
    actionId?: number;
}

export enum MessageActions {
    hello = 0, // handshake
    open = 1, // open a channel
    stream = 2, // stream some data from/to a channel
    close = 3, // close a channel
    advRoutes = 4, // advertise peer routes
}


export default class Message {

    public static create(actionId: number, msg: MessageContent) : Buffer {
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
            return buffer;
        }
        
        if (actionId == MessageActions.hello) {
            if(!msg.auth) throw new Error("Auth is required for hello message");
            const buffer = Buffer.alloc(msg.auth.length + 1 + 1 + 4);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.isGate ? 1 : 0, 2);
            buffer.set(msg.auth, 1 + 1 + 4);
            return buffer;
        } else if (actionId == MessageActions.close) {
            if(msg.channelPort == null) throw new Error("Channel port is required for close message");
            const buffer = Buffer.alloc(4 + 1 + 1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort, 2);
            return buffer;
        } else if (actionId == MessageActions.stream) {
            if(msg.data == null) throw new Error("Data is required for stream message");
            if(msg.channelPort == null) throw new Error("Channel port is required for stream message");
            const buffer = Buffer.alloc(msg.data.length + 4 + 1 + 1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort, 2);
            buffer.set(msg.data, 1 + 1 + 4);
            return buffer;
        } else if (actionId == MessageActions.advRoutes) {
            const routes = Buffer.from(JSON.stringify({ routes: msg.routes }))
            const buffer = Buffer.alloc(routes.length + 4 + 1 + 1);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(0, 2);
            buffer.set(routes, 1 + 1 + 4);
            return buffer;

        } else if (actionId == MessageActions.open) {
            const buffer = Buffer.alloc(1+1+4+4);
            buffer.writeUInt8(actionId, 0);
            buffer.writeUInt8(0, 1);
            buffer.writeUInt32BE(msg.channelPort || 0, 2);
            buffer.writeUInt32BE(msg.gatePort || 0, 2 + 4);
            return buffer;

        } else {

            throw new Error("Unknown actionId " + actionId);
        }
    }

    public static parse(data: Buffer) : MessageContent {
        const actionId = data.readUInt8(0);
        const error = data.readUInt8(1);
        const channelPort = data.readUInt32BE(2);
        data = data.slice(2 + 4);

        if (error) {
            return {
                actionId: actionId,
                error: JSON.parse(data.toString("utf8", 0, error)),
                channelPort: channelPort
            };
        }


        if (actionId == MessageActions.open) { // open
            const gatePort = data.readUInt32BE(0);
            return {
                actionId: actionId,
                gatePort: gatePort,
                channelPort: channelPort
            };
        } else if (actionId == MessageActions.stream) { // stream
            return {
                actionId: actionId,
                channelPort: channelPort,
                data: data
            };
        } else if (actionId == MessageActions.close) { // close
            return {
                actionId: actionId,
                channelPort: channelPort
            };
        } else if (actionId == MessageActions.advRoutes) { // get routing table
            return {
                actionId: actionId,
                routes: JSON.parse(data.toString("utf8")).routes,
                channelPort: channelPort
            };
        } else if (actionId == MessageActions.hello) { // hello
            const isGate = channelPort;
            const auth = data;
            return {
                actionId: actionId,
                auth: auth,
                isGate: isGate == 1,
                channelPort: channelPort
            };
        }
        throw new Error("Unknown actionId " + actionId);
    }
}
import { describe, expect, it } from "vitest";
import { EventEmitter } from "events";
import UDPNet from "./UDPNet.js";

type FakeRemoteInfo = {
    address: string;
    port: number;
};

class FakeDgramSocket extends EventEmitter {
    private boundPort = 0;
    private boundAddress = "0.0.0.0";
    public connectedPort = 0;
    public connectedHost = "";
    public sent: Array<{ data: Buffer; port: number; host: string }> = [];

    bind(port: number, addr: string) {
        this.boundPort = port || 12345;
        this.boundAddress = addr;
        queueMicrotask(() => this.emit("listening"));
    }

    connect(port: number, host: string) {
        this.connectedPort = port;
        this.connectedHost = host;
        queueMicrotask(() => this.emit("connect"));
    }

    address() {
        return { port: this.boundPort, address: this.boundAddress };
    }

    send(data: Buffer, port: number, host: string) {
        this.sent.push({ data, port, host });
    }

    close() {
        this.emit("close");
    }
}

function emitMessage(socket: FakeDgramSocket, data: string | Buffer, from: FakeRemoteInfo) {
    socket.emit("message", Buffer.isBuffer(data) ? data : Buffer.from(data), from);
}

describe("UDPNet", () => {
    it("does not add duplicate socket listeners when creating pseudo-connections", () => {
        const raw = new FakeDgramSocket();
        const root = new UDPNet(raw as any, true, true);
        (root as any).onConnection = () => { };

        expect(raw.listenerCount("message")).toBe(1);
        expect(raw.listenerCount("error")).toBe(1);
        expect(raw.listenerCount("close")).toBe(1);
        expect(raw.listenerCount("connect")).toBe(1);

        for (let i = 0; i < 25; i++) {
            emitMessage(raw, `m-${i}`, { address: "127.0.0.1", port: 40000 + i });
        }

        expect(Object.keys((root as any).connections)).toHaveLength(25);
        expect(raw.listenerCount("message")).toBe(1);
        expect(raw.listenerCount("error")).toBe(1);
        expect(raw.listenerCount("close")).toBe(1);
        expect(raw.listenerCount("connect")).toBe(1);
    });

    it("removes pseudo-connection from parent map on child close", () => {
        const raw = new FakeDgramSocket();
        const root = new UDPNet(raw as any, true, true);
        let child: UDPNet | undefined;
        (root as any).onConnection = (conn: UDPNet) => {
            child = conn;
        };

        emitMessage(raw, "hello", { address: "127.0.0.1", port: 40123 });

        const key = "127.0.0.1:40123";
        expect((root as any).connections[key]).toBeDefined();
        expect(child).toBeDefined();

        child!.close();

        expect((root as any).connections[key]).toBeUndefined();
    });

    it("routes packets to the correct pseudo-connection without cross-delivery", () => {
        const raw = new FakeDgramSocket();
        const root = new UDPNet(raw as any, true, true);
        const perConnMessages = new Map<string, string[]>();

        (root as any).onConnection = (conn: UDPNet) => {
            const key = `${conn.remoteAddress}:${conn.remotePort}`;
            perConnMessages.set(key, []);
            conn.on("data", (buf: Buffer) => {
                perConnMessages.get(key)?.push(buf.toString("utf8"));
            });
        };

        emitMessage(raw, "c1-a", { address: "127.0.0.1", port: 41001 });
        emitMessage(raw, "c2-a", { address: "127.0.0.1", port: 41002 });
        emitMessage(raw, "c1-b", { address: "127.0.0.1", port: 41001 });
        emitMessage(raw, "c2-b", { address: "127.0.0.1", port: 41002 });

        expect(perConnMessages.get("127.0.0.1:41001")).toEqual(["c1-a", "c1-b"]);
        expect(perConnMessages.get("127.0.0.1:41002")).toEqual(["c2-a", "c2-b"]);
    });

    it("invokes sub-connection data listeners correctly (including multiple listeners)", () => {
        const raw = new FakeDgramSocket();
        const root = new UDPNet(raw as any, true, true);

        let subConn: UDPNet | undefined;
        const callsA: string[] = [];
        const callsB: string[] = [];

        (root as any).onConnection = (conn: UDPNet) => {
            if (conn.remotePort !== 42001) return;
            subConn = conn;
            conn.on("data", (buf: Buffer) => {
                callsA.push(buf.toString("utf8"));
            });
            conn.on("data", (buf: Buffer) => {
                callsB.push(buf.toString("utf8").toUpperCase());
            });
        };

        emitMessage(raw, "first", { address: "127.0.0.1", port: 42001 });
        emitMessage(raw, "second", { address: "127.0.0.1", port: 42001 });
        // Different pseudo-connection should not trigger listeners attached to the first one.
        emitMessage(raw, "other", { address: "127.0.0.1", port: 42002 });

        expect(subConn).toBeDefined();
        expect(callsA).toEqual(["first", "second"]);
        expect(callsB).toEqual(["FIRST", "SECOND"]);
    });

    it("detaches root socket listeners when underlying socket closes", () => {
        const raw = new FakeDgramSocket();
        const root = new UDPNet(raw as any, true, true);

        expect(raw.listenerCount("message")).toBe(1);
        raw.close();

        expect((root as any).isClosed).toBe(true);
        expect(raw.listenerCount("message")).toBe(0);
        expect(raw.listenerCount("error")).toBe(0);
        expect(raw.listenerCount("close")).toBe(0);
        expect(raw.listenerCount("connect")).toBe(0);
    });
});

import Dgram from "dgram";

/**
 * Simple and incomplete wrapper around dgram to make it look like Net
 */
export default class UDPNet {
    private server: Dgram.Socket;
    private isServer: boolean;
    private isCloseable: boolean;
    private events: { [key: string]: Array<(...args: any) => void | Promise<void>> } = {};
    private connections: { [key: string]: UDPNet } = {};
    private parent?: UDPNet;
    private parentKey?: string;
    private readonly attachSocketListeners: boolean;
    private readonly onSocketConnectHandler?: () => void;
    private readonly onSocketMessageHandler?: (data: Buffer, info: Dgram.RemoteInfo) => void;
    private readonly onSocketCloseHandler?: () => void;
    private readonly onSocketErrorHandler?: (err: Error) => void;
    // private channelId: number;
    public remotePort: number = 0;
    public remoteAddress: string = "";
    public localPort: number = 0;
    public localAddress: string = "";
    public isClosed: boolean = false;
    private onConnection?: (conn: UDPNet) => void;

    // udp socket is never destroyed
    public readonly destroyed: boolean = false;

    static createServer(onConnection: (conn: UDPNet) => void): UDPNet {
        const server = new UDPNet(Dgram.createSocket("udp4"));
        server.onConnection = onConnection;
        server.isServer = true;
        server.isCloseable = true;
        return server;
    }

    static connect(options: { host: string; port: number }): UDPNet {
        const { host, port } = options;
        const s = new UDPNet(Dgram.createSocket("udp4"), false, true);
        s.connect(port, host);
        return s;
    }

    constructor(server: Dgram.Socket, isServer = true, isCloseable = true, attachSocketListeners = true) {
        this.server = server;
        this.isServer = isServer;
        this.isCloseable = isCloseable;
        this.attachSocketListeners = attachSocketListeners;

        if (this.attachSocketListeners) {
            this.onSocketConnectHandler = () => {
                this.syncLocalAddress();
                this.emitEvent("connect", []);
            };
            this.onSocketMessageHandler = (data, info) => {
                const key = info.address + ":" + info.port;
                if (this.isServer) {
                    let conn = this.connections[key];
                    if (!conn) {
                        conn = new UDPNet(this.server, false, false, false);
                        conn.parent = this;
                        conn.parentKey = key;
                        conn.remotePort = info.port;
                        conn.remoteAddress = info.address;
                        conn.localPort = this.localPort;
                        conn.localAddress = this.localAddress;
                        this.connections[key] = conn;
                        if (this.onConnection) this.onConnection(conn);
                    }
                    conn.emitEvent("data", [data]);
                } else {
                    this.emitEvent("data", [data]);
                }
            };
            this.onSocketCloseHandler = () => {
                for (const c of Object.values(this.connections)) {
                    c.close();
                }
                this.emitEvent("close", []);
                this.isClosed = true;
                this.detachSocketEventHandlers();
                this.clearEvents();
            };
            this.onSocketErrorHandler = async (err) => {
                for (const c of Object.values(this.connections)) {
                    c.emitEvent("error", [err]);
                }
                this.emitEvent("error", [err]);
            };

            this.server.on("connect", this.onSocketConnectHandler);
            this.server.on("message", this.onSocketMessageHandler);
            this.server.on("close", this.onSocketCloseHandler);
            this.server.on("error", this.onSocketErrorHandler);
        }
    }

    public connect(port: number, host: string): void {
        if (this.isServer) throw new Error("This socket is not connectable");
        this.remotePort = port;
        this.remoteAddress = host;
        this.server.connect(port, host);
    }

    public close(): void {
        if (this.isClosed) return;
        this.isClosed = true;
        if (this.isCloseable) {
            this.server.close();
            return;
        }
        if (this.parent && this.parentKey) {
            delete this.parent.connections[this.parentKey];
        }
        this.emitEvent("close", []);
        this.clearEvents();
    }

    public end(): void {
        this.close();
    }

    public write(data: Buffer): void {
        if (this.isServer) throw new Error("This socket is not writable");
        this.syncLocalAddress();
        this.server.send(data, this.remotePort, this.remoteAddress);
    }

    public on(event: string, cb: (...args: any) => void | Promise<void>): void {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(cb);
    }

    private emitEvent(event: string, payload: Array<any>): void {
        const listeners = this.events[event];
        if (!listeners) return;
        for (const l of listeners) {
            const r: any = l(...payload);
            if (r instanceof Promise) r.catch(console.error);
        }
    }

    public listen(port: number, addr: string, dataListener?: (data: Buffer) => void): void {
        if (!this.isServer) throw new Error("Can't listen on this socket!");
        this.server.once("listening", () => {
            this.syncLocalAddress();
            this.emitEvent("listening", []);
        });
        this.server.bind(port, addr);
        this.localPort = port;
        this.localAddress = addr;
        if (dataListener) this.on("data", dataListener);
    }

    public address(): { port: number; address: string } {
        this.syncLocalAddress();
        return {
            port: this.localPort,
            address: this.localAddress,
        };
    }

    private syncLocalAddress(): void {
        try {
            const info = this.server.address();
            if (typeof info === "string") return;
            this.localPort = info.port ?? this.localPort;
            this.localAddress = info.address ?? this.localAddress;
        } catch {
            // socket may not be bound yet
        }
    }

    private clearEvents(): void {
        this.events = {};
    }

    private detachSocketEventHandlers(): void {
        if (!this.attachSocketListeners) return;
        if (this.onSocketConnectHandler) this.server.off("connect", this.onSocketConnectHandler);
        if (this.onSocketMessageHandler) this.server.off("message", this.onSocketMessageHandler);
        if (this.onSocketCloseHandler) this.server.off("close", this.onSocketCloseHandler);
        if (this.onSocketErrorHandler) this.server.off("error", this.onSocketErrorHandler);
    }
}

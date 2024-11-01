import Dgram from 'dgram';

/**
 * Simple and incomplete wrapper around dgram to make it look like Net
 */
export default class UDPNet {
    private server: Dgram.Socket;
    private isServer: boolean;
    private isCloseable: boolean;
    private events: {[key: string]: Array<Function>} = {}
    private connections: {[key: string]: UDPNet} = {}
    // private channelId: number;
    public remotePort: number = 0;
    public remoteAddress: string = "";
    public localPort: number = 0;
    public localAddress: string = "";
    public isClosed: boolean = false;
    private onConnection: Function|null = null;

    
    static createServer(onConnection: Function) : UDPNet {
        const server = new UDPNet(Dgram.createSocket("udp4"));
        server.onConnection = onConnection;
        server.isServer = true;
        server.isCloseable = true;
        return server;
    }

    static connect(options: { host: string, port: number }) : UDPNet {
        const { host, port } = options;
        const s = new UDPNet(Dgram.createSocket("udp4"), false, true);
        s.connect(port, host);
        return s;
    }

    constructor(server: Dgram.Socket, isServer=true, isCloseable=true) {
        this.server = server;
        this.isServer = isServer;
        this.isCloseable = isCloseable;


        this.server.on("message", (data, info) => {
            const key = info.address + ":" + info.port;
            if (this.isServer) {
                let conn = this.connections[key];
                if (!conn) {
                    console.log("Connection not found for", key, "creating new connection")
                    conn = new UDPNet(this.server);
                    conn.remotePort = info.port;
                    conn.remoteAddress = info.address;
                    conn.localPort = this.localPort;
                    conn.localAddress = this.localAddress;
                    conn.isCloseable = false;
                    this.connections[key] = conn;
                    if(this.onConnection) this.onConnection(conn);
                }
                conn.emitEvent("data", [data]);
            } else {
                this.emitEvent("data", [data]);
            }
        });

        this.server.on("close", async () => {
            for (const c of Object.values(this.connections)) {
                c.close();
            }
            this.emitEvent("close", []);
            this.isClosed = true;
        });


        this.server.on("error", async (err) => {
            for (const c of Object.values(this.connections)) {
                c.emitEvent("error", [err]);
            }
            this.emitEvent("error", [err]);
        });

    }

    public connect(port:number, host:string) : void {
        if (this.isServer) throw new Error("This socket is not connectable");
        this.remotePort = port;
        this.remoteAddress = host;
        this.server.connect(port, host);
    }

    public close() : void {
        this.isClosed = true;
        if (this.isCloseable) {
            if (!this.isClosed) {
                this.server.close();
                this.emitEvent("close", []);
                this.close();
            }
        } else {
            const key = this.remoteAddress + ":" + this.remotePort;
            const conn = this.connections[key];
            if (conn) {
                conn.emitEvent("close", []);
                delete this.connections[key];
            }
        }

    }

    public end() : void {
        this.close();
    }

    public write(data: Buffer) : void {
        if (this.isServer) throw new Error("This socket is not writable");
        this.server.send(data, this.remotePort, this.remoteAddress);

    }


    public on(event:string, cb:Function) : void {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(cb);
    }

    private emitEvent(event:string, payload:Array<any>) : void {
        const listeners = this.events[event];
        if (!listeners) return;
        for (const l of listeners) {
            l(...payload);
        }
    }

    public listen(port:number, addr:string, dataListener?: (data: Buffer) => void) : void {
        if (!this.isServer) throw new Error("Can't listen on this socket!");
        this.server.bind(port, addr);
        this.localPort = port;
        this.localAddress = addr;
        this.server.on("listening", () => {
            //const address = socket.address();
            //this.localPort = address.port;
            this.emitEvent("listening", []);
        });
        if (dataListener) this.on("data", dataListener);

    }

    public address() : { port: number, address: string } {
        return {
            port: this.localPort,
            address: this.localAddress
        }
    }
}
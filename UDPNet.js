import Dgram from 'dgram';

/**
 * Simple and incomplete wrapper around dgram to make it look like Net
 */
export default class UDPNet {
    static createServer(onConnection) {
        const server = new UDPNet(Dgram.createSocket("udp4"));
        server.onConnection = onConnection;
        server.isServer = true;
        server.isCloseable = true;
        return server;
    }

    static connect(options) {
        const { host, port } = options;
        const s = new UDPNet(Dgram.createSocket("udp4"));
        s.isServer = false;
        s.isCloseable = true;
        s.connect(port, host);
        return s;
    }

    constructor(server) {
        this.server = server;


        this.events = {};
        this.connections = {};
        this.channelId = 0;

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
                    this.onConnection(conn);

                }

                conn._emitEvent("data", [data]);

            } else {
                this._emitEvent("data", [data]);
            }
        });

        this.server.on("close", async () => {
            for (const c of Object.values(this.connections)) {
                c.close();
            }
            this._emitEvent("close", []);
            this.closed = true;
        });


        this.server.on("error", async (err) => {
            for (const c of Object.values(this.connections)) {
                c._emitEvent("error", [err]);
            }
            this._emitEvent("error", [err]);
        });

    }

    connect(port, host) {
        if (this.isServer) throw new Error("This socket is not connectable");
        this.remotePort = port;
        this.remoteAddress = host;
        this.server.connect(port, host);
    }

    close() {
        this.closed = true;
        if (this.isCloseable) {
            if (!this.closed) {
                this.server.close();
                this._emitEvent("close", []);
                this.closed();
            }
        } else {
            const key = this.remoteAddress + ":" + this.remotePort;
            const conn = this.connections[key];
            if (conn) {
                conn._emitEvent("close", []);
                delete this.connections[key];
            }
        }

    }

    end() {
        this.close();
    }

    write(data) {
        if (this.isServer) throw new Error("This socket is not writable");
        this.server.send(data, this.remotePort, this.remoteAddress);

    }


    on(event, cb) {
        if (!this.events[event]) this.events[event] = [];
        this.events[event].push(cb);
    }

    _emitEvent(event, payload) {
        const listeners = this.events[event];
        if (!listeners) return;
        for (const l of listeners) {
            l(...payload);
        }
    }

    listen(port, addr) {
        if (!this.isServer) throw new Error("Can't listen on this socket!");
        this.server.bind(port, addr);
        this.localPort = port;
        this.localAddress = addr;
        this.server.on("listening", () => {
            //const address = socket.address();
            //this.localPort = address.port;
            this._emitEvent("listening", []);
        });
    }

    address() {
        return {
            port: this.localPort,
            address: this.localAddress
        }

    }
}
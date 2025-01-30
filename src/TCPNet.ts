import Net from 'net';

const timeout = 60 * 60 * 1000;

export default class TCPNet {
    public static connect(options: Net.NetConnectOpts, connectionListener?: () => void): Net.Socket{
        options.timeout = options.timeout ?? timeout;
        const socket:Net.Socket = Net.connect(options, connectionListener);        
        socket.setKeepAlive(true);
        return socket;
    }

    public static createServer(connectionListener?: (socket: Net.Socket) => void): Net.Server{
        const server:Net.Server = Net.createServer(connectionListener);
        server.on('connection', (socket) => {
            socket.setKeepAlive(true);
            socket.setTimeout(timeout);
        });
        return server;
    }
}
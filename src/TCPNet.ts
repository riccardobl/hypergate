import Net from 'net';
import { Limits } from './Limits.js';


export default class TCPNet {
    public static connect(options: Net.NetConnectOpts, connectionListener?: () => void): Net.Socket{
        const timeout = Limits.TCP_SOCKET_TIMEOUT_MS ?? 60 * 60 * 1000;
        options.timeout = options.timeout ?? timeout;
        const socket:Net.Socket = Net.connect(options, connectionListener);        
        socket.setKeepAlive(true);
        return socket;
    }

    public static createServer(connectionListener?: (socket: Net.Socket) => void): Net.Server{
        const server:Net.Server = Net.createServer(connectionListener);
        server.on('connection', (socket) => {
            socket.setKeepAlive(true);
            socket.setTimeout(Limits.TCP_SOCKET_TIMEOUT_MS ?? 60 * 60 * 1000);
        });
        return server;
    }
}
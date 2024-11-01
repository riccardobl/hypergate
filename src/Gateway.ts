import Peer from "./Peer.js";
import Message, { MessageActions } from "./Message.js";
import Net from 'net';
// @ts-ignore
import b4a from 'b4a';
import UDPNet from './UDPNet.js';
import { RoutingEntry, RoutingTable } from "./Router.js";
import { Socket as NetSocket } from "net";

type Socket = UDPNet | NetSocket;

type Channel = {
    socket: any,
    route?: Buffer,
    buffer: Array<Buffer>,
    duration: number,
    expire: number,
    gate: any,
    alive: boolean,
    pipeData?: (data?: Buffer) => void,
    close?: () => void,
    channelPort: number,
    accepted?: boolean
}

type Gate = {
    protocol: string,
    port: number,
    conn?: UDPNet|Net.Server,
    gateway: Gateway,
    refreshId: number,
    channels: Array<Channel>
}

export default class Gateway extends Peer {
    
    private routingTable: RoutingTable = [];
    private nextChannelId: number = 0;
    private usedChannels: Set<number> = new Set();
    private isStopped = false;
    private isRefreshing = false;
    private listenOnAddr: string;
    private gates: Array<Gate> = [];
    private refreshId: number = 0;
    private routeFilter?: (routingEntry:RoutingEntry) => Promise<boolean> ;
    

    constructor(secret:string, listenOnAddr:string, routeFilter?: (routingEntry:RoutingEntry) => Promise<boolean>, opts? :{}) {
        super(secret, true, opts);
        this.listenOnAddr = listenOnAddr;
        this.routeFilter=routeFilter;
      
        // listen for new routes
        this.addMessageHandler((peer, msg) => {
            if (msg?.actionId == MessageActions.advRoutes) {
                const routes = msg?.routes;
                if(!routes) return false;
                console.log("Receiving routes from " + peer.info.publicKey.toString("hex"), routes)
                this.mergeRoutingTableFragment(routes, peer.info.publicKey);
            }
            return false;
        });
        this.refresh();


    }
  
    // merge routes
    private mergeRoutingTableFragment(routingTableFragment: RoutingTable, peerKey: Buffer) {
        const routeExpiration = Date.now() + 1000 * 60; // 1 minute
        for(const routingEntry of routingTableFragment) {
            const gatePort = routingEntry.gatePort;
            const alias = routingEntry.serviceHost;
            const protocol = routingEntry.protocol;
            const tags = routingEntry.tags;
            let storedRoutingEntry = this.routingTable.find(r => r.gatePort == gatePort && r.serviceHost == alias && r.protocol == protocol && r.tags == tags);
            if(!storedRoutingEntry) {
                storedRoutingEntry = {
                    gatePort: gatePort,
                    serviceHost: alias,
                    servicePort: routingEntry.servicePort,
                    protocol: protocol,
                    routes: [],
                    i:0,
                    tags
                }
                this.routingTable.push(storedRoutingEntry);
            }
            let route = storedRoutingEntry.routes.find(r => r.key.equals(peerKey))
            if(!route) {
                route = {
                    key: peerKey,
                    routeExpiration: routeExpiration
                }
                storedRoutingEntry.routes.push(route);
            }else {
                route.routeExpiration = routeExpiration;
            }
        }
        console.log("Update routing table", JSON.stringify(this.routingTable));
    }

    // find a route
    public getRoute(gatePort:number, serviceHost?:string, protocol?:string, tags?:string) : Buffer {
        const ts:RoutingEntry[] = this.routingTable.filter(r => r.gatePort == gatePort && (!serviceHost || r.serviceHost == serviceHost) && (!protocol || r.protocol == protocol) && (!tags || r.tags == tags));
        for(const t of ts) {
            if (!t.routes.length) continue;
            while(true){
                if (!t.i || t.i >= t.routes.length) t.i = 0;
                const route = t.routes[t.i++];
                if (!route) throw "Undefined route??";
                if (route.routeExpiration < Date.now()) {
                    t.routes.splice(t.i - 1, 1);
                    continue;
                }
                return route.key;
            }            
        }
        throw "No route found";
    }


    private getNextChannel() : number {
        const increment = () => {
            this.nextChannelId++;
            if (this.nextChannelId > 4294967295) this.nextChannelId = 1;
        }

        if (!this.nextChannelId) this.nextChannelId = 1;
        else increment();

        while (this.usedChannels.has(this.nextChannelId))  increment();
        

        this.usedChannels.add(this.nextChannelId);
        return this.nextChannelId;
    }

    private releaseChannel(channelId: number) {
        this.usedChannels.delete(channelId);
    }

    // open a new gate
    public openGate(port: number, protocol: string) {

        const onConnection = (gate:Gate, socket: Socket) => {
            const gatePort = gate.port;
            // on incoming connection, create a channel
            const channelPort = this.getNextChannel();
            console.log('Create channel', channelPort, 'on gate', gatePort);
            const channel: Channel = {
                // protocol:protocol,
                socket: socket,
                buffer: [],
                duration: 1000 * 60,
                expire: Date.now() + 1000 * 60,
                // gatePort:gatePort,
                gate: gate,
                alive: true,
                channelPort
            };

            // store channels in gateway object
            gate.channels.push(channel);

            // pipe data to route
            channel.pipeData = (data?:Buffer) => {
                // reset expiration everytime data is piped
                channel.expire = Date.now() + channel.duration;

                // pipe
                if (channel.route) { // if route established
                    if (channel.buffer.length > 0) {
                        while (channel.buffer.length > 0) {
                            const buffered = channel.buffer.shift();
                            this.send(channel.route, Message.create(MessageActions.stream, {
                                channelPort: channelPort,
                                data: buffered
                            }));
                        }
                    }
                    if (data) {
                        this.send(channel.route, Message.create(MessageActions.stream, {
                            channelPort: channelPort,
                            data: data
                        }));
                    }
                } else { // if still waiting for a route, buffer
                    if (data) channel.buffer.push(data);
                }
            }

            // close route (bidirectional)
            channel.close = () => {

                try {
                    if (channel.route) {
                        this.send(channel.route, Message.create(MessageActions.close, {
                            channelPort: channelPort
                        }));
                    }
                } catch (e) {
                    console.error(e);
                }
                try {
                    socket.end();
                } catch (e) {
                    console.error(e);
                }
                channel.alive = false;
                delete gate.channels[channelPort];
                this.releaseChannel(channelPort);
            };

            // timeout channel
            const timeout = () => {
                if (!channel.alive) return;
                try {
                    if (channel.expire < Date.now()) {
                        console.log("Channel expired!");
                        channel.close?.();
                    }
                } catch (e) {
                    console.error(e);
                }
                setTimeout(timeout, 1000 * 60);
            };
            timeout();

            // pipe gate actions to route
            socket.on("data", channel.pipeData);
            socket.on("close", channel.close);
            socket.on("end", channel.close);
            socket.on("error", channel.close);

            // look for a route
            const findRoute = async () => {
                console.log("Looking for route");
                while (true) {
                    const route = this.getRoute(gatePort);
                    if (!route) { // no route: kill channel
                        channel.close?.();
                        break;
                    }

                    // send open request and wait for response
                    try {
                        await new Promise((res, rej) => {
                            console.log("Test route", b4a.toString(route, "hex"));
                            this.send(route, Message.create(MessageActions.open, {
                                channelPort: channelPort,
                                gatePort: gatePort
                            }));
                            const timeout = setTimeout(() => rej("timeout"), 5000); // timeout open request
                            this.addMessageHandler((peer, msg) => {
                                if (msg.actionId == MessageActions.open && msg.channelPort == channelPort) {

                                    if (msg.error) {
                                        console.log("Received error", msg.error);
                                        rej(msg.error);
                                        return true; // error, detach
                                    }
                                    console.log("Received confirmation");
                                    channel.route = route;
                                    channel.accepted = true;
                                    clearTimeout(timeout);
                                    res(channel);
                                    return true; // detach listener                    
                                }
                                return !channel.alive; // detach when channel dies
                            });

                        });

                        // found a route
                        console.info(
                            "New gate channel opened:", channelPort, " tot: ", gate.channels.length, gate.protocol,
                            "\nInitiated from ", socket.remoteAddress, ":", socket.remotePort,
                            "\n  To", socket.localAddress, ":", socket.localPort);


                        // pipe route data to gate
                        this.addMessageHandler((peer, msg) => {
                            // everytime data is piped, reset expiration
                            channel.expire = Date.now() + channel.duration;

                            // pipe
                            if (msg.actionId == MessageActions.stream && msg.channelPort == channelPort && msg.data) {
                                socket.write(msg.data);
                                return false; // detach listener
                            } else if (msg.actionId == MessageActions.close &&
                                (!msg.channelPort ||  msg.channelPort == channelPort || msg.channelPort <= 0 /* close all */)
                            ) {
                                channel.close?.();
                                return true; // detach listener
                            }
                            return !channel.alive; // detach when channel dies
                        });

                        // pipe pending buffered data
                        channel.pipeData?.();

                        // exit route finding mode, now everything is ready
                        break;
                    } catch (e) {
                        console.error(e);
                        new Promise((res, rej) => setTimeout(res, 100)); // wait 100 ms
                    }
                }

            };
            findRoute();
        }

        const gate:Gate = {
            protocol: protocol,
            port: port,
            gateway:this,
            refreshId: this.refreshId,
            channels: []
        }
        const conn = (protocol == "udp" ? UDPNet : Net).createServer((socket) => {
            onConnection(gate,  socket);
        });

        conn.listen(port, this.listenOnAddr, () => {
            if (port == 0) {
                const addr = conn.address()
                if(!addr||typeof addr == "string") return
                else {    
                    port = addr.port ?? 0;
                }
            }
        });

        gate.conn = conn;
        console.info("Opened new gate on", this.listenOnAddr + ":" + gate.port, "with protocol", gate.protocol);
        return gate;
       

    }


    getGate(port: number, protocol: string) {
        return this.gates.find(g => g.port == port && g.protocol == protocol);
    }


    async refresh() {
        if (this.isStopped) return;
        super.refresh();
        this.isRefreshing = true;
        this.refreshId++;

        for (const routingEntry of this.routingTable) {
            try {
                const gatePort = routingEntry.gatePort;
                const gateProtocol = routingEntry.protocol;
                if(this.routeFilter) {
                    if(!await this.routeFilter(routingEntry)) {
                        // console.log("Route filtered", routingEntry);
                        continue;
                    }
                }
                let gate = this.getGate(gatePort, gateProtocol);
                if(gate) {
                    gate.refreshId = this.refreshId;
                } else {
                    gate = this.openGate(gatePort, gateProtocol);
                    if (gate){
                        this.gates.push(gate);
                    }
                }
            } catch (e) {
                console.error(e);
            }
        }

        for (let i=0; i<this.gates.length; i++) {
            const gate = this.gates[i];
            if (gate.refreshId != this.refreshId) {
                this.gates.splice(i, 1);
                for (const channel of gate.channels) {
                    await channel.close?.();
                }
                await gate.conn?.close()
            }
        }
        this.isRefreshing = false;
    }


    

}

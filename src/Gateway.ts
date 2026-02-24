import Peer from "./Peer.js";
import Message, { MessageActions } from "./Message.js";
import Net from "net";
// @ts-ignore
import b4a from "b4a";
import UDPNet from "./UDPNet.js";
import TCPNet from "./TCPNet.js";
import { Route, RoutingEntry, RoutingTable } from "./Router.js";
import { Socket as NetSocket } from "net";
import Utils from "./Utils.js";
import { randomBytes } from "crypto";
import { RateLimiter } from "./RateLimit.js";
import {
    lookupIngressPolicy
} from "./IngressPolicy.js";

export const MAX_BUFFER_PER_CHANNEL = 150 * 1024 * 1024; // 150 MB

type Socket = UDPNet | NetSocket;

export type Channel = {
    socket: any;
    route?: Route;
    buffer: Array<Buffer>;
    bufferSize: number;
    duration: number;
    expire: number;
    gate: any;
    alive: boolean;
    pipeData?: (data?: Buffer) => void;
    close?: () => void;
    channelPort: number;
    accepted?: boolean;
    fingerprint?: { [key: string]: any };
    rateLimit?: RateLimiter;
};

type Gate = {
    protocol: string;
    port: number;
    conn?: UDPNet | Net.Server;
    gateway: Gateway;
    refreshId: number;
    channels: Array<Channel>;
};

export default class Gateway extends Peer {
    private readonly routingTable: RoutingTable = [];
    private readonly usedChannels: Set<number> = new Set();
    private readonly listenOnAddr: string;
    private readonly gates: Array<Gate> = [];
    private readonly routeFilter?: (routingEntry: RoutingEntry) => Promise<boolean>;
    private readonly routeFindingTimeout: number = 5 * 60 * 1000; // 5 minutes

    private nextChannelId: number = 0;
    private refreshId: number = 0;

    constructor(
        secret: string,
        listenOnAddr: string,
        routeFilter?: (routingEntry: RoutingEntry) => Promise<boolean>,
        opts?: object
    ) {
        super(secret, true, opts);
        this.listenOnAddr = listenOnAddr;
        this.routeFilter = routeFilter;

        // listen for new routes
        this.addMessageHandler((peer, msg) => {
            if (msg?.actionId == MessageActions.advRoutes) {
                const routes = msg?.routes;
                if (!routes) return false;
                console.log("Receiving routes from " + peer.info.publicKey.toString("hex"), routes);
                this.mergeRoutingTableFragment(routes, peer.info.publicKey);
            }
            return false;
        });
        this.stats();
        this.start().catch(console.error);
    }

    private stats() {
        const activeGates = this.gates.length;
        let activeChannels = 0;
        let closingChannels = 0;
        let pendingChannels = 0;

        for (const gate of this.gates) {
            activeChannels += gate.channels.filter((c) => c.alive && c.accepted).length;
            closingChannels += gate.channels.filter((c) => !c.alive && c.accepted).length;
            pendingChannels += gate.channels.filter((c) => !c.accepted).length;
        }

        console.info(`
            Gates
                - active:  ${activeGates}
            Channels
                - active:  ${activeChannels}
                - closing: ${closingChannels}
                - pending: ${pendingChannels}            
        `);

        const channelLines: string[] = [];
        for (const gate of this.gates) {
            for (const channel of gate.channels) {
                if (!channel.alive) continue;
                const stats = channel.rateLimit?.getStats() || "{}";
                channelLines.push(JSON.stringify(stats, null, 2) + "\n  " + JSON.stringify(channel.fingerprint));
            }
        }
        console.info("Channel details (" + channelLines.length + "):\n" + channelLines.join("\n"));


        setTimeout(() => {
            this.stats();
        }, 10 * 60_000);
    }

    // merge routes
    private mergeRoutingTableFragment(routingTableFragment: RoutingTable, peerKey: Buffer) {
        const routeExpiration = Date.now() + 1000 * 60; // 1 minute
        for (const routingEntry of routingTableFragment) {
            const gatePort = routingEntry.gatePort;
            const alias = routingEntry.serviceHost;
            const protocol = routingEntry.protocol;
            const tags = routingEntry.tags;
            const ingressPolicy = routingEntry.ingressPolicy;
            let storedRoutingEntry = this.routingTable.find((r) => r.gatePort == gatePort && r.serviceHost == alias && r.protocol == protocol && r.tags == tags);
            if (!storedRoutingEntry) {
                storedRoutingEntry = {
                    gatePort: gatePort,
                    serviceHost: alias,
                    servicePort: routingEntry.servicePort,
                    protocol: protocol,
                    routes: [],
                    i: 0,
                    tags,
                };
                this.routingTable.push(storedRoutingEntry);
            }
            let route = storedRoutingEntry.routes.find((r) => r.key.equals(peerKey));
            if (!route) {
                route = {
                    key: peerKey,
                    routeExpiration: routeExpiration,
                    ingressPolicy: ingressPolicy ?? {},
                };
                storedRoutingEntry.routes.push(route);
            } else {
                route.routeExpiration = routeExpiration;
                route.ingressPolicy = ingressPolicy ?? route.ingressPolicy;
            }
        }
        console.log("Update routing table", JSON.stringify(this.routingTable));
    }

    // find a route
    public getRoute(gatePort: number, serviceHost?: string, protocol?: string, tags?: string): [Route, RoutingEntry] {
        const ts: RoutingEntry[] = this.routingTable.filter(
            (r) => r.gatePort == gatePort && (!serviceHost || r.serviceHost == serviceHost) && (!protocol || r.protocol == protocol) && (!tags || r.tags == tags),
        );
        for (const t of ts) {
            if (!t.routes.length) continue;
            while (true) {
                if (!t.i || t.i >= t.routes.length) t.i = 0;
                const route = t.routes[t.i++];
                if (!route) throw "Undefined route??";
                if (route.routeExpiration < Date.now()) {
                    t.routes.splice(t.i - 1, 1);
                    continue;
                }
                return [route, t];
            }
        }
        throw "No route found";
    }

    private getNextChannel(): number {
        const increment = () => {
            this.nextChannelId++;
            if (this.nextChannelId > 4294967295) this.nextChannelId = 1;
        };

        if (!this.nextChannelId) this.nextChannelId = 1;
        else increment();

        while (this.usedChannels.has(this.nextChannelId)) increment();

        this.usedChannels.add(this.nextChannelId);
        return this.nextChannelId;
    }

    private releaseChannel(channelId: number) {
        this.usedChannels.delete(channelId);
    }

    // open a new gate
    public openGate(port: number, protocol: string) {
        const onConnection = (gate: Gate, socket: Socket) => {
            const remoteIp = socket.remoteAddress;
            const gatePort = gate.port;
            // on incoming connection, create a channel
            const channelPort = this.getNextChannel();
            console.log("Create channel", channelPort, "on gate", gatePort);

            const duration = Utils.getConnDuration(protocol == "udp");
            const channel: Channel = {
                // protocol:protocol,
                socket: socket,
                buffer: [],
                bufferSize: 0,
                duration,
                expire: Date.now() + duration,
                // gatePort:gatePort,
                gate: gate,
                alive: true,
                channelPort,
                fingerprint: {
                    id: randomBytes(16).toString("hex"),
                    openedAt: Date.now(),
                    protocol: gate.protocol,
                    gatePort,
                    channelPort,
                    source: {
                        ip: socket.remoteAddress,
                        ipRaw: socket.remoteAddress,
                        port: socket.remotePort ?? 0,
                    },
                    gateway: {
                        ip: socket.localAddress,
                        ipRaw: socket.localAddress,
                        port: socket.localPort ?? 0,
                    },
                }
            };

            // store channels in gateway object
            gate.channels.push(channel);

            // pipe data to route
            channel.pipeData = (data?: Buffer) => {
                const handler = channel.rateLimit?.handle ?? ((data, callback) => {
                    callback()
                    return true;
                });

                const ok = handler(data, () => {
                    // reset expiration everytime data is piped
                    channel.expire = Date.now() + channel.duration;

                    // pipe
                    if (channel.route) {
                        // if route established
                        if (channel.buffer.length > 0) {
                            const merged = Buffer.concat(channel.buffer);
                            channel.buffer = [];
                            channel.bufferSize = 0;
                            this.send(
                                channel.route.key,
                                Message.create(MessageActions.stream, {
                                    channelPort: channelPort,
                                    data: merged,
                                }),
                            );
                        }
                        if (data) {
                            this.send(
                                channel.route.key,
                                Message.create(MessageActions.stream, {
                                    channelPort: channelPort,
                                    data: data,
                                }),
                            );
                        }
                    } else {
                        // if still waiting for a route, buffer
                        if (data && channel.alive) {
                            // limit how much data we buffer
                            channel.bufferSize += data.length;
                            if (channel.bufferSize > MAX_BUFFER_PER_CHANNEL) {
                                console.warn("Buffer limit exceeded for channel " + channelPort + ", killing it immediately");
                                channel.buffer = [];
                                channel.bufferSize = 0;
                                channel.close?.();
                                return;
                            }
                            channel.buffer.push(data);
                        }
                    }
                });
                if (!ok && channel.alive) {
                    console.warn("Rate limiter rejected channel " + channelPort + " (burst exceeded), closing");
                    channel.close?.();
                }
            };

            // close route (bidirectional)
            channel.close = () => {
                channel.rateLimit?.close();
                try {
                    if (channel.route) {
                        this.send(
                            channel.route.key,
                            Message.create(MessageActions.close, {
                                channelPort: channelPort,
                            }),
                        );
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
                this.releaseChannel(channelPort);
            };

            // timeout channel
            const timeout = () => {
                if (!channel.alive) return;
                try {
                    // if the socket is destroyed or the channel has expired
                    const isExpired = socket.destroyed || channel.expire < Date.now();
                    if (isExpired) {
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
                try {
                    console.log("Looking for route");
                    const routeFindingStartedAt = Date.now();

                    while (true) {
                        const [r, t]: [Route, RoutingEntry] = this.getRoute(gatePort);
                        const routeIngressRule = lookupIngressPolicy(
                            r.ingressPolicy,
                            remoteIp!,
                            gate.port,
                            gate.protocol,
                        );
                        if (routeIngressRule && !routeIngressRule.allow) {
                            throw new Error("Route denied by provider ingress policy");
                        }

                        // send open request and wait for response
                        try {
                            await new Promise((res, rej) => {
                                console.log("Test route", b4a.toString(r.key, "hex"));
                                this.send(
                                    r.key,
                                    Message.create(MessageActions.open, {
                                        channelPort: channelPort,
                                        gatePort: gatePort,
                                        fingerprint: channel.fingerprint,
                                    }),
                                );
                                const timeout = setTimeout(() => rej("route timeout " + JSON.stringify(gate)), 5000); // timeout open request
                                this.addMessageHandler((peer, msg) => {
                                    if (msg.actionId == MessageActions.open && msg.channelPort == channelPort) {
                                        if (msg.error) {
                                            console.log("Received error", msg.error);
                                            rej(msg.error);
                                            return true; // error, detach
                                        }
                                        console.log("Received confirmation");
                                        channel.route = r;
                                        channel.rateLimit = new RateLimiter(channelPort, routeIngressRule);
                                        channel.accepted = true;
                                        clearTimeout(timeout);
                                        res(channel);
                                        return true; // detach listener
                                    }
                                    return !channel.alive; // detach when channel dies
                                });
                            });

                            // found a route
                            console.log(
                                "New gate channel opened:",
                                channelPort,
                                " tot: ",
                                gate.channels.length,
                                gate.protocol,
                                "\nInitiated from ",
                                socket.remoteAddress,
                                ":",
                                socket.remotePort,
                                "\n  To",
                                socket.localAddress,
                                ":",
                                socket.localPort,
                            );

                            // pipe route data to gate
                            this.addMessageHandler((peer, msg) => {
                                // everytime data is piped, reset expiration
                                channel.expire = Date.now() + channel.duration;

                                // pipe
                                if (msg.actionId == MessageActions.stream && msg.channelPort == channelPort && msg.data) {
                                    socket.write(msg.data);
                                    return false;
                                } else if (msg.actionId == MessageActions.close && (!msg.channelPort || msg.channelPort == channelPort || msg.channelPort <= 0) /* close all */) {
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
                            if (Date.now() - routeFindingStartedAt > this.routeFindingTimeout) {
                                throw new Error("Route finding timeout");
                            }
                            await new Promise((res) => setTimeout(res, 100)); // wait 100 ms
                        }
                    }
                } catch (e) {
                    channel.close?.();
                    throw e;
                }
            };
            findRoute().catch(console.error);
        };

        const gate: Gate = {
            protocol: protocol,
            port: port,
            gateway: this,
            refreshId: this.refreshId,
            channels: [],
        };
        const conn = (protocol == "udp" ? UDPNet : TCPNet).createServer((socket) => {
            onConnection(gate, socket);
        });

        conn.listen(gate.port, this.listenOnAddr, () => {
            if (gate.port == 0) {
                const addr = conn.address();
                if (!addr || typeof addr == "string") return;
                else {
                    gate.port = addr.port ?? 0;
                }
            }
        });

        gate.conn = conn;
        console.info("Opened new gate on", this.listenOnAddr + ":" + gate.port, "with protocol", gate.protocol);
        return gate;
    }

    private getGate(port: number, protocol: string) {
        return this.gates.find((g) => g.port == port && g.protocol == protocol);
    }

    protected override async onRefresh() {
        try {
            this.refreshId++;

            for (const routingEntry of this.routingTable) {
                try {
                    const gatePort = routingEntry.gatePort;
                    const gateProtocol = routingEntry.protocol;
                    if (this.routeFilter) {
                        if (!(await this.routeFilter(routingEntry))) {
                            // console.log("Route filtered", routingEntry);
                            continue;
                        }
                    }
                    let gate = this.getGate(gatePort, gateProtocol);
                    if (gate) {
                        gate.refreshId = this.refreshId;
                    } else {
                        gate = this.openGate(gatePort, gateProtocol);
                        if (gate) {
                            this.gates.push(gate);
                        }
                    }
                } catch (e) {
                    console.error(e);
                }
            }

            for (let i = 0; i < this.gates.length; ) {
                const gate = this.gates[i];
                if (gate.refreshId != this.refreshId) {
                    this.gates.splice(i, 1);
                    for (const channel of gate.channels) {
                        await channel.close?.();
                    }
                    await gate.conn?.close();
                } else {
                    i++;
                }
            }

            for (const gate of this.gates) {
                for (let j = 0; j < gate.channels.length; ) {
                    if (!gate.channels[j].alive) {
                        gate.channels.splice(j, 1);
                    } else {
                        j++;
                    }
                }
            }
        } catch (e) {
            console.error(e);
        }
    }
}

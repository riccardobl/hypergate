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
import { Protocol, protocolToString } from "./Protocol.js";
import {
    parseIngressPolicy,
    lookupIngressPolicy
} from "./IngressPolicy.js";
import LimitRemoverService from "./LimitRemoverService.js";
import { Limits } from "./Limits.js";
import { writeWithBackpressure } from "./RelayBackpressure.js";


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
    pipeChain?: Promise<void>;
    routePipeChain?: Promise<void>;
    queuedWriteBytes?: number;
};

type Gate = {
    protocol: Protocol;
    port: number;
    conn?: UDPNet | Net.Server;
    gateway: Gateway;
    refreshId: number;
    channels: Array<Channel>;
};

export type GatewayAdminOptions = {
    unlimitedSecret?: string | null;
    unlimitedHost?: string;
    unlimitedPort?: number;
};

export function getBufferedPayloadsForFlush(protocol: Protocol, buffered: Buffer[]): Buffer[] {
    if (buffered.length === 0) {
        return [];
    }
    if (protocol == Protocol.udp) {
        return buffered;
    }
    return [Buffer.concat(buffered)];
}

export default class Gateway extends Peer {
    private readonly routingTable: RoutingTable = [];
    private readonly usedChannels: Set<number> = new Set();
    private readonly listenOnAddr: string;
    private readonly gates: Array<Gate> = [];
    private readonly routeFilter?: (routingEntry: RoutingEntry) => Promise<boolean>;
    private readonly routeFindingTimeout: number = Limits.ROUTE_FINDING_TIMEOUT_MS;
    private limitRemoverService?: LimitRemoverService;

    private nextChannelId: number = 0;
    private refreshId: number = 0;

    constructor(
        secret: string,
        listenOnAddr: string,
        routeFilter?: (routingEntry: RoutingEntry) => Promise<boolean>,
        opts?: object,
        adminOpts?: GatewayAdminOptions,
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
        this.startAdminServer(adminOpts);
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
        }, Limits.STATS_INTERVAL_MS);
    }

    // merge routes
    private mergeRoutingTableFragment(routingTableFragment: RoutingTable, peerKey: Buffer) {
        const routeExpiration = Date.now() + Limits.ROUTE_EXPIRATION_MS;
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
    public getRoute(gatePort: number, serviceHost?: string, protocol?: Protocol, tags?: string): [Route, RoutingEntry] {
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
    public openGate(port: number, protocol: Protocol) {
        const onConnection = (gate: Gate, socket: Socket) => {
            const remoteIp = socket.remoteAddress;
            const gatePort = gate.port;
            const protocol = gate.protocol;
            // on incoming connection, create a channel
            const channelPort = this.getNextChannel();
            console.log("Create channel", channelPort, "on gate", gatePort);

            const duration = Utils.getConnDuration(protocol == Protocol.udp);
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
                    protocol: protocolToString(gate.protocol),
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

            // pipe data to route, serializing per-channel to preserve order.
            channel.pipeData = (data?: Buffer) => {
                const run = async () => {
                    if (!channel.alive) return;
                    const pausable = socket as any as { pause?: () => void; resume?: () => void };
                    const canPause = typeof pausable.pause === "function" && typeof pausable.resume === "function";
                    const hasPayload = !!data && data.length > 0;
                    const sendStreamData = (payload: Buffer) => {
                        if (!channel.route) return;
                        this.send(
                            channel.route.key,
                            Message.create(MessageActions.stream, {
                                channelPort: channelPort,
                                data: payload,
                            }),
                        );
                    };
                    if (hasPayload && canPause) {
                        pausable.pause?.();
                    }
                    try {
                        if (hasPayload && channel.rateLimit && channel.route) {
                            const ok = await channel.rateLimit.acquire(data.length);
                            if (!ok && channel.alive) {
                                console.warn("Rate limiter rejected channel " + channelPort + ", closing");
                                channel.close?.();
                                return;
                            }
                        }

                        // reset expiration everytime data is piped
                        channel.expire = Date.now() + channel.duration;

                        // pipe
                        if (channel.route) {
                            // if route established
                            if (channel.buffer.length > 0) {
                                const pending = channel.buffer;
                                channel.buffer = [];
                                channel.bufferSize = 0;
                                for (const chunk of getBufferedPayloadsForFlush(gate.protocol, pending)) {
                                    sendStreamData(chunk);
                                }
                            }
                            if (data) {
                                sendStreamData(data);
                            }
                        } else {
                            // if still waiting for a route, buffer
                            if (data && channel.alive) {
                                // limit how much data we buffer
                                channel.bufferSize += data.length;
                                if (channel.bufferSize > Limits.MAX_BUFFER_PER_CHANNEL) {
                                    console.warn("Buffer limit exceeded for channel " + channelPort + ", killing it immediately");
                                    channel.buffer = [];
                                    channel.bufferSize = 0;
                                    channel.close?.();
                                    return;
                                }
                                channel.buffer.push(data);
                            }
                        }
                    } finally {
                        if (hasPayload && canPause && channel.alive) {
                            pausable.resume?.();
                        }
                    }
                };

                channel.pipeChain = (channel.pipeChain ?? Promise.resolve()).then(run, run).catch((e) => {
                    console.error(e);
                    if (channel.alive) {
                        channel.close?.();
                    }
                });
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
                setTimeout(timeout, Limits.CHANNEL_TIMEOUT_POLL_MS);
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
                            // merge route policy with local overrides if any
                            parseIngressPolicy(r.ingressPolicy ?? {}, this.limitRemoverService?.getIngressOverrides() ?? {}),
                            remoteIp!,
                            gate.port,
                            gate.protocol,
                        );
                        if (routeIngressRule && !routeIngressRule.allow) {
                            throw new Error("Route denied by provider ingress policy");
                        }
                        if (channel.fingerprint) {
                            if (routeIngressRule?.labels && routeIngressRule.labels.length > 0) {
                                channel.fingerprint.ingressLabels = [...routeIngressRule.labels];
                            } else {
                                delete channel.fingerprint.ingressLabels;
                            }
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
                                        protocol: gate.protocol,
                                        fingerprint: channel.fingerprint,
                                    }),
                                );
                                const timeout = setTimeout(() => rej("route timeout " + gate.port + "->" + channelPort), Limits.OPEN_REQUEST_TIMEOUT_MS); // timeout open request
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
                                    const chunk = msg.data;
                                    if (gate.protocol != Protocol.tcp) {
                                        socket.write(chunk);
                                        return false;
                                    }

                                    const destination = socket as NetSocket;
                                    const queuedBytes = chunk.length;
                                    channel.queuedWriteBytes = (channel.queuedWriteBytes ?? 0) + queuedBytes;
                                    if ((channel.queuedWriteBytes ?? 0) > Limits.MAX_BUFFER_PER_CHANNEL) {
                                        console.warn("Buffered route->gate data exceeded limit for channel " + channelPort + ", closing");
                                        channel.close?.();
                                        return false;
                                    }

                                    const writeChunk = async () => {
                                        try {
                                            if (!channel.alive || destination.destroyed) return;
                                            await writeWithBackpressure(destination, undefined, chunk, true);
                                        } finally {
                                            channel.queuedWriteBytes = Math.max(0, (channel.queuedWriteBytes ?? 0) - queuedBytes);
                                        }
                                    };

                                    channel.routePipeChain = (channel.routePipeChain ?? Promise.resolve()).then(writeChunk, writeChunk).catch((e) => {
                                        console.error(e);
                                        if (channel.alive) {
                                            channel.close?.();
                                        }
                                    });
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
                            const delay = Math.floor(Math.random() * (Limits.FIND_ROUTE_RETRY_MAX_MS - Limits.FIND_ROUTE_RETRY_MIN_MS + 1)) + Limits.FIND_ROUTE_RETRY_MIN_MS;
                            console.log("Retrying route finding in " + delay + "ms");
                            await new Promise((res) => setTimeout(res, delay)); // wait
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
        const conn = (protocol == Protocol.udp ? UDPNet : TCPNet).createServer((socket) => {
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
        console.info("Opened new gate on", this.listenOnAddr + ":" + gate.port, "with protocol", protocolToString(gate.protocol));
        return gate;
    }

    private getGate(port: number, protocol: Protocol) {
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

    public override async stop() {
        if (this.limitRemoverService) {
            await this.limitRemoverService.close();
            this.limitRemoverService = undefined;
        }
        await super.stop();
    }

    private startAdminServer(opts?: GatewayAdminOptions) {
        if (!opts?.unlimitedSecret) return;
        const host = opts?.unlimitedHost || "127.0.0.1";
        const port = opts?.unlimitedPort ?? 8091;
        this.limitRemoverService = new LimitRemoverService({
            secret: opts.unlimitedSecret,
            host,
            port,
            onListen: (url) => {
                console.info("Gateway admin endpoint listening on " + url);
            },
        });
    }
}

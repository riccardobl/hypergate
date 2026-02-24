import Peer from "./Peer.js";
import Message, { MessageContent } from "./Message.js";
import UDPNet from "./UDPNet.js";
import { MessageActions } from "./Message.js";
import { AuthorizedPeer } from "./Peer.js";
import { RoutingTable, Service } from "./Router.js";
import Utils from "./Utils.js";
import TCPNet from "./TCPNet.js";
import FingerprintResolver, { FingerprintResolverOptions } from "./FingerprintResolver.js";
import { IngressPolicy } from "./IngressPolicy.js";
import { Protocol, protocolToString } from "./Protocol.js";

export default class ServiceProvider extends Peer {
    private services: Array<Service> = [];
    private readonly fingerprintResolver: FingerprintResolver;
    private readonly ingressPolicy?: IngressPolicy;

    constructor(secret: string, opts?: object, fingerprintResolverOpts?: FingerprintResolverOptions, ingressPolicy?: IngressPolicy) {
        super(secret, false, opts);
        this.fingerprintResolver = new FingerprintResolver(fingerprintResolverOpts);
        this.ingressPolicy = ingressPolicy;
        this.fingerprintResolver.start();
        this.start().catch(console.error);
    }

    public override async stop() {
        await this.fingerprintResolver.stop();
        await super.stop();
    }

    public setServices(services: Service[]): Array<Service> {
        this.services = [];
        for (const service of services) {
            this.addService(service.gatePort, service.serviceHost, service.servicePort, service.protocol, service.tags);
        }
        return this.services;
    }

    public addService(gatePort: number, serviceHost: string, servicePort: number, serviceProto: Protocol, tags?: string): Service {
        let service = this.services.find(
            (s) =>
                s.gatePort == gatePort &&
                s.serviceHost == serviceHost &&
                s.servicePort == servicePort &&
                s.protocol == serviceProto &&
                s.tags == tags
        );
        if (service) {
            console.log("Service already exists");
            return service;
        }
        console.info("Register service " + gatePort + " " + serviceHost + " " + servicePort + " " + protocolToString(serviceProto));
        service = {
            serviceHost,
            servicePort,
            protocol: serviceProto ?? Protocol.tcp,
            gatePort: gatePort,
            tags: tags,
        };
        this.services.push(service);
        return service;
    }

    public getServices(gatePort: number, protocol: Protocol) {
        return this.services.filter(
            (s) => s.gatePort == gatePort && s.protocol == protocol,
        );
    }

    private registerFingerprintTuple(channel: any) {
        this.fingerprintResolver.registerChannel(channel);
    }

    private unregisterFingerprintTuple(channel: any) {
        this.fingerprintResolver.unregisterChannel(channel);
    }

    private createRoutingTableFragment(): RoutingTable {
        const routingTable: RoutingTable = [];
        if (Object.keys(this.services).length == 0) return routingTable;
        for (const service of this.services) {
            const routingEntry = {
                ...service,
                routes: [],
                ingressPolicy: this.ingressPolicy,
            };
            routingTable.push(routingEntry);
        }
        return routingTable;
    }

    protected override async onRefresh() {
        try {
            // Advertise local routes to newly connected peer
            const rfr = this.createRoutingTableFragment();
            if (rfr) {
                await this.broadcast(Message.create(MessageActions.advRoutes, { routes: rfr }));
                console.log("Broadcast routing fragment", rfr);
            }
        } catch (e) {
            console.error(e);
        }
    }

    protected override async onAuthorizedMessage(peer: AuthorizedPeer, msg: MessageContent) {
        await super.onAuthorizedMessage(peer, msg);
        try {
            // close channel bidirectional
            const closeChannel = (channelPort: number) => {
                const channel = peer.channels[channelPort];
                if (!channel) return;
                this.unregisterFingerprintTuple(channel);
                try {
                    if (channel.route) {
                        this.send(
                            channel.route,
                            Message.create(MessageActions.close, {
                                channelPort: channelPort,
                            }),
                        );
                    }
                } catch (e) {
                    console.error(e);
                }
                if (channel.socket) {
                    channel.socket.end();
                }
                channel.alive = false;
                delete peer.channels[channelPort];
            };

            // open new channel
            if (msg.actionId == MessageActions.open) {
                // open connection to service
                const gatePort = msg.gatePort;
                if (!gatePort) throw "Gate port is required";
                const requestedProtocol = msg.protocol ?? Protocol.tcp;
                const service = this.getServices(gatePort, requestedProtocol)[0];
                if (!service) throw "Service not found " + gatePort;
                const isUDP = service.protocol == Protocol.udp;
                const channelPort = msg.channelPort;
                if (channelPort == null) throw "Channel port is required";

                // Service not found, tell peer there was an error
                if (!service) {
                    console.error("service not found");
                    this.send(
                        peer.info.publicKey,
                        Message.create(MessageActions.open, {
                            channelPort: msg.channelPort,
                            error: "Service " + gatePort + " not found",
                        }),
                    );
                    // closeChannel(msg.channelPort);
                    return;
                }

                // connect to service
                console.log("Connect to", service.serviceHost, service.servicePort, isUDP ? "UDP" : "TCP", "on channel", msg.channelPort);

                const serviceConn = (isUDP ? UDPNet : TCPNet).connect({
                    host: service.serviceHost,
                    port: service.servicePort,
                    allowHalfOpen: true,
                });

                const duration = Utils.getConnDuration(isUDP);
                // create channel
                const channel = {
                    socket: serviceConn,
                    duration,
                    expire: Date.now() + duration,
                    gatePort: gatePort,
                    alive: true,
                    route: peer.info.publicKey,
                    channelPort: channelPort,
                    service: service,
                    fingerprint: msg.fingerprint,
                };
                peer.channels[channel.channelPort] = channel;

                serviceConn.on("connect", () => {
                    this.registerFingerprintTuple(channel);
                });

                // pipe from service to route
                serviceConn.on("data", (data) => {
                    // every time data is piped, reset channel expire time
                    channel.expire = Date.now() + channel.duration;
                    this.registerFingerprintTuple(channel);

                    this.send(
                        channel.route,
                        Message.create(MessageActions.stream, {
                            channelPort: msg.channelPort,
                            data: data,
                        }),
                    );
                });

                const timeout = () => {
                    if (!channel.alive) return;
                    try {
                        if (serviceConn.destroyed || channel.expire < Date.now()) {
                            console.log("Channel expired!");
                            closeChannel(channel.channelPort);
                        }
                    } catch (e) {
                        console.error(e);
                    }
                    setTimeout(timeout, 1000 * 60);
                };
                timeout();

                serviceConn.on("error", (err) => {
                    console.error(err);
                    closeChannel(channel.channelPort);
                });

                serviceConn.on("close", () => {
                    closeChannel(channel.channelPort);
                });

                serviceConn.on("end", () => {
                    closeChannel(channel.channelPort);
                });

                // confirm open channel
                this.send(
                    peer.info.publicKey,
                    Message.create(MessageActions.open, {
                        channelPort: msg.channelPort,
                        gatePort: msg.gatePort,
                        protocol: service.protocol,
                    }),
                );
            } else {
                const channelPort = msg.channelPort;
                if (channelPort == null) throw "Channel port is required";

                // pipe from route to service
                if (msg.actionId == MessageActions.stream) {
                    const data = msg.data;
                    if (!data) throw "Data is required";
                    const channel = peer.channels[channelPort];
                    if (channel) {
                        // console.log("Pipe to route");
                        // every time data is piped, reset channel expire time
                        channel.expire = Date.now() + channel.duration;
                        this.registerFingerprintTuple(channel);
                        channel.socket.write(data);
                    }
                } else if (msg.actionId == MessageActions.close) {
                    // close channel
                    if (channelPort <= 0) {
                        for (const channel of Object.values(peer.channels)) {
                            closeChannel(channel.channelPort);
                        }
                    } else {
                        closeChannel(channelPort);
                    }
                }
            }
        } catch (e) {
            console.error(e);
            if (msg.actionId) {
                this.send(
                    peer.info.publicKey,
                    Message.create(msg.actionId, {
                        error: e?.toString(),
                    }),
                );
            }
        }
    }
}

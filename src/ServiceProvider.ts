import Peer from "./Peer.js";
import Message, { MessageContent } from "./Message.js";
import Net from "net";
import UDPNet from "./UDPNet.js";
import { MessageActions } from "./Message.js";
import { AuthorizedPeer } from "./Peer.js";
import { RoutingTable, Service } from "./Router.js";

export default class ServiceProvider extends Peer {
    private services: Array<Service> = [];
    private isStopped = false;
    private isRefreshing = false;

    constructor(secret: string, opts?: object) {
        super(secret, false, opts);
        this.refresh().catch(console.error);
    }

    public setServices(services: Service[]): Array<Service> {
        this.services = [];
        for (const service of services) {
            this.addService(service.gatePort, service.serviceHost, service.servicePort, service.protocol);
        }
        return this.services;
    }

    public addService(gatePort: number, serviceHost: string, servicePort: number, serviceProto: string, tags?: string): Service {
        let service = this.services.find((s) => s.gatePort == gatePort && s.serviceHost == serviceHost && s.servicePort == servicePort && s.protocol == serviceProto && s.tags == tags);
        if (service) {
            console.log("Service already exists");
            return service;
        }
        console.info("Register service " + gatePort + " " + serviceHost + " " + servicePort + " " + serviceProto);
        service = {
            serviceHost,
            servicePort,
            protocol: serviceProto || "tcp",
            gatePort: gatePort,
            tags: tags,
        };
        this.services.push(service);
        return service;
    }

    public getServices(gatePort: number) {
        return this.services.filter((s) => s.gatePort == gatePort);
    }

    private createRoutingTableFragment(): RoutingTable {
        const routingTable: RoutingTable = [];
        if (Object.keys(this.services).length == 0) return routingTable;
        for (const service of this.services) {
            const routingEntry = {
                ...service,
                routes: [],
            };
            routingTable.push(routingEntry);
        }
        return routingTable;
    }

    async refresh() {
        try { 
            if (this.isStopped) return;
            await super.refresh();
            this.isRefreshing = true;

            // Advertise local routes to newly connected peer
            const rfr = this.createRoutingTableFragment();
            if (rfr) {
                await this.broadcast(Message.create(MessageActions.advRoutes, { routes: rfr }));
                console.log("Broadcast routing fragment", rfr);
            }

            this.isRefreshing = false;
        } catch (e) {
            console.error(e);
        }
    }

    protected async onAuthorizedMessage(peer: AuthorizedPeer, msg: MessageContent) {
        await super.onAuthorizedMessage(peer, msg);
        try {
            // close channel bidirectional
            const closeChannel = (channelPort: number) => {
                const channel = peer.channels[channelPort];
                if (!channel) return;
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
                const service = this.getServices(gatePort)[0];
                if (!service) throw "Service not found " + gatePort;
                const isUDP = service.protocol == "udp";
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

                const serviceConn = (isUDP ? UDPNet : Net).connect({
                    host: service.serviceHost,
                    port: service.servicePort,
                    allowHalfOpen: true,
                });

                // create channel
                const channel = {
                    socket: serviceConn,
                    duration: 1000 * 60, // 1 minute
                    expire: Date.now() + 1000 * 60,
                    gatePort: gatePort,
                    alive: true,
                    route: peer.info.publicKey,
                    channelPort: channelPort,
                    service: service,
                };
                peer.channels[channel.channelPort] = channel;

                // pipe from service to route
                serviceConn.on("data", (data) => {
                    // every time data is piped, reset channel expire time
                    channel.expire = Date.now() + channel.duration;

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
                        if (channel.expire < Date.now()) {
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

import Peer from "./Peer.js";
import Message, { MessageContent } from "./Message.js";
import UDPNet from "./UDPNet.js";
import { MessageActions } from "./Message.js";
import { AuthorizedPeer, PeerChannel } from "./Peer.js";
import { RoutingTable, Service } from "./Router.js";
import Utils from "./Utils.js";
import TCPNet from "./TCPNet.js";
import FingerprintResolver, { FingerprintResolverOptions } from "./FingerprintResolver.js";
import { IngressPolicy } from "./IngressPolicy.js";
import { Protocol, protocolToString } from "./Protocol.js";
import { Limits } from "./Limits.js";
import { writeWithBackpressure } from "./RelayBackpressure.js";
import Net from "net";

export default class ServiceProvider extends Peer {
    private services: Array<Service> = [];
    private readonly fingerprintResolver?: FingerprintResolver;
    private readonly ingressPolicy?: IngressPolicy;

    constructor(secret: string, opts?: object, fingerprintResolverOpts?: FingerprintResolverOptions, ingressPolicy?: IngressPolicy) {
        super(secret, false, opts);
        if (fingerprintResolverOpts) {
            this.fingerprintResolver = new FingerprintResolver(fingerprintResolverOpts);
            this.fingerprintResolver.start();
        }
        this.ingressPolicy = ingressPolicy;
        this.start().catch(console.error);

    }

    public override async stop() {
        await this.fingerprintResolver?.stop();
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
        this.fingerprintResolver?.registerChannel(channel);
    }

    private unregisterFingerprintTuple(channel: any) {
        this.fingerprintResolver?.unregisterChannel(channel);
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
            const closeChannel = (channelPort: number, notifyPeer = true) => {
                const channel = peer.channels[channelPort];
                if (!channel || !channel.alive) return;
                channel.alive = false;
                this.unregisterFingerprintTuple(channel);
                try {
                    if (notifyPeer && channel.route && channel.openConfirmed !== false) {
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
                const channel: PeerChannel & { fingerprint?: { [key: string]: any } } = {
                    socket: serviceConn,
                    duration,
                    expire: Date.now() + duration,
                    gatePort: gatePort,
                    alive: true,
                    route: peer.info.publicKey,
                    channelPort: channelPort,
                    service: service,
                    fingerprint: msg.fingerprint,
                    openConfirmed: false,
                };
                peer.channels[channel.channelPort] = channel;
                const pendingServiceData: Buffer[] = [];
                let openConfirmed = false;
                let streamingHandlersAttached = false;
                let timeoutStarted = false;

                const sendOpenConfirmation = async () => {
                    if (openConfirmed) return;
                    await this.sendAsync(
                        peer.info.publicKey,
                        Message.create(MessageActions.open, {
                            channelPort: msg.channelPort,
                            gatePort: msg.gatePort,
                            protocol: service.protocol,
                        }),
                    );
                    openConfirmed = true;
                    channel.openConfirmed = true;

                    while (pendingServiceData.length > 0) {
                        handleServiceData(pendingServiceData.shift()!);
                    }
                };

                const handleServiceData = (data: Buffer) => {
                    const run = async () => {
                        if (!channel.alive) return;
                        const pausable = serviceConn as any as { pause?: () => void; resume?: () => void };
                        const canPause = typeof pausable.pause === "function" && typeof pausable.resume === "function";
                        if (canPause) {
                            pausable.pause?.();
                        }
                        try {
                            // every time data is piped, reset channel expire time
                            channel.expire = Date.now() + channel.duration;
                            this.registerFingerprintTuple(channel);

                            await this.sendAsync(
                                channel.route,
                                Message.create(MessageActions.stream, {
                                    channelPort: msg.channelPort,
                                    data: data,
                                }),
                            );
                        } finally {
                            if (canPause && channel.alive && !(serviceConn as any).destroyed) {
                                pausable.resume?.();
                            }
                        }
                    };

                    channel.pipeChain = (channel.pipeChain ?? Promise.resolve()).then(run, run).catch((err: any) => {
                        console.error(err);
                        closeChannel(channel.channelPort);
                    });
                };

                const propagateEnd = (notifyPeer = true) => {
                    if (!channel.alive || channel.localEnded) return;
                    channel.localEnded = true;
                    try {
                        if (notifyPeer && channel.route) {
                            this.send(
                                channel.route,
                                Message.create(MessageActions.end, {
                                    channelPort: channel.channelPort,
                                }),
                            );
                        }
                    } catch (e) {
                        console.error(e);
                    }
                };

                const applyRemoteEnd = () => {
                    if (!channel.alive || channel.remoteEnded) return;
                    channel.remoteEnded = true;
                    try {
                        channel.socket.end();
                    } catch (e) {
                        console.error(e);
                    }
                };

                const startTimeout = () => {
                    if (timeoutStarted) return;
                    timeoutStarted = true;
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
                        setTimeout(timeout, Limits.CHANNEL_TIMEOUT_POLL_MS);
                    };
                    timeout();
                };

                const attachStreamingHandlers = () => {
                    if (streamingHandlersAttached) return;
                    streamingHandlersAttached = true;
                    serviceConn.on("data", (data) => {
                        if (!openConfirmed) {
                            pendingServiceData.push(Buffer.from(data));
                            return;
                        }
                        handleServiceData(data);
                    });

                    serviceConn.on("close", () => {
                        closeChannel(channel.channelPort);
                    });

                    serviceConn.on("end", () => {
                        propagateEnd(true);
                    });

                    startTimeout();
                };

                serviceConn.on("error", (err) => {
                    console.error(err);
                    closeChannel(channel.channelPort);
                });

                if (isUDP) {
                    this.registerFingerprintTuple(channel);
                    attachStreamingHandlers();
                    await sendOpenConfirmation();
                } else {
                    await new Promise<void>((resolve, reject) => {
                        const tcpSocket = serviceConn as Net.Socket;
                        if (!tcpSocket.connecting && !tcpSocket.destroyed) {
                            resolve();
                            return;
                        }

                        const onConnect = () => {
                            cleanup();
                            resolve();
                        };
                        const onError = (err: Error) => {
                            cleanup();
                            reject(err);
                        };
                        const onClose = () => {
                            cleanup();
                            reject(new Error("Service connection closed before connect"));
                        };
                        const onEnd = () => {
                            cleanup();
                            reject(new Error("Service connection ended before connect"));
                        };
                        const cleanup = () => {
                            tcpSocket.off("connect", onConnect);
                            tcpSocket.off("error", onError);
                            tcpSocket.off("close", onClose);
                            tcpSocket.off("end", onEnd);
                        };

                        tcpSocket.on("connect", onConnect);
                        tcpSocket.on("error", onError);
                        tcpSocket.on("close", onClose);
                        tcpSocket.on("end", onEnd);
                    });

                    this.registerFingerprintTuple(channel);
                    attachStreamingHandlers();
                    await sendOpenConfirmation();
                }
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

                        const queuedBytes = data.length;
                        channel.queuedWriteBytes = (channel.queuedWriteBytes ?? 0) + queuedBytes;
                        if ((channel.queuedWriteBytes ?? 0) > Limits.MAX_BUFFER_PER_CHANNEL) {
                            console.warn("Buffered route->service data exceeded limit for channel " + channel.channelPort + ", closing");
                            closeChannel(channel.channelPort);
                            return;
                        }

                        const writeChunk = async () => {
                            try {
                                if (!channel.alive || channel.socket.destroyed) return;
                                const useBackpressure = channel.service.protocol == Protocol.tcp;
                                await writeWithBackpressure(channel.socket as any, undefined, data, useBackpressure);
                            } finally {
                                channel.queuedWriteBytes = Math.max(0, (channel.queuedWriteBytes ?? 0) - queuedBytes);
                            }
                        };

                        channel.pipeChain = (channel.pipeChain ?? Promise.resolve()).then(writeChunk, writeChunk).catch((e) => {
                            console.error(e);
                            closeChannel(channel.channelPort);
                        });
                    }
                } else if (msg.actionId == MessageActions.end) {
                    const channel = peer.channels[channelPort];
                    if (channel) {
                        if (!channel.remoteEnded) {
                            channel.remoteEnded = true;
                            channel.socket.end();
                        }
                    }
                } else if (msg.actionId == MessageActions.close) {
                    // close channel
                    if (channelPort <= 0) {
                        for (const channel of Object.values(peer.channels)) {
                            closeChannel(channel.channelPort, false);
                        }
                    } else {
                        closeChannel(channelPort, false);
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

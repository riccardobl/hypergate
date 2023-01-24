import Peer from "./Peer.js";
import Message from "./Message.js";
import HyperDHT from '@hyperswarm/dht';
import Hyperswarm from 'hyperswarm';
import Net from 'net';
import Crypto from 'crypto';
import Sodium from 'sodium-universal';
import b4a from 'b4a';
import UDPNet from './UDPNet.js';
import HttpApi from "./HttpApi.js";
import Utils from "./Utils.js";
export default class ServiceProvider extends Peer {
    constructor(secret, opts) {
        super(secret, false, opts);
        this.services = {};
        this.refresh();

    }

    startHttpApi(listenOn) {

        super.startHttpApi(listenOn);
        this.httpApi.register("/services", (url, body) => {
            return this.services;
        });
        this.httpApi.register("/routingTable", (url, body) => {
            return this._createRoutingTableFragment();
        });
    }
    addService(gatePort, serviceHost, servicePort) {
        console.info("Register service " + gatePort + " " + serviceHost + " " + servicePort);
        this.services[gatePort] = {
            serviceHost,
            servicePort,
            protocol: servicePort || "tcp"
        };
    }


    _getService(gatePort) {
        if (this.gateway) {
            throw "Cannot get service of a gateway";
        }
        return this.services[gatePort];
    }


    _createRoutingTableFragment() {
        if (Object.keys(this.services).length == 0) return undefined;
        const routingTable = {};
        for (const gatePort in this.services) {
            // const protocol=this.services[gatePort].protocol;
            routingTable[gatePort] = [{
                route: "",
                // protocol:protocol
            }];
        }
        return routingTable;
    }

    async refresh() {
        if (this.stopped) return;
        super.refresh();
        this.refreshing = true;

        // Advertise local routes to newly connected peer
        const rfr = this._createRoutingTableFragment();
        if (rfr) {
            await this.broadcast(Message.create(Message.actions().advRoutes, { routes: rfr }));
            console.log("Broadcast routing fragment", rfr)
        }

        this.refreshing = false;
    }


    async onAuthorizedMessage(peer, msg) {
        await super.onAuthorizedMessage(peer, msg);
        try {

            if (!peer.channels) {
                peer.channels = {};
            }

            // close channel bidirectional
            const closeChannel = (channelPort) => {
                const channel = peer.channels[channelPort];
                if (!channel) return;
                try {
                    if (channel.route) {
                        this.send(channel.route, Message.create(Message.actions().close, {
                            channelPort: channelPort
                        }));
                    }
                } catch (e) {
                    console.error(e);
                }

                if (channel.socket) {
                    channel.socket.end();
                }
                channel.alive = false;

                delete peer.channels[channelPort];
            }

            // open new channel
            if (msg.actionId == Message.actions().open) {


                // open connection to service
                const gatePort = msg.gatePort;
                const service = this._getService(gatePort);
                if (!service) throw "Service not found " + gatePort;
                const isUDP = service.protocol == "udp";

                // Service not found, tell peer there was an error
                if (!service) {
                    console.error("service not found");
                    this.send(peer.info.publicKey,
                        Message.create(Message.actions().open,
                            { channelPort: msg.channelPort, error: "Service " + gatePort + " not found" }));
                    // closeChannel(msg.channelPort);
                    return;
                }

                // connect to service
                console.log("Connect to", service.serviceHost, service.servicePort, isUDP ? "UDP" : "TCP", "on channel", msg.channelPort);

                const serviceConn = (isUDP ? UDPNet : Net).connect({
                    host: service.serviceHost,
                    port: service.servicePort,
                    allowHalfOpen: true
                });

                // create channel
                const channel = {
                    socket: serviceConn,
                    duration: 1000 * 60, // 1 minute
                    expire: Date.now() + 1000 * 60,
                    gatePort: gatePort,
                    alive: true,
                    route: peer.info.publicKey,
                    channelPort: msg.channelPort,
                    service: service
                };
                peer.channels[channel.channelPort] = channel;

                // pipe from service to route
                serviceConn.on("data", data => {
                    // every time data is piped, reset channel expire time
                    channel.expire = Date.now() + channel.duration;

                    this.send(channel.route, Message.create(Message.actions().stream, {
                        channelPort: msg.channelPort,
                        data: data
                    }));
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
                this.send(peer.info.publicKey, Message.create(Message.actions().open, {
                    channelPort: msg.channelPort,
                    gatePort: msg.gatePort
                }));

            } else {
                // pipe from route to service
                if (msg.actionId == Message.actions().stream) {
                    const channel = peer.channels[msg.channelPort];
                    if (channel) {
                        // console.log("Pipe to route");
                        // every time data is piped, reset channel expire time
                        channel.expire = Date.now() + channel.duration;
                        channel.socket.write(msg.data);

                    }
                } else if (msg.actionId == Message.actions().close) {  // close channel         
                    if (msg.channelPort <= 0) {
                        for (const channelPort in peer.channels) {
                            closeChannel(channelPort);
                        }
                    } else {
                        closeChannel(msg.channelPort);
                    }

                }
            }
        } catch (e) {
            console.error(e);
            this.send(peer.info.publicKey, Message.create(msg.actionId, {
                error: e.toString()
            }));
        }
    }



}
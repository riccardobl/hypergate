import Message, { MessageActions, MessageContent, MessageDecoder } from "./Message.js";
// @ts-ignore
import HyperDHT from "@hyperswarm/dht";
// @ts-ignore
import Hyperswarm from "hyperswarm";
// @ts-ignore
import Sodium from "sodium-universal";
// @ts-ignore
import b4a from "b4a";
import UDPNet from "./UDPNet.js";
import Net from "net";

export type PeerChannel = {
    socket: UDPNet | Net.Socket;
    duration: number;
    expire: number;
    gatePort: number;
    alive: boolean;
    route: Buffer;
    channelPort: number;
    service: any;
};

export type AuthorizedPeer = {
    c: any;
    info: any;
    channels: { [channelPort: number]: PeerChannel };
};

export default abstract class Peer {
    private readonly isGate: boolean;
    private readonly routerKeys: any;
    private readonly dht: any;
    private readonly swarm: any;
    private readonly discovery: any;
    private readonly messageHandlers: ((peer: AuthorizedPeer, msg: MessageContent) => boolean)[] = [];
    private readonly _authorizedPeers: AuthorizedPeer[] = [];
    private refreshing: boolean = false;
    private stopped: boolean = false;

    constructor(secret: string, isGate: boolean, opts?: object) {
        this.isGate = isGate;

        this.routerKeys = HyperDHT.keyPair(Buffer.from(secret, "hex"));

        this.dht = new HyperDHT(opts);
        this.dht.on("error", (err: any) => console.log("DHT error", err));
        this.swarm = new Hyperswarm(this.dht);
        this.swarm.on("error", (err: any) => console.log("Swarm error", err));
        this.swarm.on("connection", (c: any, peer: any) => {
            console.log("Swarm connection", b4a.toString(peer.publicKey, "hex"));
            this.onConnection(c, peer).catch(console.error);
        });

        this.discovery = this.swarm.join(this.routerKeys.publicKey, {
            client: true,
            server: true,
        });
        console.info("Joined router:", b4a.toString(this.routerKeys.publicKey, "hex"));
    }

    private addAuthorizedPeer(connection: any, peerInfo: any): AuthorizedPeer {
        const newPeer = {
            c: connection,
            info: peerInfo,
            channels: {},
        };
        this._authorizedPeers.push(newPeer);
        return newPeer;
    }

    private removeAuthorizedPeerByKey(peerKey: string) {
        for (let i = 0; i < this._authorizedPeers.length; i++) {
            const peer = this._authorizedPeers[i];
            if (peer.info.publicKey.equals(peerKey)) {
                this._authorizedPeers.splice(i, 1);
                return;
            }
        }
    }

    private getAuthorizedPeerByKey(peerKey: Buffer): AuthorizedPeer | undefined {
        for (const peer of this._authorizedPeers) {
            if (peer.info.publicKey.equals(peerKey)) return peer;
        }
        return undefined;
    }

    private createAuthBlob(routerSecret: Buffer, sourcePublic: Buffer, targetPublic: Buffer, routerPublic: Buffer, timestamp: number): Buffer {
        if (!routerSecret || !sourcePublic || !targetPublic || !routerPublic || !timestamp) throw new Error("Invalid authkey");
        const timestampBuffer = Buffer.alloc(1 + 8);
        timestampBuffer.writeUint8(21, 0);
        timestampBuffer.writeBigInt64BE(BigInt(timestamp), 1);

        const createKey = (source: Buffer): Buffer => {
            const keyLength = Sodium.crypto_pwhash_BYTES_MAX < Sodium.crypto_generichash_KEYBYTES_MAX ? Sodium.crypto_pwhash_BYTES_MAX : Sodium.crypto_generichash_KEYBYTES_MAX;
            if (keyLength < Sodium.crypto_pwhash_BYTES_MIN) throw new Error("Error. Key too short");

            const salt = b4a.alloc(Sodium.crypto_pwhash_SALTBYTES);
            Sodium.crypto_generichash(salt, source);
            // console.log("Create salt",b4a.toString(salt,"hex"));

            const secretKey = b4a.alloc(keyLength);
            Sodium.crypto_pwhash(secretKey, source, salt, Sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE, Sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE, Sodium.crypto_pwhash_ALG_DEFAULT);
            // console.log("Create key",b4a.toString(secretKey,"hex"));

            return secretKey;
        };

        const hash = (msg: Buffer, key: Buffer) => {
            const enc = b4a.alloc(Sodium.crypto_generichash_BYTES_MAX);
            Sodium.crypto_generichash(enc, msg, key);
            // console.log("Create hash",b4a.toString(enc,"hex"),"Using key",b4a.toString(key,"hex"));
            return enc;
        };

        const authMsg = Buffer.concat([sourcePublic, targetPublic, routerPublic, timestampBuffer]);

        const key = createKey(routerSecret);
        if (!key) throw new Error("Error");

        const encAuthMsg = hash(authMsg, key);
        if (!encAuthMsg) throw new Error("Error");

        const out = Buffer.concat([timestampBuffer, encAuthMsg]);
        if (out.length < 32) throw new Error("Invalid authkey");

        return out;
    }

    private getAuthKey(targetPublicKey: Buffer): Buffer {
        const sourcePublicKey = this.swarm.keyPair.publicKey;
        return this.createAuthBlob(this.routerKeys.secretKey, sourcePublicKey, targetPublicKey, this.routerKeys.publicKey, Date.now());
    }

    private verifyAuthKey(sourcePublicKey: Buffer, authKey: Buffer) {
        const timestampBuffer = authKey.slice(0, 8 + 1);
        const timestamp = timestampBuffer.readBigInt64BE(1);
        const now = BigInt(Date.now());
        if (now - timestamp > 1000 * 60 * 15) {
            console.error("AuthKey expired. Replay attack or clock mismatch?");
            return false;
        }
        const targetPublicKey = this.swarm.keyPair.publicKey;
        const validAuthMessage = this.createAuthBlob(this.routerKeys.secretKey, sourcePublicKey, targetPublicKey, this.routerKeys.publicKey, Number(timestamp));
        return validAuthMessage.equals(authKey);
    }

    private async onConnection(c: any, peer: any) {
        const closeConn = () => {
            const aPeer = this.getAuthorizedPeerByKey(peer.publicKey);
            try {
                if (aPeer) {
                    const msg = Message.create(MessageActions.close, { channelPort: 0 });
                    this.onAuthorizedMessage(aPeer, Message.parse(msg)).catch(console.error);
                }
            } catch (err) {
                console.error("Error on close", err);
            }
            this.removeAuthorizedPeerByKey(peer.publicKey);
        };

        c.on("error", (err: any) => {
            console.log("Connection error", err);
            closeConn();
        });

        c.on("close", () => {
            closeConn();
        });

        const decoder = new MessageDecoder();
        c.on("data", (data: Buffer) => {
            let messages: Buffer[] = [];
            try {
                messages = decoder.feed(data);
            } catch (err) {
                console.error("Error decoding message", err);
                closeConn();
                try {
                    c.destroy();
                } catch (error) {
                    console.error("Error destroying connection", error);
                }
                return;
            }

            for (const message of messages) {
                try {
                    const msg = Message.parse(message);
                    if (msg.actionId == MessageActions.hello) {
                        console.log("Receiving handshake");
                        // Only gate->peer or peer->gate connections are allowed
                        if (!this.isGate && !msg.isGate) {
                            peer.ban(true);
                            c.destroy();
                            console.log("Ban because", b4a.toString(peer.publicKey, "hex"), "is not a gate and tried to connect to a peer", this.isGate, msg.isGate);
                            return;
                        }

                        if (!msg.auth || !this.verifyAuthKey(peer.publicKey, msg.auth)) {
                            console.error("Authorization failed for peer", b4a.toString(peer.publicKey, "hex"), "Ban!");
                            console.log("Authorization failed using authkey ", b4a.toString(msg.auth, "hex"));
                            peer.ban(true);
                            c.destroy();
                            return;
                        }

                        if (this.getAuthorizedPeerByKey(peer.publicKey)) {
                            console.error("Already connected??", peer.publicKey);
                            return;
                        }

                        this.addAuthorizedPeer(c, peer);
                        console.info("Authorized", b4a.toString(peer.publicKey, "hex"));
                    } else {
                        const aPeer = this.getAuthorizedPeerByKey(peer.publicKey);
                        if (!aPeer) {
                            console.error("Unauthorized message from", b4a.toString(peer.publicKey, "hex"));
                            return;
                        } else {
                            this.onAuthorizedMessage(aPeer, msg).catch(console.error);
                        }
                    }
                } catch (err) {
                    console.error("Error on message", err);
                }
            }
        });

        const authKey = this.getAuthKey(peer.publicKey);
        // console.log("Attempt authorization with authKey",b4a.toString(authKey,"hex"));
        c.write(
            Message.frame(
                Message.create(MessageActions.hello, {
                    auth: authKey,
                    isGate: this.isGate,
                }),
            ),
        );
    }

    public broadcast(msg: Buffer) {
        if (!this._authorizedPeers) return;
        for (const p of this._authorizedPeers) {
            this.send(p.info.publicKey, msg);
        }
    }

    public send(peerKey: Buffer, msg: Buffer) {
        console.log("Sending message to", b4a.toString(peerKey, "hex"));
        const peer = this.getAuthorizedPeerByKey(peerKey);

        if (peer) peer.c.write(Message.frame(msg));
        else console.error("Peer not found");
    }

    public addMessageHandler(handler: (peer: AuthorizedPeer, msg: MessageContent) => boolean) {
        this.messageHandlers.push(handler);
    }

    protected async onAuthorizedMessage(peer: AuthorizedPeer, msg: MessageContent) {
        console.log("Receiving message", msg);
        for (let i = 0; i < this.messageHandlers.length; i++) {
            const handler = this.messageHandlers[i];
            try {
                if (handler(peer, msg)) {
                    // remove
                    this.messageHandlers.splice(i, 1);
                }
            } catch (err) {
                console.error("Error on message handler", err);
            }
        }
    }

    protected abstract onRefresh(): Promise<void>;

    private async refresh() {
        try {
            if (this.stopped) return;
            this.refreshing = true;
            console.log("Refreshing peers");
            await this.discovery.refresh({
                server: true,
                client: true,
            });
            await this.onRefresh();
        } catch (err) {
            console.error("Error on refresh", err);
        } finally {
            this.refreshing = false;
        }
        setTimeout(() => this.refresh(), 5000);
    }

    public async stop() {
        this.stopped = true;
        while (this.refreshing) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        try {
            this.swarm.destroy();
        } catch (err) {
            console.error("Error on stop", err);
        }

        try {
            this.dht.destroy();
        } catch (err) {
            console.error("Error on stop", err);
        }
    }

    protected async start() {
        this.refresh().catch(console.error);
    }
}

// @ts-ignore
import Sodium from "sodium-universal";
// @ts-ignore
import HyperDHT from "@hyperswarm/dht";
// @ts-ignore
import b4a from "b4a";

export default class Utils {
    static getConnDuration(isUDP: boolean): number {
        // How long a connection will stay alive without data exchange
        let duration = 1000 * 60;
        if (!isUDP) {
            // 21 years for tcp (it's a long time...)
            // actually we want this closed by the underlying tcp stack, that's why we defacto never expire
            duration = 1000 * 60 * 60 * 24 * 360 * 21;
        } else {
            // 1 hour for udp
            duration = 1000 * 60 * 60;
        }
        return duration;
    }

    static newSecret() {
        const b = Buffer.alloc(Sodium.randombytes_SEEDBYTES);
        Sodium.randombytes_buf(b);
        return b.toString("hex");
    }

    static getRouterKeys(secret: string) {
        return HyperDHT.keyPair(Buffer.from(secret, "hex"));
    }

    static getRouterName(secret: string) {
        const keys = Utils.getRouterKeys(secret);
        return b4a.toString(keys.publicKey, "hex");
    }

    static async scanRouter(routerName: string) {
        console.info("Scanning", routerName);
        const node = new HyperDHT();
        const topic = b4a.from(routerName, "hex");
        await node.announce(topic);

        for await (const e of node.lookup(topic)) {
            for (const p of e.peers) {
                const publicKey = p.publicKey;
                const socket = node.connect(publicKey);
                socket.on("open", function () {
                    if (socket.rawStream) {
                        console.info(socket.rawStream.remoteHost);
                    }
                });
                socket.on("connect", function () {
                    if (socket.rawStream) {
                        console.info(socket.rawStream.remoteHost);
                    }
                });
                socket.on("error", () => {
                    if (socket.rawStream) {
                        console.info(socket.rawStream.remoteHost);
                    }
                });
            }
        }
    }
}

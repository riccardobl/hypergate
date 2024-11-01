// @ts-ignore
import Sodium from "sodium-universal";
// @ts-ignore
import HyperDHT from "@hyperswarm/dht";
// @ts-ignore
import b4a from "b4a";

export default class Utils {
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
                socket.on("error", (err: Error) => {
                    if (socket.rawStream) {
                        console.info(socket.rawStream.remoteHost);
                    }
                });
            }
        }
    }
}

import Http from "http";
import { Protocol, protocolToString } from "./Protocol.js";

export type FingerprintRecord = {
    fingerprint: { [key: string]: any };
    channelPort: number;
    gatePort: number;
    protocol: string;
    createdAt: number;
    expiresAt: number;
};

type ResolverChannelLike = {
    socket?: any;
    service?: { protocol?: string };
    fingerprint?: { [key: string]: any };
    duration?: number;
    channelPort?: number;
    gatePort?: number;
    resolverTupleKey?: string;
};

export type FingerprintResolverOptions = {
    host?: string;
    port?: number;
    basicAuth?: string | null;
};

export default class FingerprintResolver {
    private readonly fingerprintByTuple: Map<string, FingerprintRecord> = new Map();
    private readonly host: string;
    private readonly port: number;
    private readonly basicAuth?: { username: string; password: string };
    private server?: Http.Server;
    private sweepTimer?: NodeJS.Timeout;

    constructor(opts: FingerprintResolverOptions = {}) {
        this.host = opts.host || "127.0.0.1";
        this.port = opts.port ?? 8080;
        this.basicAuth = this.parseBasicAuth(opts.basicAuth);
    }

    public start() {
        if (this.server) return;

        this.sweepTimer = setInterval(() => this.cleanupExpiredFingerprints(), 15_000);

        this.server = Http.createServer((req, res) => {
            try {
                const url = new URL(req.url || "/", "http://localhost");
                if (url.pathname === "/health") {
                    res.writeHead(200, { "content-type": "application/json" });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }

                if (!this.authorize(req)) {
                    res.writeHead(401, {
                        "content-type": "application/json",
                        "www-authenticate": 'Basic realm="hypergate-fingerprint-resolver"',
                    });
                    res.end(JSON.stringify({ error: "unauthorized" }));
                    return;
                }

                if (url.pathname !== "/resolve") {
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "not_found" }));
                    return;
                }

                const protocol = (url.searchParams.get("proto") || url.searchParams.get("protocol") || "tcp").toLowerCase();
                const remoteAddress = url.searchParams.get("remote_addr") || url.searchParams.get("remoteAddr") || "";
                const remotePort = Number(url.searchParams.get("remote_port") || url.searchParams.get("remotePort") || 0);
                const localAddress =
                    url.searchParams.get("server_addr") || url.searchParams.get("local_addr") || url.searchParams.get("localAddr") || "";
                const localPort = Number(url.searchParams.get("server_port") || url.searchParams.get("local_port") || url.searchParams.get("localPort") || 0);

                if (!remoteAddress || !remotePort || !localAddress || !localPort) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "missing_tuple_params" }));
                    return;
                }

                const key = this.getTupleKey(protocol, remoteAddress, remotePort, localAddress, localPort);
                const record = this.fingerprintByTuple.get(key);
                if (!record) {
                    res.writeHead(404, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "not_found", key }));
                    return;
                }

                res.writeHead(200, { "content-type": "application/json" });
                res.end(
                    JSON.stringify({
                        key,
                        protocol: record.protocol,
                        gatePort: record.gatePort,
                        channelPort: record.channelPort,
                        fingerprint: record.fingerprint,
                        createdAt: record.createdAt,
                        expiresAt: record.expiresAt,
                    }),
                );
            } catch (e) {
                res.writeHead(500, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "resolver_error", detail: e?.toString() }));
            }
        });

        this.server.listen(this.port, this.host, () => {
            const addr = this.server?.address();
            if (addr && typeof addr !== "string") {
                console.info("Fingerprint resolver listening on http://" + addr.address + ":" + addr.port);
            }
        });
        this.server.on("error", (err) => {
            console.error("Fingerprint resolver error", err);
        });
    }

    public async stop() {
        if (this.sweepTimer) {
            clearInterval(this.sweepTimer);
            this.sweepTimer = undefined;
        }
        if (this.server) {
            await new Promise<void>((resolve) => {
                this.server?.close(() => resolve());
            });
            this.server = undefined;
        }
    }

    public registerChannel(channel: ResolverChannelLike) {
        const fingerprint = channel?.fingerprint;
        const socket = channel?.socket;
        if (!fingerprint || !socket) return;

        const protocol =
            (typeof channel?.service?.protocol === "number"
                ? protocolToString(channel.service.protocol as Protocol)
                : String(channel?.service?.protocol || "tcp").toLowerCase()) || "tcp";
        const localAddress = socket.localAddress;
        const localPort = socket.localPort;
        const remoteAddress = socket.remoteAddress;
        const remotePort = socket.remotePort;
        if (!localAddress || !remoteAddress || !localPort || !remotePort) return;

        const tupleKey = this.getTupleKey(protocol, localAddress, localPort, remoteAddress, remotePort);
        const ttlMs = Math.max((channel.duration || 60_000) + 60_000, 120_000);
        const now = Date.now();
        const record: FingerprintRecord = {
            fingerprint,
            channelPort: channel.channelPort || 0,
            gatePort: channel.gatePort || 0,
            protocol,
            createdAt: now,
            expiresAt: now + ttlMs,
        };
        channel.resolverTupleKey = tupleKey;
        this.fingerprintByTuple.set(tupleKey, record);
    }

    public unregisterChannel(channel: ResolverChannelLike) {
        const key = channel?.resolverTupleKey;
        if (!key) return;
        this.fingerprintByTuple.delete(key);
        delete channel.resolverTupleKey;
    }

    private authorize(req: Http.IncomingMessage): boolean {
        if (!this.basicAuth) return true;
        const auth = req.headers.authorization;
        if (!auth || !auth.startsWith("Basic ")) return false;
        try {
            const decoded = Buffer.from(auth.slice("Basic ".length), "base64").toString("utf8");
            const sep = decoded.indexOf(":");
            if (sep < 0) return false;
            const username = decoded.slice(0, sep);
            const password = decoded.slice(sep + 1);
            return username === this.basicAuth.username && password === this.basicAuth.password;
        } catch {
            return false;
        }
    }

    private parseBasicAuth(value?: string | null): { username: string; password: string } | undefined {
        if (!value || !value.includes(":")) return undefined;
        const i = value.indexOf(":");
        return {
            username: value.slice(0, i),
            password: value.slice(i + 1),
        };
    }

    private normalizeIp(ip?: string): string {
        return (ip || "").replace(/^::ffff:/, "");
    }

    private getTupleKey(protocol: string, remoteAddress: string, remotePort: number, localAddress: string, localPort: number) {
        return [
            protocol.toLowerCase(),
            this.normalizeIp(remoteAddress),
            String(remotePort || 0),
            this.normalizeIp(localAddress),
            String(localPort || 0),
        ].join("|");
    }

    private cleanupExpiredFingerprints() {
        const now = Date.now();
        for (const [key, value] of this.fingerprintByTuple.entries()) {
            if (value.expiresAt <= now) {
                this.fingerprintByTuple.delete(key);
            }
        }
    }
}

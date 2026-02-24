import { createDecipheriv, createHash, pbkdf2Sync } from "crypto";
import HttpServer from "./HttpServer.js";
import { IngressPolicy, IngressPolicyRule } from "./IngressPolicy.js";

export type LimitRemoverServiceOptions = {
    secret: string;
    host?: string;
    port?: number;
    onListen?: (url: string) => void;
};

export default class LimitRemoverService extends HttpServer {
    private readonly secret: string;
    private readonly ingressOverrides: IngressPolicy = { ips: {} };
    private readonly replayCache: Map<string, number> = new Map();

    constructor(opts: LimitRemoverServiceOptions) {
        const host = opts.host || "127.0.0.1";
        const port = opts.port ?? 8091;
        super(host, port, (addr) => opts.onListen?.(`http://${addr.address}:${addr.port}`));
        this.secret = opts.secret;

        this.addListener("/unlimited", ({ req, res, url, body }) => {
            try {
                this.cleanupReplayCache();

                const payload = url.searchParams.get("payload") || this.extractPayloadFromBody(body);
                if (!payload) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "missing_payload" }));
                    return;
                }

                const callerIp = this.normalizeIp(req.socket?.remoteAddress || "");
                if (!callerIp) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "missing_caller_ip" }));
                    return;
                }

                const decrypted = this.decryptPayload(payload);
                const ts = Number((decrypted as any).timestamp ?? (decrypted as any).ts);
                const requestedIp = this.normalizeIp(String((decrypted as any).ip || ""));
                if (!requestedIp || !Number.isFinite(ts)) {
                    res.writeHead(400, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "invalid_payload" }));
                    return;
                }
                if (requestedIp !== callerIp) {
                    res.writeHead(403, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "ip_mismatch", callerIp }));
                    return;
                }

                const now = Date.now();
                if (Math.abs(now - ts) > 5 * 60_000) {
                    res.writeHead(403, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "timestamp_out_of_window" }));
                    return;
                }

                const replayKey = createHash("sha256").update(payload).digest("hex");
                if ((this.replayCache.get(replayKey) || 0) > now) {
                    res.writeHead(409, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "replay_detected" }));
                    return;
                }
                this.replayCache.set(replayKey, now + 5 * 60_000);

                const expireAt = now + 30 * 60_000;
                if (!this.ingressOverrides.ips) this.ingressOverrides.ips = {};
                this.ingressOverrides.ips[requestedIp] = {
                    allow: true,
                    bandwidthLimit: null,
                    labels: ["gateway-unlimited"],
                    desc: "gateway-unlimited",
                    expireAt,
                } satisfies IngressPolicyRule;

                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, ip: requestedIp, expireAt }));
            } catch (e) {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_token", detail: e?.toString?.() ?? String(e) }));
            }
        });
    }

    public getIngressOverrides(): IngressPolicy {
        return this.ingressOverrides;
    }

    private extractPayloadFromBody(body: Buffer): string | undefined {
        if (!body || body.length === 0) return undefined;
        const raw = body.toString("utf8").trim();
        if (!raw) return undefined;
        if (raw.startsWith("{")) {
            try {
                const parsed = JSON.parse(raw);
                if (typeof parsed.payload === "string") return parsed.payload;
            } catch {
                return undefined;
            }
        }
        if (raw.includes("=") && !raw.includes(".")) {
            const params = new URLSearchParams(raw);
            const payload = params.get("payload");
            if (payload) return payload;
        }
        return raw;
    }

    private decryptPayload(token: string): any {
        const blob = this.base64urlDecode(token.trim());
        if (blob.length < 16) throw new Error("invalid payload");
        const magic = blob.subarray(0, 8).toString("utf8");
        if (magic !== "Salted__") throw new Error("invalid salt header");
        const salt = blob.subarray(8, 16);
        const ciphertext = blob.subarray(16);
        if (ciphertext.length === 0) throw new Error("empty ciphertext");

        // Matches the README one-liner: openssl enc -aes-256-cbc -pbkdf2 -iter 10000 -md sha256
        const keyIv = pbkdf2Sync(this.secret, salt, 10_000, 48, "sha256");
        const key = keyIv.subarray(0, 32);
        const iv = keyIv.subarray(32, 48);

        const decipher = createDecipheriv("aes-256-cbc", key, iv);
        const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
        return JSON.parse(plaintext);
    }

    private base64urlDecode(v: string): Buffer {
        const pad = (4 - (v.length % 4 || 4)) % 4;
        const s = v.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
        return Buffer.from(s, "base64");
    }

    private normalizeIp(ip: string): string {
        if (!ip) return "";
        const noZone = ip.split("%")[0] || ip;
        return noZone.replace(/^::ffff:/, "");
    }

    private cleanupReplayCache() {
        const now = Date.now();
        for (const [k, exp] of this.replayCache.entries()) {
            if (exp <= now) this.replayCache.delete(k);
        }
    }
}

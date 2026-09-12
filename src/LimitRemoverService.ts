import { createCipheriv, createDecipheriv, createHash, createHmac, pbkdf2Sync, randomBytes, timingSafeEqual } from "crypto";
import HttpServer from "./HttpServer.js";
import { IngressPolicy, IngressPolicyRule } from "./IngressPolicy.js";

export type LimitRemoverServiceOptions = {
    secret: string;
    host?: string;
    port?: number;
    onListen?: (url: string) => void;
};

const TOKEN_VERSION = "v1";

export function createUnlimitedToken(secret: string, payload: object): string {
    const salt = randomBytes(8);
    const keyIv = pbkdf2Sync(secret, salt, 10_000, 48, "sha256");
    const cipher = createCipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const encrypted = Buffer.concat([Buffer.from("Salted__"), salt, ciphertext]).toString("base64url");
    const signed = `${TOKEN_VERSION}.${encrypted}`;
    const tag = createHmac("sha256", secret).update(signed).digest("base64url");
    return `${signed}.${tag}`;
}

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

                const { value: decrypted, replayKey } = this.decryptPayload(payload);
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

                if ((this.replayCache.get(replayKey) || 0) > now) {
                    res.writeHead(409, { "content-type": "application/json" });
                    res.end(JSON.stringify({ error: "replay_detected" }));
                    return;
                }
                this.replayCache.set(replayKey, now + 5 * 60_000);

                const expireAt = now + 30 * 60_000;
                if (!this.ingressOverrides.ips) this.ingressOverrides.ips = {};
                this.ingressOverrides.ips[requestedIp] = {
                    bandwidthLimit: null,
                    labels: ["gateway-unlimited"],
                    desc: "gateway-unlimited",
                    expireAt,
                } satisfies IngressPolicyRule;

                res.writeHead(200, { "content-type": "application/json" });
                res.end(JSON.stringify({ ok: true, ip: requestedIp, expireAt }));
            } catch {
                res.writeHead(403, { "content-type": "application/json" });
                res.end(JSON.stringify({ error: "invalid_token" }));
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
        if (raw.includes("=")) {
            const params = new URLSearchParams(raw);
            const payload = params.get("payload");
            if (payload) return payload;
        }
        return raw;
    }

    private decryptPayload(token: string): { value: any; replayKey: string } {
        if (token !== token.trim()) throw new Error("invalid token format");
        const [version, encrypted, suppliedTag, ...rest] = token.split(".");
        if (version !== TOKEN_VERSION || !encrypted || !suppliedTag || rest.length > 0) throw new Error("invalid token format");

        const signed = `${version}.${encrypted}`;
        const expectedTag = createHmac("sha256", this.secret).update(signed).digest();
        const decodedTag = this.base64urlDecode(suppliedTag);
        if (decodedTag.length !== expectedTag.length || !timingSafeEqual(decodedTag, expectedTag)) throw new Error("invalid token authentication");

        const blob = this.base64urlDecode(encrypted);
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
        return {
            value: JSON.parse(plaintext),
            replayKey: createHash("sha256").update(signed).digest("hex"),
        };
    }

    private base64urlDecode(v: string): Buffer {
        if (!/^[A-Za-z0-9_-]+$/.test(v)) throw new Error("invalid base64url encoding");
        const pad = (4 - (v.length % 4 || 4)) % 4;
        const s = v.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat(pad);
        const decoded = Buffer.from(s, "base64");
        if (decoded.toString("base64url") !== v) throw new Error("non-canonical base64url encoding");
        return decoded;
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

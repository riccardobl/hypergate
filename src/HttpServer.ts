import Http from "http";
import type { AddressInfo } from "net";

export type HttpServerListenerContext = {
    req: Http.IncomingMessage;
    res: Http.ServerResponse;
    url: URL;
    method: "GET" | "POST";
    body: Buffer;
};

type Listener = (ctx: HttpServerListenerContext) => void | Promise<void>;

export const DEFAULT_MAX_HTTP_BODY_BYTES = 64 * 1024;

export default class HttpServer {
    private readonly server: Http.Server;
    private readonly listeners: Map<string, Listener> = new Map();

    constructor(
        private readonly host: string,
        private readonly port: number,
        onListen?: (address: AddressInfo) => void,
        private readonly maxBodyBytes: number = DEFAULT_MAX_HTTP_BODY_BYTES,
    ) {
        this.server = Http.createServer((req, res) => {
            this.handle(req, res).catch((err) => {
                try {
                    if (!res.headersSent) {
                        res.writeHead(500, { "content-type": "application/json" });
                    }
                    res.end(JSON.stringify({ error: "http_server_error", detail: err?.toString?.() ?? String(err) }));
                } catch {
                    // ignore secondary failure
                }
            });
        });
        this.server.listen(this.port, this.host, () => {
            const addr = this.server.address();
            if (addr && typeof addr !== "string" && onListen) onListen(addr);
        });
    }

    public addListener(pathname: string, listener: Listener) {
        this.listeners.set(pathname, listener);
    }

    public async close() {
        await new Promise<void>((resolve) => this.server.close(() => resolve()));
    }

    private async handle(req: Http.IncomingMessage, res: Http.ServerResponse) {
        const method = (req.method || "GET").toUpperCase();
        if (method !== "GET" && method !== "POST") {
            res.writeHead(405, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "method_not_allowed" }));
            return;
        }

        const url = new URL(req.url || "/", "http://localhost");
        const listener = this.listeners.get(url.pathname);
        if (!listener) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "not_found" }));
            return;
        }

        const chunks: Buffer[] = [];
        if (method === "POST") {
            const contentLength = Number(req.headers["content-length"] ?? 0);
            if (Number.isFinite(contentLength) && contentLength > this.maxBodyBytes) {
                this.rejectOversizedBody(req, res);
                return;
            }
            let totalBytes = 0;
            for await (const chunk of req) {
                const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                totalBytes += buffer.length;
                if (totalBytes > this.maxBodyBytes) {
                    this.rejectOversizedBody(req, res);
                    return;
                }
                chunks.push(buffer);
            }
        }
        const body = chunks.length ? Buffer.concat(chunks) : Buffer.alloc(0);
        await listener({
            req,
            res,
            url,
            method: method as "GET" | "POST",
            body,
        });
    }

    private rejectOversizedBody(req: Http.IncomingMessage, res: Http.ServerResponse) {
        res.writeHead(413, { "content-type": "application/json", connection: "close" });
        res.end(JSON.stringify({ error: "payload_too_large" }));
        req.destroy();
    }
}

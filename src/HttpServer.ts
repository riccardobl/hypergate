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

export default class HttpServer {
    private readonly server: Http.Server;
    private readonly listeners: Map<string, Listener> = new Map();

    constructor(private readonly host: string, private readonly port: number, onListen?: (address: AddressInfo) => void) {
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
            for await (const chunk of req) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
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
}

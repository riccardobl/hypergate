import { describe, expect, it } from "vitest";
import HttpServer from "./HttpServer.js";

async function startServer(maxBodyBytes: number) {
    let resolveUrl!: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => {
        resolveUrl = resolve;
    });
    const server = new HttpServer("127.0.0.1", 0, (address) => resolveUrl(`http://${address.address}:${address.port}`), maxBodyBytes);
    return { server, url: await urlPromise };
}

describe("HttpServer request body limits", () => {
    it("accepts bodies at the configured limit", async () => {
        const { server, url } = await startServer(8);
        server.addListener("/body", ({ res, body }) => {
            res.writeHead(200);
            res.end(body);
        });
        try {
            const response = await fetch(`${url}/body`, { method: "POST", body: "12345678" });
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("12345678");
        } finally {
            await server.close();
        }
    });

    it("rejects oversized bodies before dispatching handlers", async () => {
        const { server, url } = await startServer(8);
        let dispatched = false;
        server.addListener("/body", () => {
            dispatched = true;
        });
        try {
            const response = await fetch(`${url}/body`, { method: "POST", body: "123456789" });
            expect(response.status).toBe(413);
            expect(await response.json()).toEqual({ error: "payload_too_large" });
            expect(dispatched).toBe(false);
        } finally {
            await server.close();
        }
    });
});

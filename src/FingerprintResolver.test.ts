import Net from "node:net";
import { describe, expect, it } from "vitest";
import FingerprintResolver from "./FingerprintResolver.js";

async function getFreePort(): Promise<number> {
    const server = Net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("failed to allocate test port");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return address.port;
}

describe("FingerprintResolver authentication", () => {
    it("protects all fingerprint data endpoints while leaving health public", async () => {
        const port = await getFreePort();
        const resolver = new FingerprintResolver({ host: "127.0.0.1", port, basicAuth: "user:pass" });
        const baseUrl = `http://127.0.0.1:${port}`;
        try {
            const health = await fetch(`${baseUrl}/health`);
            expect(health.status).toBe(200);

            for (const path of ["/all", "/resolve"]) {
                const unauthorized = await fetch(`${baseUrl}${path}`);
                expect(unauthorized.status).toBe(401);
                expect(unauthorized.headers.get("www-authenticate")).toContain("Basic");
            }

            const authorized = await fetch(`${baseUrl}/all`, {
                headers: { authorization: `Basic ${Buffer.from("user:pass").toString("base64")}` },
            });
            expect(authorized.status).toBe(200);
            expect(await authorized.json()).toEqual([]);
        } finally {
            await resolver.stop();
        }
    });
});

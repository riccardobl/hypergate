import { describe, expect, it } from "vitest";
import LimitRemoverService, { createUnlimitedToken } from "./LimitRemoverService.js";

async function startService(secret: string) {
    let resolveUrl!: (url: string) => void;
    const urlPromise = new Promise<string>((resolve) => {
        resolveUrl = resolve;
    });
    const service = new LimitRemoverService({ secret, port: 0, onListen: resolveUrl });
    return { service, url: await urlPromise };
}

describe("LimitRemoverService", () => {
    it("accepts authenticated tokens and rejects their replay", async () => {
        const { service, url } = await startService("test-secret");
        try {
            const token = createUnlimitedToken("test-secret", { timestamp: Date.now(), ip: "127.0.0.1" });
            const accepted = await fetch(`${url}/unlimited?payload=${token}`);
            expect(accepted.status).toBe(200);
            expect(service.getIngressOverrides().ips?.["127.0.0.1"]).toMatchObject({
                bandwidthLimit: null,
                labels: ["gateway-unlimited"],
            });
            expect(service.getIngressOverrides().ips?.["127.0.0.1"]?.allow).toBeUndefined();

            const replay = await fetch(`${url}/unlimited?payload=${token}`);
            expect(replay.status).toBe(409);
        } finally {
            await service.close();
        }
    });

    it("rejects tampered and legacy CBC tokens with the same generic error", async () => {
        const { service, url } = await startService("test-secret");
        try {
            const token = createUnlimitedToken("test-secret", { timestamp: Date.now(), ip: "127.0.0.1" });
            const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
            for (const candidate of [tampered, token.split(".")[1]!]) {
                const response = await fetch(`${url}/unlimited?payload=${candidate}`);
                expect(response.status).toBe(403);
                expect(await response.json()).toEqual({ error: "invalid_token" });
            }
        } finally {
            await service.close();
        }
    });
});

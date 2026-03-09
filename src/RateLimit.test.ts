import { describe, it, expect, vi } from "vitest";
import { RateLimiter } from "../src/RateLimit.js";

describe("RateLimiter", () => {
    it("should create a rate limiter without bandwidth limit", () => {
        const limiter = new RateLimiter(8080, null);
        const stats = limiter.getStats();
        expect(stats.bandwidth).toBeUndefined();
    });

    it("should create a rate limiter with bandwidth limit", () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 1, burstMbps: 2 },
        });
        const stats = limiter.getStats();
        expect(stats.bandwidth).toBeDefined();
        expect(stats.bandwidth?.burstBytes).toBeGreaterThan(0);
    });

    it("should convert mbps to bytes per second correctly", () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 8 }, // 8 Mbps = 1 MB/s
        });
        const stats = limiter.getStats();
        expect(stats.bandwidth?.burstBytes).toBe(1000000);
    });

    it("should immediately acquire when no bandwidth limit is set", async () => {
        const limiter = new RateLimiter(8080, null);
        await expect(limiter.acquire(1024)).resolves.toBe(true);
    });

    it("should immediately acquire small payload when tokens are available", async () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 1, burstMbps: 1 },
        });
        await expect(limiter.acquire(128)).resolves.toBe(true);
    });

    it("should throttle and expose throttled stats while waiting", async () => {
        vi.useFakeTimers();
        try {
            const limiter = new RateLimiter(8080, {
                bandwidthLimit: { mbps: 8, burstMbps: 8 }, // 1 MB/s burst
            });

            await limiter.acquire(1000000); // consume initial burst
            const secondAcquire = limiter.acquire(1000000);

            await Promise.resolve();
            const throttledStats = limiter.getStats();
            expect(throttledStats.bandwidth?.throttled).toBe(true);

            await vi.advanceTimersByTimeAsync(1000);
            await expect(secondAcquire).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("should allow chunks larger than burst and recover over time", async () => {
        vi.useFakeTimers();
        try {
            const limiter = new RateLimiter(8080, {
                bandwidthLimit: { mbps: 1, burstMbps: 1 }, // burst = 125KB
            });

            await expect(limiter.acquire(200000)).resolves.toBe(true);
            const delayedAcquire = limiter.acquire(125000);
            await Promise.resolve();
            expect(limiter.getStats().bandwidth?.throttled).toBe(true);
            await vi.advanceTimersByTimeAsync(2000);
            await expect(delayedAcquire).resolves.toBe(true);
        } finally {
            vi.useRealTimers();
        }
    });

    it("should return false when closed", async () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 1 },
        });
        limiter.close();
        await expect(limiter.acquire(100)).resolves.toBe(false);
    });

    it("should return correct stats structure", () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 10, burstMbps: 20 },
        });
        const stats = limiter.getStats();
        expect(stats.policy).toBeDefined();
        expect(stats.bandwidth).toBeDefined();
        expect(stats.bandwidth?.queuedBytes).toBe(0);
        expect(stats.bandwidth?.queueLength).toBe(0);
    });

    it("should have tokens available based on burst", () => {
        const limiter = new RateLimiter(8080, {
            bandwidthLimit: { mbps: 1000, burstMbps: 1000 },
        });
        const stats = limiter.getStats();
        expect(stats.bandwidth?.tokens).toBe(stats.bandwidth?.burstBytes);
    });
});

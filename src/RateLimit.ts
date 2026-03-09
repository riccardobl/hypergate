import type { IngressPolicyRule, BandwidthLimit } from "./IngressPolicy.js";

export class RateLimiter {
    private readonly channelPort: number;
    private readonly ingressPolicyRule: IngressPolicyRule;
    private readonly bandwidthLimit?: BandwidthLimit;
    private readonly bytesPerSecond: number;
    private readonly burstBytes: number;

    private closed: boolean = false;

    private tokensBytes: number = 0;
    private lastRefillAt: number = Date.now();
    private lastDelayMs: number = 0;
    private pendingRequests: number = 0;
    private serialize: Promise<void> = Promise.resolve();

    constructor(channelPort: number, ingressPolicyRule: IngressPolicyRule | null | undefined) {
        this.channelPort = channelPort;
        this.ingressPolicyRule = ingressPolicyRule ?? {};
        this.bandwidthLimit = this.ingressPolicyRule.bandwidthLimit ?? undefined;
        this.bytesPerSecond = this.bandwidthLimit ? (this.bandwidthLimit.mbps * 1_000_000) / 8 : 0;
        this.burstBytes = this.bandwidthLimit ? (((this.bandwidthLimit.burstMbps ?? this.bandwidthLimit.mbps) * 1_000_000) / 8) : 0;
        this.tokensBytes = this.burstBytes;
    }

    private refillTokens(now: number = Date.now()) {
        if (!this.bandwidthLimit) return;
        const elapsedMs = Math.max(0, now - this.lastRefillAt);
        if (elapsedMs <= 0) return;
        this.tokensBytes = Math.min(this.burstBytes, this.tokensBytes + (elapsedMs / 1000) * this.bytesPerSecond);
        this.lastRefillAt = now;
    }

    private computeNextDelayMs(requiredTokens: number): number {
        const deficitBytes = Math.max(1, requiredTokens - this.tokensBytes);
        if (this.bytesPerSecond <= 0) return 1000;
        return Math.max(1, Math.ceil((deficitBytes / this.bytesPerSecond) * 1000));
    }

    private async sleep(ms: number) {
        await new Promise((resolve) => setTimeout(resolve, ms));
    }

    private async acquireInternal(nBytes: number): Promise<boolean> {
        if (!this.bandwidthLimit) return true;
        if (this.closed) return false;

        // Allow chunks larger than burst: wait until bucket is full, then go negative and recover over time.
        const requiredTokens = Math.min(nBytes, this.burstBytes);
        while (!this.closed) {
            this.refillTokens();
            if (this.tokensBytes >= requiredTokens) {
                this.tokensBytes = Math.max(-this.burstBytes, this.tokensBytes - nBytes);
                return true;
            }
            const delayMs = this.computeNextDelayMs(requiredTokens);
            this.lastDelayMs = delayMs;
            await this.sleep(delayMs);
        }
        return false;
    }

    public async acquire(nBytes: number): Promise<boolean> {
        if (this.closed) return false;
        if (!this.bandwidthLimit) return true;
        if (nBytes <= 0) return true;

        this.pendingRequests += 1;
        const run = async () => {
            return await this.acquireInternal(nBytes);
        };

        const result = this.serialize.then(run, run);
        this.serialize = result.then(() => { }, () => { });

        try {
            return await result;
        } finally {
            this.pendingRequests = Math.max(0, this.pendingRequests - 1);
        }
    }

    public getStats() {
        this.refillTokens();
        return {
            policy: {
                bandwidthLimit: this.bandwidthLimit,
            },
            bandwidth: this.bandwidthLimit
                ? {
                    queuedBytes: 0,
                    queueLength: 0,
                    tokens: this.tokensBytes,
                    burstBytes: this.burstBytes,
                    throttled: this.pendingRequests > 0,
                    lastDelayMs: this.lastDelayMs,
                }
                : undefined,
        };
    }

    public close() {
        this.closed = true;
    }
}

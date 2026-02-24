import type { IngressPolicyRule, BandwidthLimit } from "./IngressPolicy.js";

type EnqueuedData = {
    data: Buffer;
    callback: () => void;
};

export class RateLimiter {
    private readonly channelPort: number;
    private readonly ingressPolicyRule: IngressPolicyRule;
    private readonly bandwidthLimit?: BandwidthLimit;
    private readonly bytesPerSecond: number;
    private readonly burstBytes: number;

    private queue: EnqueuedData[] = [];
    private queuedBytes: number = 0;
    private flushTimer?: NodeJS.Timeout;
    private closed: boolean = false;

    private tokensBytes: number = 0;
    private lastRefillAt: number = Date.now();
    private lastDelayMs: number = 0;

    constructor(channelPort: number, ingressPolicyRule: IngressPolicyRule | null | undefined) {
        this.channelPort = channelPort;
        this.ingressPolicyRule = ingressPolicyRule ?? {};
        this.bandwidthLimit = this.ingressPolicyRule.bandwidthLimit ?? undefined;
        this.bytesPerSecond = this.bandwidthLimit ? (this.bandwidthLimit.mbps * 1_000_000) / 8 : 0;
        this.burstBytes = this.bandwidthLimit ? (((this.bandwidthLimit.burstMbps ?? this.bandwidthLimit.mbps) * 1_000_000) / 8) : 0;
        this.tokensBytes = this.burstBytes;
    }

    private run(nBytes: number, callback: () => void) {
        if (this.closed) return;
        if (this.bandwidthLimit) {
            this.refillTokens();
            this.tokensBytes = Math.max(0, this.tokensBytes - nBytes);
        }
        callback();
    }

    private refillTokens(now: number = Date.now()) {
        if (!this.bandwidthLimit) return;
        const elapsedMs = Math.max(0, now - this.lastRefillAt);
        if (elapsedMs <= 0) return;
        this.tokensBytes = Math.min(this.burstBytes, this.tokensBytes + (elapsedMs / 1000) * this.bytesPerSecond);
        this.lastRefillAt = now;
    }

    public handle(data: Buffer | undefined, callback: () => void): boolean {
        if (this.closed) return false;
        if (!data || !this.bandwidthLimit) {
            callback();
            return true;
        }

        const nBytes = data.length;
        this.refillTokens();

        // Fast path: immediate pass when queue is empty and enough tokens are available.
        if (this.queue.length === 0 && this.tokensBytes >= nBytes) {
            this.run(nBytes, callback);
            return true;
        }

        // Slow path: enqueue and shape.
        this.queue.push({ data, callback });
        this.queuedBytes += nBytes;

        if (this.queuedBytes > this.burstBytes) {
            this.close();
            return false;
        }

        this.scheduleFlush();
        return true;
    }

    private scheduleFlush(delayMs?: number) {
        if (this.closed || !this.bandwidthLimit) return;
        if (this.flushTimer) return;
        const nextDelayMs = delayMs ?? this.computeNextDelayMs();
        this.lastDelayMs = nextDelayMs;
        this.flushTimer = setTimeout(() => {
            this.flushTimer = undefined;
            this.flush();
        }, nextDelayMs);
    }

    private flush() {
        if (this.closed || !this.bandwidthLimit) return;
        this.refillTokens();

        while (this.queue.length > 0) {
            const head = this.queue[0];
            if (!head) break;
            if (this.tokensBytes < head.data.length) break;

            this.queue.shift();
            this.queuedBytes -= head.data.length;
            this.run(head.data.length, head.callback);
            this.refillTokens();
        }

        if (this.queue.length > 0) {
            this.scheduleFlush(this.computeNextDelayMs());
        }
    }

    private computeNextDelayMs(): number {
        if (!this.bandwidthLimit || this.queue.length === 0) return 0;
        const head = this.queue[0];
        if (!head) return 0;
        const deficitBytes = Math.max(1, head.data.length - this.tokensBytes);
        return Math.max(1, Math.ceil((deficitBytes / this.bytesPerSecond) * 1000));
    }

    public getStats() {
        this.refillTokens();
        return {
            policy: {
                bandwidthLimit: this.bandwidthLimit,
            },
            bandwidth: this.bandwidthLimit
                ? {
                    queuedBytes: this.queuedBytes,
                    queueLength: this.queue.length,
                    tokens: this.tokensBytes,
                    burstBytes: this.burstBytes,
                    throttled: this.queue.length > 0,
                    lastDelayMs: this.lastDelayMs,
                }
                : undefined,
        };
    }

    public close() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = undefined;
        }
        this.closed = true;
        this.queue = [];
        this.queuedBytes = 0;
    }
}

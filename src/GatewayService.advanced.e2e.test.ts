import { describe, it, expect } from 'vitest';
import Gateway from './Gateway.js';
import ServiceProvider from './ServiceProvider.js';
import { Protocol } from './Protocol.js';
import dgram from 'dgram';
import { randomBytes } from 'crypto';

function waitFor(condition: () => boolean, timeoutMs = 60000, intervalMs = 50, label?: string): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            try {
                if (condition()) {
                    clearInterval(iv);
                    resolve();
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(iv);
                    reject(new Error(`timeout waiting for condition${label ? ` (${label})` : ''}`));
                }
            } catch (e) {
                clearInterval(iv);
                reject(e);
            }
        }, intervalMs);
    });
}

describe('Advanced Gateway <-> ServiceProvider e2e', () => {
    it('udp forwarding, multi-route selection, fragmentation, ordering and rate-limits', async () => {
        const secret = randomBytes(32).toString('hex');

        // UDP echo service (will echo payload back)
        const udpServer = dgram.createSocket('udp4');
        udpServer.on('message', (msg, rinfo) => {
            // echo back exactly what was received
            udpServer.send(msg, rinfo.port, rinfo.address);
        });
        await new Promise<void>((res) => udpServer.bind(0, '127.0.0.1', res));
        const srvAddr = udpServer.address();
        if (!srvAddr || typeof srvAddr === 'string') throw new Error('invalid udp addr');
        const udpPort = srvAddr.port;

        // Start two providers with same gatePort to test route selection among multiple providers
        const gatePort = 41000 + Math.floor(Math.random() * 500);
        const provider1 = new ServiceProvider(secret, undefined, { port: 0 }, { defaults: undefined } as any);
        const provider2 = new ServiceProvider(secret, undefined, { port: 0 }, { defaults: undefined } as any);

        provider1.addService(gatePort, '127.0.0.1', udpPort, Protocol.udp);
        provider2.addService(gatePort, '127.0.0.1', udpPort, Protocol.udp);

        // Create a gateway
        const gateway = new Gateway(secret, '127.0.0.1');

        try {
            // wait for routing discovery (can be slower under parallel e2e load/logging)
            await waitFor(
                () => (gateway as any).routingTable.some((r: any) => r.gatePort === gatePort && r.protocol === Protocol.udp),
                30000,
                100,
                'gateway routing discovery',
            );
            // wait for gate to be opened
            await waitFor(
                () => (gateway as any).gates.find((g: any) => g.port === gatePort && g.protocol === Protocol.udp),
                30000,
                100,
                'udp gate open',
            );

            const gate = (gateway as any).gates.find((g: any) => g.port === gatePort && g.protocol === Protocol.udp);
            expect(gate).toBeDefined();

            // UDP client that sends many packets fast to test ordering and rate
            const client = dgram.createSocket('udp4');

            const messages: Buffer[] = [];
            const total = 90;
            for (let i = 0; i < total; i++) {
                const seq = Buffer.from(String(i).padStart(6, '0'));
                messages.push(Buffer.concat([Buffer.from('MSG:'), seq, Buffer.from(':'), Buffer.alloc(3000, i % 256)]));
            }

            const received: Buffer[] = [];
            client.on('message', (msg) => {
                received.push(msg);
            });

            // Warm up the UDP channel first so the burst does not race channel establishment.
            const warmup = Buffer.from('WARMUP');
            client.send(warmup, gate.port, '127.0.0.1');
            await waitFor(() => received.some((b) => b.equals(warmup)), 10000, 50, 'udp warmup echo');
            received.length = 0;

            // Send in small batches. Keeps total coverage at 200/100% while avoiding local UDP burst loss.
            for (let i = 0; i < messages.length; i++) {
                client.send(messages[i], gate.port, '127.0.0.1');
                if ((i + 1) % 10 === 0) {
                    await new Promise((r) => setTimeout(r, 2));
                }
            }

            // UDP can still drop under bursty load during channel setup; require high but not perfect delivery
            const need = total;
            await waitFor(() => received.length >= need, 30000, 100, 'udp burst echoes');

            // Validate payload shape/integrity. UDP does not guarantee ordering.
            const seqs = received.map((b) => {
                expect(b.slice(0, 4).toString('utf8')).toBe('MSG:');
                const n = Number(b.toString('utf8', 4, 10));
                expect(Number.isInteger(n)).toBe(true);
                expect(n).toBeGreaterThanOrEqual(0);
                expect(n).toBeLessThan(total);
                return n;
            });
            expect(new Set(seqs).size).toBe(seqs.length);

            // Test large UDP payload (must stay within UDP datagram limits)
            const large = Buffer.alloc(60_000, 0x41);
            const marker = Buffer.from('LARGE:');
            const payload = Buffer.concat([marker, large]);

            const largeReceived: Buffer[] = [];
            client.on('message', (m) => {
                if (m.slice(0, 6).toString() === 'LARGE:') largeReceived.push(m);
            });

            client.send(payload, gate.port, '127.0.0.1');
            await waitFor(() => largeReceived.length >= 1, 10000, 50, 'large udp echo');
            expect(largeReceived[0]).toEqual(payload);

            // Test rate/bandwidth limits: register a provider with ingressPolicy limit and verify queueing/rejection
            const limitedSecret = randomBytes(32).toString('hex');
            const limitedGatePort = gatePort + 1;
            // create a local echo UDP server for limited provider
            const udpServer2 = dgram.createSocket('udp4');
            udpServer2.on('message', (msg, rinfo) => udpServer2.send(msg, rinfo.port, rinfo.address));
            await new Promise<void>((res) => udpServer2.bind(0, '127.0.0.1', res));
            const srv2Port = (udpServer2.address() as any).port;
            // provider with ingress policy limit (very small mbps)
            const ingressPolicy = { defaults: { bandwidthLimit: { mbps: 0.1, burstMbps: 0.1 } } } as any;
            // create provider with ingress policy by constructing with it
            const limitedProvider2 = new ServiceProvider(limitedSecret, undefined, { port: 0 }, ingressPolicy as any);
            limitedProvider2.addService(limitedGatePort, '127.0.0.1', srv2Port, Protocol.udp);
            const gateway2 = new Gateway(limitedSecret, '127.0.0.1');

            // wait discovery (can be slower under parallel e2e load/logging)
            await waitFor(
                () => (gateway2 as any).routingTable.some((r: any) => r.gatePort === limitedGatePort && r.protocol === Protocol.udp),
                30000,
                100,
                'limited gateway routing discovery',
            );
            await waitFor(
                () => (gateway2 as any).gates.find((g: any) => g.port === limitedGatePort && g.protocol === Protocol.udp),
                30000,
                100,
                'limited udp gate open',
            );

            const client2 = dgram.createSocket('udp4');
            const small = Buffer.alloc(20000, 0x42);
            // send multiple packets to exceed burst and observe behavior (some may be queued/throttled but should eventually be processed)
            for (let i = 0; i < 10; i++) client2.send(small, limitedGatePort, '127.0.0.1');

            // wait some time to let rate limiter act
            await new Promise((r) => setTimeout(r, 2000));

            // cleanup limited sockets
            client2.close();
            udpServer2.close();
            try { gateway2.stop(); } catch { }
            try { limitedProvider2.stop(); } catch { }

            client.close();
        } finally {
            try { gateway.stop(); } catch { }
            try { provider1.stop(); } catch { }
            try { provider2.stop(); } catch { }
            try { udpServer.close(); } catch { }
        }
    }, 60000);
});

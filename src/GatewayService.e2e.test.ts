import { describe, it, expect } from 'vitest';
import Gateway from './Gateway.js';
import ServiceProvider from './ServiceProvider.js';
import { Protocol } from './Protocol.js';
import Net from 'net';
import { randomBytes } from 'crypto';

function waitFor(condition: () => boolean, timeoutMs = 10000, intervalMs = 100): Promise<void> {
    const start = Date.now();
    return new Promise((resolve, reject) => {
        const iv = setInterval(() => {
            try {
                if (condition()) {
                    clearInterval(iv);
                    resolve();
                } else if (Date.now() - start > timeoutMs) {
                    clearInterval(iv);
                    reject(new Error('timeout waiting for condition'));
                }
            } catch (e) {
                clearInterval(iv);
                reject(e);
            }
        }, intervalMs);
    });
}

describe('Gateway <-> ServiceProvider end-to-end', () => {
    it('forwards TCP connection to registered service', async () => {
        // create a small TCP service that echoes a response
        const server = Net.createServer((sock) => {
            sock.on('data', (data) => {
                // reply a simple response
                if (data.toString() === 'hello') sock.write('world');
            });
        });

        await new Promise<void>((res, rej) => server.listen(0, '127.0.0.1', () => res()));
        const srvAddr = server.address();
        if (!srvAddr || typeof srvAddr === 'string') throw new Error('invalid server address');
        const servicePort = srvAddr.port;

        const secret = randomBytes(32).toString('hex');

        const provider = new ServiceProvider(secret, undefined, { port: 0 });
        const gateway = new Gateway(secret, '127.0.0.1');

        // register service on provider: gatePort is the external port gateway will open
        const gatePort = 40000 + Math.floor(Math.random() * 1000);
        provider.setServices([
            { gatePort, serviceHost: '127.0.0.1', servicePort, protocol: Protocol.tcp, tags: undefined },
        ] as any);

        try {
            // wait until gateway has learned about the route
            await waitFor(() => (gateway as any).routingTable && (gateway as any).routingTable.length > 0, 10000);

            // wait until gateway opened a gate for our gatePort
            await waitFor(() => Array.isArray((gateway as any).gates) && (gateway as any).gates.find((g: any) => g.port == gatePort), 10000);

            const gate = (gateway as any).gates.find((g: any) => g.port == gatePort);
            expect(gate).toBeDefined();

            // connect to the gateway gate from a client
            const client = new Net.Socket();
            await new Promise<void>((res, rej) => {
                client.connect(gate.port, '127.0.0.1', () => res());
                client.on('error', (e) => rej(e));
            });

            const received: Buffer[] = [];
            client.on('data', (d) => received.push(d));

            // send hello and expect world back
            client.write('hello');

            // wait for response
            await waitFor(() => received.length > 0, 5000);
            expect(Buffer.concat(received).toString()).toBe('world');

            client.end();
            client.destroy();
        } finally {
            try { await gateway.stop(); } catch { }
            try { await provider.stop(); } catch { }
            try { server.close(); } catch { }
        }
    }, 30000);
});

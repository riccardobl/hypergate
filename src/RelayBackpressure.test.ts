import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { writeWithBackpressure } from './RelayBackpressure.js';

class MockSource extends EventEmitter {
    public pauseCalls = 0;
    public resumeCalls = 0;
    public destroyed = false;

    pause() {
        this.pauseCalls++;
    }

    resume() {
        this.resumeCalls++;
    }
}

class MockDestination extends EventEmitter {
    private readonly writes: Array<boolean | void>;
    public readonly chunks: Buffer[] = [];
    public destroyed = false;

    constructor(writes: Array<boolean | void>) {
        super();
        this.writes = [...writes];
    }

    write(chunk: Buffer): boolean | void {
        this.chunks.push(Buffer.from(chunk));
        if (this.writes.length === 0) return true;
        return this.writes.shift();
    }
}

describe('Relay backpressure writer', () => {
    it('pauses source on backpressure and resumes on drain without leaking listeners', async () => {
        const source = new MockSource();
        const destination = new MockDestination([false]);

        const writePromise = writeWithBackpressure(destination, source, Buffer.from('abc'), true);

        expect(source.pauseCalls).toBe(1);
        expect(source.resumeCalls).toBe(0);
        expect(destination.listenerCount('drain')).toBe(1);

        destination.emit('drain');
        await writePromise;

        expect(source.resumeCalls).toBe(1);
        expect(destination.listenerCount('drain')).toBe(0);
        expect(destination.listenerCount('close')).toBe(0);
        expect(destination.listenerCount('end')).toBe(0);
        expect(destination.listenerCount('error')).toBe(0);
        expect(source.listenerCount('close')).toBe(0);
        expect(source.listenerCount('end')).toBe(0);
        expect(source.listenerCount('error')).toBe(0);
    });

    it('preserves ordering and bytes for large sequenced transfer under intermittent backpressure', async () => {
        const source = new MockSource();
        const outcomes: boolean[] = [];
        for (let i = 0; i < 128; i++) {
            outcomes.push(i % 8 !== 0);
        }
        const destination = new MockDestination(outcomes);

        const chunks: Buffer[] = [];
        for (let i = 0; i < 128; i++) {
            chunks.push(Buffer.alloc(16_384, i % 256));
        }

        let chain = Promise.resolve();
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            chain = chain.then(async () => {
                const p = writeWithBackpressure(destination, source, chunk, true);
                if (destination.listenerCount('drain') > 0) {
                    // Release blocked writes in a future tick to emulate async drain.
                    setTimeout(() => destination.emit('drain'), 0);
                }
                await p;
            });
        }
        await chain;

        expect(Buffer.concat(destination.chunks)).toEqual(Buffer.concat(chunks));
        expect(source.pauseCalls).toBeGreaterThan(0);
        expect(source.pauseCalls).toBe(source.resumeCalls);
    }, 15000);
});

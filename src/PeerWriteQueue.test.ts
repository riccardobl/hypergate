import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'events';
import { enqueuePeerWrite, enqueuePeerWrites, type PeerWriteQueueState } from './PeerWriteQueue.js';

class MockPeerTransport extends EventEmitter {
    private readonly writes: Array<boolean | void>;
    public readonly chunks: Buffer[] = [];
    public destroyed = false;
    public destroyReason?: Error;

    constructor(writes: Array<boolean | void>) {
        super();
        this.writes = [...writes];
    }

    write(chunk: Buffer): boolean | void {
        this.chunks.push(Buffer.from(chunk));
        if (this.writes.length === 0) return true;
        return this.writes.shift();
    }

    destroy(error?: Error) {
        this.destroyed = true;
        this.destroyReason = error;
        this.emit('close');
    }
}

describe('Peer outbound write queue', () => {
    it('preserves message ordering while waiting for transport drain', async () => {
        const state: PeerWriteQueueState = {};
        const destination = new MockPeerTransport([false, true, false, true]);

        const first = enqueuePeerWrite(state, destination, Buffer.from('first'));
        const second = enqueuePeerWrite(state, destination, Buffer.from('second'));
        const third = enqueuePeerWrite(state, destination, Buffer.from('third'));

        await Promise.resolve();
        expect(destination.chunks.map((chunk) => chunk.toString())).toEqual(['first']);
        destination.emit('drain');
        await first;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(destination.chunks.map((chunk) => chunk.toString())).toEqual(['first', 'second', 'third']);
        destination.emit('drain');
        await Promise.all([second, third]);

        expect(Buffer.concat(destination.chunks).toString()).toBe('firstsecondthird');
        expect(state.queuedWriteBytes ?? 0).toBe(0);
    });

    it('destroys the peer transport when outbound buffering exceeds the configured limit', async () => {
        const state: PeerWriteQueueState = {};
        const destination = new MockPeerTransport([false]);

        const blocked = enqueuePeerWrite(state, destination, Buffer.alloc(8), 10);
        await Promise.resolve();
        await expect(enqueuePeerWrite(state, destination, Buffer.alloc(4), 10)).rejects.toThrow(/outbound buffer exceeded/i);

        expect(destination.destroyed).toBe(true);
        await expect(blocked).rejects.toThrow(/closed before queued write drained|closed while waiting for drain/i);
        expect(state.queuedWriteBytes ?? 0).toBe(0);
    });

    it('can write a framed message sequence atomically in order', async () => {
        const state: PeerWriteQueueState = {};
        const destination = new MockPeerTransport([true, true, true]);

        await enqueuePeerWrites(state, destination, [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);

        expect(destination.chunks.map((chunk) => chunk.toString())).toEqual(['a', 'b', 'c']);
    });

    it('prioritizes control writes ahead of queued bulk traffic', async () => {
        const state: PeerWriteQueueState = {};
        const destination = new MockPeerTransport([false, true, true]);

        const bulk = enqueuePeerWrite(state, destination, Buffer.from('bulk-1'), 1024, 'bulk');
        await Promise.resolve();
        const control = enqueuePeerWrite(state, destination, Buffer.from('control'), 1024, 'control');
        const bulk2 = enqueuePeerWrite(state, destination, Buffer.from('bulk-2'), 1024, 'bulk');

        destination.emit('drain');
        await Promise.all([bulk, control, bulk2]);

        expect(destination.chunks.map((chunk) => chunk.toString())).toEqual(['bulk-1', 'control', 'bulk-2']);
    });
});

import { Limits } from './Limits.js';
import { RelayWritable, writeWithBackpressure } from './RelayBackpressure.js';

export type PeerQueueWritable = RelayWritable & {
    destroy?: (error?: Error) => void;
    writableEnded?: boolean;
    writableFinished?: boolean;
};

export type PeerWriteQueueState = {
    writeChain?: Promise<void>;
    queuedWriteBytes?: number;
};

function isWritableOpen(destination: PeerQueueWritable): boolean {
    return !destination.destroyed && !destination.writableEnded && !destination.writableFinished;
}

function overflowError(maxQueuedBytes: number): Error {
    return new Error(`Peer outbound buffer exceeded limit of ${maxQueuedBytes} bytes`);
}

export function enqueuePeerWrite(
    state: PeerWriteQueueState,
    destination: PeerQueueWritable,
    chunk: Buffer,
    maxQueuedBytes: number = Limits.MAX_BUFFER_PER_PEER,
): Promise<void> {
    if (!chunk || chunk.length === 0) return Promise.resolve();
    if (!isWritableOpen(destination)) {
        return Promise.reject(new Error('Peer transport is not writable'));
    }

    state.queuedWriteBytes = (state.queuedWriteBytes ?? 0) + chunk.length;
    if ((state.queuedWriteBytes ?? 0) > maxQueuedBytes) {
        state.queuedWriteBytes = Math.max(0, (state.queuedWriteBytes ?? 0) - chunk.length);
        const err = overflowError(maxQueuedBytes);
        try {
            destination.destroy?.(err);
        } catch (destroyError) {
            console.error('Failed to destroy peer transport after outbound overflow', destroyError);
        }
        return Promise.reject(err);
    }

    const run = async () => {
        try {
            if (!isWritableOpen(destination)) {
                throw new Error('Peer transport closed before queued write drained');
            }
            await writeWithBackpressure(destination, undefined, chunk, true);
        } finally {
            state.queuedWriteBytes = Math.max(0, (state.queuedWriteBytes ?? 0) - chunk.length);
        }
    };

    const operation = (state.writeChain ?? Promise.resolve()).then(run, run);
    state.writeChain = operation.catch(() => undefined);
    return operation;
}

export async function enqueuePeerWrites(
    state: PeerWriteQueueState,
    destination: PeerQueueWritable,
    chunks: Buffer[],
    maxQueuedBytes: number = Limits.MAX_BUFFER_PER_PEER,
): Promise<void> {
    for (const chunk of chunks) {
        await enqueuePeerWrite(state, destination, chunk, maxQueuedBytes);
    }
}

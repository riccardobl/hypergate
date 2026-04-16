import { Limits } from './Limits.js';
import { RelayWritable, writeWithBackpressure } from './RelayBackpressure.js';

export type PeerQueueWritable = RelayWritable & {
    destroy?: (error?: Error) => void;
    writableEnded?: boolean;
    writableFinished?: boolean;
};

export type PeerWriteQueueState = {
    writeLoop?: Promise<void>;
    controlQueue?: PeerQueuedWrite[];
    bulkQueue?: PeerQueuedWrite[];
    queuedWriteBytes?: number;
};

export type PeerWritePriority = 'control' | 'bulk';

type PeerQueuedWrite = {
    chunk: Buffer;
    resolve: () => void;
    reject: (error: Error) => void;
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
    priority: PeerWritePriority = 'bulk',
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

    const queue = priority === 'control'
        ? (state.controlQueue ??= [])
        : (state.bulkQueue ??= []);

    const operation = new Promise<void>((resolve, reject) => {
        queue.push({ chunk, resolve, reject });
    });

    const failQueuedWrites = (error: Error) => {
        for (const pendingQueue of [state.controlQueue, state.bulkQueue]) {
            while (pendingQueue?.length) {
                const pending = pendingQueue.shift();
                if (!pending) continue;
                state.queuedWriteBytes = Math.max(0, (state.queuedWriteBytes ?? 0) - pending.chunk.length);
                pending.reject(error);
            }
        }
    };

    const runLoop = async () => {
        while (true) {
            const next = (state.controlQueue?.shift()) ?? (state.bulkQueue?.shift());
            if (!next) return;
            try {
                if (!isWritableOpen(destination)) {
                    throw new Error('Peer transport closed before queued write drained');
                }
                await writeWithBackpressure(destination, undefined, next.chunk, true);
                next.resolve();
            } catch (error) {
                const err = error instanceof Error ? error : new Error(String(error));
                next.reject(err);
                failQueuedWrites(err);
                return;
            } finally {
                state.queuedWriteBytes = Math.max(0, (state.queuedWriteBytes ?? 0) - next.chunk.length);
            }
        }
    };

    const startLoop = () => {
        if (state.writeLoop) return;
        state.writeLoop = runLoop().finally(() => {
            state.writeLoop = undefined;
            if ((state.controlQueue?.length ?? 0) > 0 || (state.bulkQueue?.length ?? 0) > 0) {
                startLoop();
            }
        });
    };

    startLoop();

    return operation;
}

export async function enqueuePeerWrites(
    state: PeerWriteQueueState,
    destination: PeerQueueWritable,
    chunks: Buffer[],
    maxQueuedBytes: number = Limits.MAX_BUFFER_PER_PEER,
    priority: PeerWritePriority = 'bulk',
): Promise<void> {
    await Promise.all(chunks.map((chunk) => enqueuePeerWrite(state, destination, chunk, maxQueuedBytes, priority)));
}

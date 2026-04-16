export type PausableReadable = {
    pause?: () => void;
    resume?: () => void;
    on?: (event: string, listener: (...args: any[]) => void) => void;
    off?: (event: string, listener: (...args: any[]) => void) => void;
    removeListener?: (event: string, listener: (...args: any[]) => void) => void;
    destroyed?: boolean;
};

export type RelayWritable = {
    write: (chunk: Buffer) => boolean | void;
    on?: (event: string, listener: (...args: any[]) => void) => void;
    off?: (event: string, listener: (...args: any[]) => void) => void;
    removeListener?: (event: string, listener: (...args: any[]) => void) => void;
    destroyed?: boolean;
};

export async function writeWithBackpressure(
    destination: RelayWritable,
    source: PausableReadable | undefined,
    chunk: Buffer,
    useBackpressure: boolean,
): Promise<void> {
    if (destination.destroyed) return;
    const wrote = destination.write(chunk);
    if (!useBackpressure || wrote !== false) return;

    const canPauseSource = !!source && typeof source.pause === "function" && typeof source.resume === "function";
    if (canPauseSource) {
        source.pause?.();
    }
    await new Promise<void>((resolve) => {
        let done = false;
        const listeners: Array<() => void> = [];

        const addListener = (target: any, event: string, listener: (...args: any[]) => void) => {
            if (!target?.on) return;
            target.on(event, listener);
            listeners.push(() => {
                if (target.off) target.off(event, listener);
                else if (target.removeListener) target.removeListener(event, listener);
            });
        };

        const finish = () => {
            if (done) return;
            done = true;
            for (const detach of listeners) detach();
            resolve();
        };

        addListener(destination, 'drain', finish);
        addListener(destination, 'close', finish);
        addListener(destination, 'end', finish);
        addListener(destination, 'error', finish);
        if (source) {
            addListener(source, 'close', finish);
            addListener(source, 'end', finish);
            addListener(source, 'error', finish);
        }
    });

    if (canPauseSource && !source?.destroyed) {
        source.resume?.();
    }
}

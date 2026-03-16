import { describe, expect, it } from 'vitest';
import { getBufferedPayloadsForFlush } from './Gateway.js';
import { Protocol } from './Protocol.js';

describe('Gateway buffered flush', () => {
    it('preserves UDP datagram boundaries', () => {
        const buffered = [
            Buffer.from('first'),
            Buffer.from('second'),
            Buffer.from('third'),
        ];

        const flushed = getBufferedPayloadsForFlush(Protocol.udp, buffered);

        expect(flushed).toHaveLength(3);
        expect(flushed.map((chunk) => chunk.toString())).toEqual(['first', 'second', 'third']);
    });

    it('merges buffered TCP chunks into one stream payload', () => {
        const buffered = [
            Buffer.from('first'),
            Buffer.from('second'),
            Buffer.from('third'),
        ];

        const flushed = getBufferedPayloadsForFlush(Protocol.tcp, buffered);

        expect(flushed).toHaveLength(1);
        expect(flushed[0]?.toString()).toBe('firstsecondthird');
    });
});

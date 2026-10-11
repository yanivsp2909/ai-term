import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FrameDecoder, encodeControl, encodeData, decodeControl, MAX_FRAME_BYTES } from '../src/shared/protocol.js';
describe('frame contract', () => {
    it('handles every split position and coalesced frames', () => {
        const hello = { id: randomUUID(), kind: 'hello', protocol: 1, version: '0.1.1' };
        const encoded = encodeControl(hello);
        for (let i = 1; i < encoded.length; i++) {
            const decoder = new FrameDecoder();
            expect(decoder.push(encoded.subarray(0, i))).toEqual([]);
            expect(decoder.push(encoded.subarray(i)).map(decodeControl)).toEqual([hello]);
        }
        expect(new FrameDecoder().push(Buffer.concat([encoded, encoded])).map(decodeControl)).toEqual([hello, hello]);
    });
    it('rejects oversize, zero length, unknown type and malformed JSON', () => {
        for (const size of [0, MAX_FRAME_BYTES + 1]) {
            const header = Buffer.alloc(4);
            header.writeUInt32BE(size);
            expect(() => new FrameDecoder().push(header)).toThrow();
        }
        expect(() => new FrameDecoder().push(Buffer.from([0, 0, 0, 1, 99]))).toThrow();
        expect(() => decodeControl({ type: 1, payload: Buffer.from('{') })).toThrow();
        expect(() => decodeControl({ type: 1, payload: Buffer.from([0xff]) })).toThrow();
    });
    it('frames terminal bytes with a 36-byte UUID prefix', () => {
        const id = randomUUID();
        const bytes = Buffer.from('\x1b[31mhi');
        const frames = new FrameDecoder().push(encodeData(2, id, bytes));
        expect(frames[0]?.payload.subarray(0, 36).toString()).toBe(id);
        expect(frames[0]?.payload.subarray(36)).toEqual(bytes);
        expect(() => encodeData(2, '-bad', bytes)).toThrow();
    });
});

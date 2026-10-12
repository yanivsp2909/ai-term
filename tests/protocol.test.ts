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
describe('frame rejections', () => {
    const frame = (type: number, payload: Buffer) => { const header = Buffer.alloc(5); header.writeUInt32BE(payload.length + 1); header[4] = type; return Buffer.concat([header, payload]); };
    it('refuses to encode a frame over 4 MB, so the daemon never sends what a client must reject', () => {
        // JSON adds two quotes; this payload plus the type byte is exactly the limit.
        expect(encodeControl('x'.repeat(MAX_FRAME_BYTES - 3)).length).toBe(MAX_FRAME_BYTES + 4);
        expect(() => encodeControl('x'.repeat(MAX_FRAME_BYTES - 2))).toThrow(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }));
        expect(() => encodeData(2, randomUUID(), Buffer.alloc(MAX_FRAME_BYTES))).toThrow(expect.objectContaining({ code: 'FRAME_TOO_LARGE' }));
    });
    it('decodes only control frames as JSON', () => {
        for (const type of [2, 3] as const)
            expect(() => decodeControl({ type, payload: Buffer.from('{}') })).toThrow(expect.objectContaining({ code: 'INVALID_FRAME' }));
        expect(() => decodeControl({ type: 1, payload: Buffer.from('{"a":1}{') })).toThrow(expect.objectContaining({ code: 'INVALID_JSON' }));
    });
    it('accepts string input as bytes', () => {
        const hello = { id: randomUUID(), kind: 'hello' };
        expect(new FrameDecoder().push(encodeControl(hello).toString('latin1')).map(decodeControl)).toEqual([hello]);
    });
    it('refuses unknown types 0 and 4 with a typed error', () => {
        for (const type of [0, 4, 255])
            expect(() => new FrameDecoder().push(frame(type, Buffer.from('{}')))).toThrow(expect.objectContaining({ code: 'INVALID_TYPE' }));
    });
    it('refuses data frames without a leading session UUID, for output and input alike', () => {
        for (const type of [2, 3]) {
            for (const payload of [Buffer.alloc(0), Buffer.from('short'), Buffer.from('x'.repeat(36) + 'data'), Buffer.from('-' + randomUUID().slice(1) + 'data')])
                expect(() => new FrameDecoder().push(frame(type, payload))).toThrow(expect.objectContaining({ code: 'INVALID_ID' }));
            expect(new FrameDecoder().push(frame(type, Buffer.from(randomUUID() + 'data')))).toHaveLength(1);
        }
    });
    it('keeps no partial state after a frame: a decoder returns each later frame whole', () => {
        const decoder = new FrameDecoder(), a = { id: randomUUID(), kind: 'a' }, b = { id: randomUUID(), kind: 'b' };
        expect(decoder.push(encodeControl(a)).map(decodeControl)).toEqual([a]);
        const second = encodeControl(b);
        expect(decoder.push(second.subarray(0, 3))).toEqual([]);
        expect(decoder.push(second.subarray(3)).map(decodeControl)).toEqual([b]);
    });
});

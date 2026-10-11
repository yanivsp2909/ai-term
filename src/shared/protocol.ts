import { isUUID } from './validate.js';
export const PROTOCOL_VERSION = 1;
// Length counts the type byte and payload, excluding the four-byte prefix.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024;
export type Engine = 'claude-code' | 'codex' | 'shell'; // shell is internal, hidden from the UI.
export type Status = 'starting' | 'running' | 'exited' | 'error';
export interface SessionInfo {
    id: string;
    title: string;
    engine: Engine;
    model: string;
    auth: {
        kind: 'account';
    };
    cwd: string;
    permission: 'ask';
    status: Status;
    statusDetail: string;
    statusSince: string;
    exitCode: number | null;
    createdAt: string;
    lastOutputAt: string | null;
    ctxPercent: null;
}
// `id` identifies the request; `sessionId` identifies its target (no ambiguous duplicate id).
export type Request = {
    id: string;
} & ({
    kind: 'hello';
    protocol: number;
    version: string;
} | {
    kind: 'sessions.list';
} | {
    kind: 'sessions.create';
    engine: 'shell';
    cwd: string;
    title?: string;
} | {
    kind: 'sessions.preview';
    sessionId: string | null;
} | {
    kind: 'sessions.stop' | 'sessions.remove';
    sessionId: string;
} | {
    kind: 'sessions.rename';
    sessionId: string;
    title: string;
} | {
    kind: 'layout.previewSize';
    cols: number;
    rows: number;
});
export interface SuccessResponse {
    id: string;
    ok: true;
    kind?: 'hello';
    protocol?: number;
    version?: string;
    pid?: number;
    sessions?: SessionInfo[];
    session?: SessionInfo;
    snapshot?: string;
    sessionId?: string;
    cols?: number;
    rows?: number;
}
export type Response = SuccessResponse | {
    id?: string;
    ok: false;
    error: {
        code: string;
        message: string;
    };
} | {
    id: string;
    kind: 'helloMismatch';
    protocol: number;
};
export type SessionEvent = {
    kind: 'session.updated';
    session: SessionInfo;
} | {
    kind: 'session.removed';
    sessionId: string;
};
export interface Frame {
    type: 1 | 2 | 3;
    payload: Buffer;
}
export class ProtocolError extends Error {
    constructor(public readonly code: string, message: string) { super(message); }
}
function encode(type: 1 | 2 | 3, payload: Buffer): Buffer {
    if (payload.length + 1 > MAX_FRAME_BYTES)
        throw new ProtocolError('FRAME_TOO_LARGE', 'Frame exceeds 4 MB');
    const result = Buffer.allocUnsafe(payload.length + 5);
    result.writeUInt32BE(payload.length + 1);
    result[4] = type;
    payload.copy(result, 5);
    return result;
}
export function encodeControl(value: unknown): Buffer { return encode(1, Buffer.from(JSON.stringify(value))); }
export function encodeData(type: 2 | 3, sessionId: string, data: Buffer): Buffer {
    if (!isUUID(sessionId))
        throw new ProtocolError('INVALID_ID', 'Expected a session UUID');
    return encode(type, Buffer.concat([Buffer.from(sessionId, 'ascii'), data]));
}
export function decodeControl(frame: Frame): unknown {
    if (frame.type !== 1)
        throw new ProtocolError('INVALID_FRAME', 'Expected control frame');
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.payload)) as unknown;
    }
    catch {
        throw new ProtocolError('INVALID_JSON', 'Control payload must be valid UTF-8 JSON');
    }
}
export class FrameDecoder {
    private pending = Buffer.alloc(0);
    private filled = 0;
    private expected: number | null = null;
    push(input: Buffer | string): Frame[] {
        let chunk = typeof input === 'string' ? Buffer.from(input) : input;
        const frames: Frame[] = [];
        while (chunk.length) {
            const target = this.expected === null ? 4 : this.expected;
            if (this.pending.length === 0)
                this.pending = Buffer.allocUnsafe(target);
            const count = Math.min(target - this.filled, chunk.length);
            chunk.copy(this.pending, this.filled, 0, count);
            this.filled += count;
            chunk = chunk.subarray(count);
            if (this.filled !== target)
                continue;
            if (this.expected === null) {
                const length = this.pending.readUInt32BE();
                this.pending = Buffer.alloc(0);
                this.filled = 0;
                if (length < 1 || length > MAX_FRAME_BYTES)
                    throw new ProtocolError('INVALID_LENGTH', 'Frame length outside 1–4 MB');
                this.expected = length;
            }
            else {
                const type = this.pending[0];
                if (type !== 1 && type !== 2 && type !== 3)
                    throw new ProtocolError('INVALID_TYPE', 'Unknown frame type');
                const payload = this.pending.subarray(1);
                if (type !== 1 && (payload.length < 36 || !isUUID(payload.subarray(0, 36).toString('ascii'))))
                    throw new ProtocolError('INVALID_ID', 'Data frame needs a session UUID');
                frames.push({ type, payload });
                this.pending = Buffer.alloc(0);
                this.filled = 0;
                this.expected = null;
            }
        }
        return frames;
    }
}

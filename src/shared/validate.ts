export function isValidModelId(id: string): boolean {
    // Keep the expression identical to the approved architecture §7.2.
    // eslint-disable-next-line no-useless-escape
    return /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,79}$/.test(id);
}
export function isUUID(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import type { Request } from './protocol.js';
export class ValidationError extends Error {
    readonly code = 'INVALID_REQUEST';
}
export function isTitle(value: unknown): value is string {
    return typeof value === 'string' && [...value].length >= 1 && [...value].length <= 60 && !/[\p{C}]/u.test(value);
}
export function isSize(cols: unknown, rows: unknown): boolean {
    return typeof cols === 'number' && Number.isInteger(cols) && cols >= 2 && cols <= 1000 && typeof rows === 'number' && Number.isInteger(rows) && rows >= 1 && rows <= 500;
}
export async function validCwd(value: unknown): Promise<boolean> {
    if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0') || value.length > 4096)
        return false;
    try {
        return (await stat(value)).isDirectory();
    }
    catch (error) {
        if (error instanceof Error && 'code' in error && ['ENOENT', 'ENOTDIR'].includes(String(error.code)))
            return false;
        throw error;
    }
}
export async function validateRequest(value: unknown): Promise<Request> {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new ValidationError('Expected a request object');
    const v = value as Record<string, unknown>;
    if (!isUUID(v.id) || typeof v.kind !== 'string')
        throw new ValidationError('Request needs a UUID id and kind');
    let fields: string[];
    switch (v.kind) {
        case 'hello':
            fields = ['protocol', 'version'];
            if (!Number.isSafeInteger(v.protocol) || typeof v.version !== 'string' || !/^[A-Za-z0-9._-]{1,40}$/.test(v.version))
                throw new ValidationError('Invalid hello');
            break;
        case 'sessions.list':
            fields = [];
            break;
        case 'sessions.create':
            fields = ['engine', 'cwd', 'title'];
            if (v.engine !== 'shell' || !(await validCwd(v.cwd)) || (v.title !== undefined && !isTitle(v.title)))
                throw new ValidationError('Only internal shell sessions with an existing absolute cwd are supported');
            break;
        case 'sessions.preview':
            fields = ['sessionId'];
            if (v.sessionId !== null && !isUUID(v.sessionId))
                throw new ValidationError('Invalid session UUID');
            break;
        case 'sessions.stop':
        case 'sessions.remove':
        case 'sessions.rename':
            fields = v.kind === 'sessions.rename' ? ['sessionId', 'title'] : ['sessionId'];
            if (!isUUID(v.sessionId) || (v.kind === 'sessions.rename' && !isTitle(v.title)))
                throw new ValidationError('Invalid session UUID or title');
            break;
        case 'layout.previewSize':
            fields = ['cols', 'rows'];
            if (!isSize(v.cols, v.rows))
                throw new ValidationError('Size must be 2–1000 cols and 1–500 rows');
            break;
        default: throw new ValidationError('Unknown request kind');
    }
    if (Object.keys(v).some(key => !['id', 'kind', ...fields].includes(key)))
        throw new ValidationError('Unexpected request field');
    return v as Request;
}

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
import type { Request, SuccessResponse } from './protocol.js';
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
        case 'sessions.attach':
        case 'sessions.resize':
            fields=['sessionId','cols','rows'];
            if(!isUUID(v.sessionId)||!isSize(v.cols,v.rows))throw new ValidationError('Invalid session UUID or size');
            break;
        case 'sessions.preview':
            fields = ['sessionId'];
            if (v.sessionId !== null && !isUUID(v.sessionId))
                throw new ValidationError('Invalid session UUID');
            break;
        case 'sessions.detach':
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

export function validateSuccess(value: unknown): SuccessResponse {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid daemon response');
    const v=value as Record<string,unknown>;
    if(!isUUID(v.id)||v.ok!==true)throw new ValidationError('Invalid daemon response');
    if(v.kind!==undefined && (v.kind!=='hello'||v.protocol!==1||typeof v.version!=='string'||!/^[A-Za-z0-9._-]{1,40}$/.test(v.version)||!Number.isSafeInteger(v.daemonPid)||Number(v.daemonPid)<2))throw new ValidationError('Invalid daemon hello');
    if(v.snapshot!==undefined&&(typeof v.snapshot!=='string'||!isSize(v.cols,v.rows)))throw new ValidationError('Invalid daemon snapshot');
    if(v.modes!==undefined)validateModes(v.modes);
    const session=(x:unknown)=>{if(!x||typeof x!=='object')return false;const s=x as Record<string,unknown>;return isUUID(s.id)&&isTitle(s.title)&&s.engine==='shell'&&typeof s.cwd==='string'&&isAbsolute(s.cwd)&&['starting','running','exited','error'].includes(String(s.status))&&(s.exitCode===null||Number.isSafeInteger(s.exitCode));};
    if(v.session!==undefined&&!session(v.session))throw new ValidationError('Invalid daemon session');
    if(v.sessions!==undefined&&(!Array.isArray(v.sessions)||!v.sessions.every(session)))throw new ValidationError('Invalid daemon sessions');
    return v as unknown as SuccessResponse;
}

export function validateModes(value:unknown):import('./protocol.js').TerminalModes {
    if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid terminal modes');
    const m=value as Record<string,unknown>;
    for(const key of ['applicationCursorKeys','applicationKeypad','bracketedPaste','focusEvents','cursorVisible'])if(typeof m[key]!=='boolean')throw new ValidationError('Invalid terminal modes');
    if(!['none','x10','vt200','drag','any'].includes(String(m.mouseTracking))||!['default','utf8','sgr','urxvt'].includes(String(m.mouseEncoding)))throw new ValidationError('Invalid terminal modes');
    return m as unknown as import('./protocol.js').TerminalModes;
}

export function validateExitCode(value:unknown):number|undefined {
    if(value===null)return undefined;
    if(typeof value!=='number'||!Number.isSafeInteger(value))throw new ValidationError('Invalid session exit code');
    return value;
}

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
import { stripVTControlCharacters } from 'node:util';
import type { Request, SuccessResponse } from './protocol.js';
export class ValidationError extends Error {
    readonly code = 'INVALID_REQUEST';
}
export function warningText(value: string): string {
    // Strip whole escape sequences as well as individual controls before drawing.
    return [...stripVTControlCharacters(value).replace(/[\p{C}]/gu, '')].slice(0, 200).join('');
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
        case 'settings.get':
            fields = [];
            break;
        case 'settings.set':
            fields = ['patch'];
            validateSettingsPatch(v.patch, true);
            break;
        case 'engines.status':
        case 'sessions.list':
            fields = [];
            break;
        case 'sessions.create':
            fields = v.engine === 'shell' ? ['engine','cwd','title'] : ['engine','model','auth','cwd','permission','title','firstMessage'];
            if (!(await validCwd(v.cwd))) throw new ValidationError('Folder must be an existing absolute directory');
            if (v.engine !== 'shell' && (!isAgentEngine(v.engine) || !isModel(v.model) || !isAccount(v.auth) || !isPermission(v.permission) || (v.firstMessage !== undefined && (typeof v.firstMessage !== 'string' || Buffer.byteLength(v.firstMessage) > 16384 || v.firstMessage.includes('\0'))))) throw new ValidationError('Invalid account agent request');
            if (v.title !== undefined) { if (typeof v.title !== 'string') throw new ValidationError('Invalid title'); v.title = sanitizeTitle(v.title); if (!isTitle(v.title)) throw new ValidationError('Invalid title'); }
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
    if(v.settings!==undefined)validateSettings(v.settings);
    if(v.engines!==undefined) { if (!v.engines || typeof v.engines !== 'object' || !('claudeCode' in v.engines) || !('codex' in v.engines)) throw new ValidationError('Invalid engines status'); validateEngineStatus(v.engines.claudeCode); validateEngineStatus(v.engines.codex); }
    if(v.modes!==undefined)validateModes(v.modes);
    const session=(x:unknown)=>{try{validateSession(x);return true;}catch{return false;}};
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

export function isThemeName(value: unknown): value is import('./protocol.js').ThemeName {
    return typeof value === 'string' && ['graphite', 'slate', 'ink', 'auto', 'light'].includes(value);
}
export function isAgentEngine(value: unknown): value is import('./protocol.js').AgentEngine { return value === 'claude-code' || value === 'codex'; }
export function isModel(value: unknown): value is string | null { return value === null || typeof value === 'string' && isValidModelId(value); }
export function isPermission(value: unknown): value is import('./protocol.js').Permission { return value === 'ask' || value === 'dontAsk'; }
function isAccount(value: unknown): boolean { return !!value && typeof value === 'object' && Object.keys(value).length === 1 && 'kind' in value && value.kind === 'account'; }
export function sanitizeTitle(value: string): string { return [...stripVTControlCharacters(value).replace(/[\p{C}]/gu, '').trim()].slice(0,60).join(''); }
export function validateSettingsPatch(value: unknown, patchOnly = false): import('./protocol.js').SettingsPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected settings patch');
    const v = value as Record<string,unknown>;
    if (patchOnly && Object.keys(v).some(k=>!['theme','defaultEngine','defaultModel','defaultCwd','permission'].includes(k))) throw new ValidationError('Unknown settings patch field');
    if (!Object.keys(v).length || Object.keys(v).some(k => ['__proto__','prototype','constructor'].includes(k)) ||
        v.theme !== undefined && !isThemeName(v.theme) || v.defaultEngine !== undefined && !isAgentEngine(v.defaultEngine) ||
        v.defaultModel !== undefined && !isModel(v.defaultModel) || v.permission !== undefined && v.permission !== 'ask' ||
        v.defaultCwd !== undefined && (typeof v.defaultCwd !== 'string' || !isAbsolute(v.defaultCwd) || v.defaultCwd.includes('\0')) || JSON.stringify(v).length > 16384) throw new ValidationError('Invalid settings patch; permission default must be ask');
    return {...v};
}
export function validateSettings(value: unknown): import('./protocol.js').Settings {
    const v = validateSettingsPatch(value);
    if (!isThemeName(v.theme)) throw new ValidationError('Invalid settings theme');
    return {...v,theme:v.theme};
}
export function validateEngineStatus(value:unknown): import('./protocol.js').EngineStatus {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid engine status');
    const v=value as Record<string,unknown>;
    if (Object.keys(v).some(k=>!['installed','path','version','loggedIn','authMethod'].includes(k)) || typeof v.installed !== 'boolean' || !(v.path === null || typeof v.path === 'string' && isAbsolute(v.path)) || !(v.version === null || typeof v.version === 'string' && /^[A-Za-z0-9.-]{1,80}$/.test(v.version)) || !(v.loggedIn === null || typeof v.loggedIn === 'boolean') || !['subscription','api-key','unknown'].includes(String(v.authMethod))) throw new ValidationError('Invalid engine status');
    return {installed:v.installed,path:v.path as string|null,version:v.version as string|null,loggedIn:v.loggedIn as boolean|null,authMethod:v.authMethod as import('./protocol.js').AuthMethod};
}
export function validateSession(value: unknown): import('./protocol.js').SessionInfo {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid daemon session');
    const s = value as Record<string, unknown>;
    const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
    if (!isUUID(s.id) || !isTitle(s.title) || (typeof s.engine !== 'string' || !['shell', 'claude-code', 'codex'].includes(s.engine)) ||
        !isModel(s.model) || typeof s.cwd !== 'string' || !isAbsolute(s.cwd) || s.cwd.includes('\0') ||
        !isAccount(s.auth) || !isPermission(s.permission) ||
        (typeof s.status !== 'string' || !['starting', 'running', 'waiting', 'done', 'idle', 'exited', 'error'].includes(s.status)) ||
        typeof s.statusDetail !== 'string' || s.statusDetail.length > 4096 || !date(s.statusSince) || !date(s.createdAt) ||
        !(s.lastOutputAt === null || date(s.lastOutputAt)) || s.ctxPercent !== null ||
        !(s.exitCode === null || Number.isSafeInteger(s.exitCode)) || s.authMethod !== undefined && !['subscription','api-key','unknown'].includes(String(s.authMethod))) throw new ValidationError('Invalid daemon session');
    return s as unknown as import('./protocol.js').SessionInfo;
}

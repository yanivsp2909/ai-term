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
        case 'keys.list': fields=[]; break;
        case 'keys.add':
            fields=['provider','label','secret','endpoint','deployments'];
            if (!isKeyProvider(v.provider) || !isTitle(v.label) || !isSecret(v.secret) || v.endpoint !== undefined && !isEndpoint(v.endpoint) || v.deployments !== undefined && !isDeployments(v.deployments) || v.provider === 'foundry' && (!isEndpoint(v.endpoint) || !isDeployments(v.deployments) || !v.deployments.length)) throw new ValidationError('Invalid key details');
            break;
        case 'keys.remove': case 'keys.test':
            fields=['keyId']; if (!isUUID(v.keyId)) throw new ValidationError('Invalid key id'); break;
        case 'keys.scanEnvFile': case 'keys.importEnv':
            fields=v.kind==='keys.scanEnvFile'?['path']:['path','names'];
            if (typeof v.path !== 'string' || !isAbsolute(v.path) || v.path.includes('\0') || v.path.length>4096 || v.kind==='keys.importEnv' && (!Array.isArray(v.names) || !v.names.length || v.names.length>Object.keys(ENV_KEY_NAMES).length || v.names.some(n=>typeof n!=='string'||!Object.hasOwn(ENV_KEY_NAMES,n)) || new Set(v.names).size!==v.names.length)) throw new ValidationError('Invalid env import selection');
            break;
        case 'usage.summary':case 'usage.diagnostics':
        case 'engines.status':
        case 'sessions.list':
            fields = [];
            break;
        case 'sessions.create':
            fields = v.engine === 'shell' ? ['engine','cwd','title'] : ['engine','model','effort','auth','cwd','permission','title','firstMessage','login'];
            if (!(await validCwd(v.cwd))) throw new ValidationError('Folder must be an existing absolute directory');
            if (v.engine !== 'shell' && (!isAgentEngine(v.engine) || !isModel(v.model) || !isAuthRef(v.auth) || !isPermissionForEngine(v.engine,v.permission) || v.effort !== undefined && !isEffortForEngine(v.engine,v.effort) || (v.firstMessage !== undefined && (typeof v.firstMessage !== 'string' || Buffer.byteLength(v.firstMessage) > 16384 || v.firstMessage.includes('\0'))))) throw new ValidationError('Invalid account agent request');
            if (v.login !== undefined && (v.login !== true || v.model!==null || !isAccount(v.auth) || v.permission !== 'ask' || v.firstMessage !== undefined || v.effort !== undefined)) throw new ValidationError('Invalid login session');
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
        case 'sessions.resume':
        case 'sessions.text':
        case 'sessions.rename':
            fields = v.kind === 'sessions.rename' ? ['sessionId', 'title'] : ['sessionId'];
            if (!isUUID(v.sessionId) || (v.kind === 'sessions.rename' && !isTitle(v.title)))
                throw new ValidationError('Invalid session UUID or title');
            break;
        case 'usage.subscribe':
        case 'system.subscribe':
            fields = ['on'];
            if (typeof v.on !== 'boolean') throw new ValidationError('system.subscribe needs on: boolean');
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
    if(v.copy!==undefined)validateSessionText(v.copy);
    if(v.usage!==undefined)validateUsageSummary(v.usage);
    if(v.usageDiagnostics!==undefined)validateUsageDiagnostics(v.usageDiagnostics);
    if(v.key!==undefined)validateKeyView(v.key);
    if(v.keys!==undefined){if(!Array.isArray(v.keys)||v.keys.length>100)throw new ValidationError('Invalid keys');v.keys.forEach(validateKeyView);}
    if(v.results!==undefined)validateDeploymentTests(v.results);
    if(v.found!==undefined){if(!Array.isArray(v.found)||v.found.some(f=>!f||typeof f!=='object'||Object.keys(f).some(k=>!['name','provider'].includes(k))||!Object.hasOwn(ENV_KEY_NAMES,String(f.name))||ENV_KEY_NAMES[f.name as string]!==f.provider))throw new ValidationError('Invalid env names');}
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
export function isPermission(value: unknown): value is import('./protocol.js').Permission { return value === 'ask' || value === 'auto' || value === 'dontAsk'; }

// Installed Claude help and Codex rust-v0.160.1 ReasoningEffort/config define these values.
export const EFFORT_LEVELS:Record<import('./protocol.js').AgentEngine,readonly import('./protocol.js').Effort[]>={
 'claude-code':['low','medium','high','xhigh','max'],
 codex:['none','minimal','low','medium','high','xhigh','max','ultra','persistent'],
};
export function isEffort(value:unknown):value is import('./protocol.js').Effort|null{return value===null||typeof value==='string'&&EFFORT_LEVELS.codex.includes(value as import('./protocol.js').Effort);}
export function isEffortForEngine(engine:unknown,value:unknown):value is import('./protocol.js').Effort|null{return isAgentEngine(engine)&&isEffort(value)&&(value===null||EFFORT_LEVELS[engine].includes(value));}
export function isPermissionForEngine(engine:unknown,value:unknown):value is import('./protocol.js').Permission{return isAgentEngine(engine)&&isPermission(value)&&(value!=='auto'||engine==='claude-code');}
function isAccount(value: unknown): boolean { return !!value && typeof value === 'object' && Object.keys(value).length === 1 && 'kind' in value && value.kind === 'account'; }
export function sanitizeTitle(value: string): string { return [...stripVTControlCharacters(value).replace(/[\p{C}]/gu, '').trim()].slice(0,60).join(''); }
export function validateSettingsPatch(value: unknown, patchOnly = false): import('./protocol.js').SettingsPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected settings patch');
    const v = value as Record<string,unknown>;
    if (patchOnly && Object.keys(v).some(k=>!['theme','defaultEngine','defaultModel','defaultEffort','defaultCwd','permission','budgets','priceOverrides'].includes(k))) throw new ValidationError('Unknown settings patch field');
    if (!Object.keys(v).length || Object.keys(v).some(k => ['__proto__','prototype','constructor'].includes(k)) ||
        v.theme !== undefined && !isThemeName(v.theme) || v.defaultEngine !== undefined && !isAgentEngine(v.defaultEngine) ||
        v.defaultModel !== undefined && !isModel(v.defaultModel) || v.defaultEffort !== undefined && !isEffort(v.defaultEffort) || v.permission !== undefined && v.permission !== 'ask' ||
        v.defaultCwd !== undefined && (typeof v.defaultCwd !== 'string' || !isAbsolute(v.defaultCwd) || v.defaultCwd.includes('\0')) || JSON.stringify(v).length > 16384) throw new ValidationError('Invalid settings patch; permission default must be ask');
    if(v.budgets!==undefined)validateBudgets(v.budgets);
    if(v.priceOverrides!==undefined)validatePriceOverrides(v.priceOverrides);
    return {...v};
}
export function validateSettings(value: unknown): import('./protocol.js').Settings {
    const v = validateSettingsPatch(value);
    if(v.keys!==undefined){if(!Array.isArray(v.keys)||v.keys.length>100)throw new ValidationError('Invalid key metadata');v.keys.forEach(validateKeyView);}
    if(v.defaultEffort!==undefined&&!isEffortForEngine(v.defaultEngine??'claude-code',v.defaultEffort))throw new ValidationError('Effort unavailable for default engine');
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
        !isAuthView(s.auth) || !(s.engine==='shell'?s.permission==='ask':isPermissionForEngine(s.engine,s.permission)) || s.effort!==undefined && !isEffortForEngine(s.engine,s.effort) || s.conversationId!==undefined && (s.engine!=='claude-code'||!isUUID(s.conversationId)) ||
        (typeof s.status !== 'string' || !['starting', 'running', 'waiting', 'done', 'idle', 'exited', 'error'].includes(s.status)) ||
        typeof s.statusDetail !== 'string' || s.statusDetail.length > 4096 || !date(s.statusSince) || !date(s.createdAt) ||
        !(s.lastOutputAt === null || date(s.lastOutputAt)) || s.ctxPercent !== null ||
        !(s.exitCode === null || Number.isSafeInteger(s.exitCode)) || s.authMethod !== undefined && !['subscription','api-key','unknown'].includes(String(s.authMethod))) throw new ValidationError('Invalid daemon session');
    return s as unknown as import('./protocol.js').SessionInfo;
}
// Exact keys only, so nothing but these numbers can ever ride along (no process names or users).
const MAX_STATS_SESSIONS = 1000;
function isAmount(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function isShare(value: unknown): value is number { return isAmount(value) && value <= 100; }
function hasOnly(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).every(key => keys.includes(key)) && keys.every(key => key in value); }
export function validateSystemStats(value: unknown): import('./protocol.js').SystemStats {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid system stats');
    const v = value as Record<string, unknown>;
    if (!hasOnly(v, ['cpuPercent', 'memUsedBytes', 'memTotalBytes', 'netRxBytesPerSec', 'netTxBytesPerSec', 'sessions']) || !isShare(v.cpuPercent) || !isAmount(v.memUsedBytes) || !isAmount(v.memTotalBytes) || v.memUsedBytes > v.memTotalBytes ||
        !isAmount(v.netRxBytesPerSec) || !isAmount(v.netTxBytesPerSec) || !Array.isArray(v.sessions) || v.sessions.length > MAX_STATS_SESSIONS) throw new ValidationError('Invalid system stats');
    for (const session of v.sessions as unknown[]) {
        if (!session || typeof session !== 'object' || Array.isArray(session)) throw new ValidationError('Invalid session stats');
        const s = session as Record<string, unknown>;
        if (!hasOnly(s, ['sessionId', 'cpuPercent', 'rssBytes']) || !isUUID(s.sessionId) || !isShare(s.cpuPercent) || !isAmount(s.rssBytes)) throw new ValidationError('Invalid session stats');
    }
    return v as unknown as import('./protocol.js').SystemStats;
}

export const ENV_KEY_NAMES: Record<string, import('./protocol.js').KeyProvider> = {ANTHROPIC_API_KEY:'anthropic',OPENAI_API_KEY:'openai',AZURE_OPENAI_API_KEY:'foundry',AITERM_FOUNDRY_KEY:'foundry'};
export function isKeyProvider(v:unknown): v is import('./protocol.js').KeyProvider {return v==='anthropic'||v==='foundry'||v==='openai';}
export function isSecret(v:unknown): v is string {return typeof v==='string' && v.length>0 && v.length<=512 && !/[\s\p{C}]/u.test(v);}
export function isEndpoint(v:unknown): v is string {
    if(typeof v!=='string'||v.length>2048||/[\s"'\\\p{C}]/u.test(v))return false;
    try{const u=new URL(v);return u.protocol==='https:'&&!!u.hostname&&!u.username&&!u.password&&!u.search&&!u.hash;}catch{return false;}
}
function isDeployments(v:unknown):v is string[]{return Array.isArray(v)&&v.length<=40&&v.every(m=>typeof m==='string'&&isValidModelId(m))&&new Set(v).size===v.length;}
export function isAuthRef(v:unknown):v is import('./protocol.js').AuthRef {return isAccount(v)||!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===2&&'kind'in v&&v.kind==='key'&&'keyId'in v&&isUUID(v.keyId);}
function isAuthView(v:unknown):boolean {
    if(isAccount(v))return true;
    if(!v||typeof v!=='object'||Array.isArray(v))return false;
    const a=v as Record<string,unknown>;
    return Object.keys(a).length===5&&a.kind==='key'&&isUUID(a.keyId)&&isKeyProvider(a.provider)&&isTitle(a.keyLabel)&&typeof a.last4==='string'&&a.last4.length<=4&&!/[\p{C}]/u.test(a.last4);
}
export function validateDeploymentTests(v:unknown):import('./protocol.js').DeploymentTest[]{
    if(!Array.isArray(v)||v.length>40||v.some(r=>!r||typeof r!=='object'||Object.keys(r).some(k=>!['model','status','httpStatus','errorCode'].includes(k))||typeof r.model!=='string'||!isValidModelId(r.model)||!['ready','not a chat model','error'].includes(r.status)||r.httpStatus!==undefined&&(!Number.isInteger(r.httpStatus)||r.httpStatus<100||r.httpStatus>599)||r.errorCode!==undefined&&(typeof r.errorCode!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(r.errorCode))))throw new ValidationError('Invalid deployment results');
    return v as import('./protocol.js').DeploymentTest[];
}
export function validateKeyView(v:unknown):import('./protocol.js').KeyView {
    if(!v||typeof v!=='object'||Array.isArray(v))throw new ValidationError('Invalid key metadata');
    const k=v as Record<string,unknown>;
    if(Object.keys(k).some(n=>!['id','provider','label','last4','endpoint','deployments','lastTest'].includes(n))||!isUUID(k.id)||!isKeyProvider(k.provider)||!isTitle(k.label)||typeof k.last4!=='string'||k.last4.length>4||/[\p{C}]/u.test(k.last4)||k.endpoint!==undefined&&!isEndpoint(k.endpoint)||k.deployments!==undefined&&!isDeployments(k.deployments))throw new ValidationError('Invalid key metadata');
    if(k.provider==='foundry'&&(!isEndpoint(k.endpoint)||!isDeployments(k.deployments)||!k.deployments.length))throw new ValidationError('Invalid Foundry metadata');
    if(k.lastTest!==undefined)validateDeploymentTests(k.lastTest);
    return k as unknown as import('./protocol.js').KeyView;
}

export function validateBudgets(v:unknown):import('./protocol.js').Budgets{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['daily','weekly','monthly'].includes(k)))throw new ValidationError('Invalid budgets');
 const b=v as Record<string,unknown>;for(const amount of Object.values(b))if(amount!==null&&(!isAmount(amount)||amount>1e9))throw new ValidationError('Invalid budget amount');
 return {daily:b.daily as number|null??null,weekly:b.weekly as number|null??null,monthly:b.monthly as number|null??null};
}
export function validatePriceOverrides(v:unknown):Record<string,import('./protocol.js').ModelPrice>{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).length>100)throw new ValidationError('Invalid price overrides');
 for(const [model,value]of Object.entries(v)){if(!isValidModelId(model)||!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid model price');const p=value as Record<string,unknown>;if(Object.keys(p).some(k=>!['input','output','cacheRead'].includes(k))||!isAmount(p.input)||!isAmount(p.output)||p.cacheRead!==undefined&&!isAmount(p.cacheRead)||Object.values(p).some(n=>typeof n==='number'&&n>1e9))throw new ValidationError('Invalid model price');}
 return v as Record<string,import('./protocol.js').ModelPrice>;
}
export function validateUsageRecord(v:unknown):import('./protocol.js').UsageRecord{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ValidationError('Invalid usage record');const r=v as Record<string,unknown>;
 if(Object.keys(r).some(k=>!['ts','sessionId','provider','model','inputTokens','outputTokens','cachedTokens','costUsd','costSource'].includes(k))||typeof r.ts!=='string'||!Number.isFinite(Date.parse(r.ts))||!isUUID(r.sessionId)||!isKeyProvider(r.provider)||typeof r.model!=='string'||!isValidModelId(r.model)||!Number.isSafeInteger(r.inputTokens)||!isAmount(r.inputTokens)||!Number.isSafeInteger(r.outputTokens)||!isAmount(r.outputTokens)||r.cachedTokens!==undefined&&(!Number.isSafeInteger(r.cachedTokens)||!isAmount(r.cachedTokens))||r.costUsd!==null&&!isAmount(r.costUsd)||!['cli-estimate','price-table'].includes(String(r.costSource)))throw new ValidationError('Invalid usage record');
 return r as unknown as import('./protocol.js').UsageRecord;
}
export function validateUsageSummary(v:unknown):import('./protocol.js').UsageSummary{
 if(!v||typeof v!=='object'||Array.isArray(v)||!hasOnly(v as Record<string,unknown>,['today','week','month']))throw new ValidationError('Invalid usage summary');
 const total=(t:unknown,provider=false)=>{if(!t||typeof t!=='object'||Array.isArray(t))throw new ValidationError('Invalid usage total');const r=t as Record<string,unknown>;if(!hasOnly(r,provider?['provider','costUsd','tokens','unknownPrice']:['costUsd','tokens','unknownPrice','providers'])||!isAmount(r.costUsd)||!Number.isSafeInteger(r.tokens)||!isAmount(r.tokens)||typeof r.unknownPrice!=='boolean'||provider&&!isKeyProvider(r.provider))throw new ValidationError('Invalid usage total');};
 for(const p of Object.values(v)){total(p);const providers=(p as {providers:unknown}).providers;if(!Array.isArray(providers)||providers.length>3)throw new ValidationError('Invalid usage providers');for(const entry of providers)total(entry,true);}
 return v as import('./protocol.js').UsageSummary;
}
export function validateUsageDiagnostics(v:unknown):import('./protocol.js').UsageDiagnostics{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ValidationError('Invalid usage diagnostics');const d=v as Record<string,unknown>;if(!hasOnly(d,['port','sessions'])||!Number.isInteger(d.port)||Number(d.port)<1||Number(d.port)>65535||!Array.isArray(d.sessions)||d.sessions.length>1000)throw new ValidationError('Invalid usage diagnostics');
 for(const raw of d.sessions){if(!raw||typeof raw!=='object'||!hasOnly(raw,['sessionId','at','values'])||!isUUID(raw.sessionId)||typeof raw.at!=='string'||!Number.isFinite(Date.parse(raw.at))||!Array.isArray(raw.values)||raw.values.length>20)throw new ValidationError('Invalid usage diagnostic');for(const val of raw.values)if(!val||typeof val!=='object'||!hasOnly(val,['name','value'])||typeof val.name!=='string'||! /^(?:input_token_count|output_token_count|cached_token_count|reasoning_token_count|claude_code\.token\.usage\.(?:input|output|cacheRead|cacheCreation)|claude_code\.cost\.usage\.cost)$/.test(val.name)||!isAmount(val.value))throw new ValidationError('Invalid usage attribute');}
 return v as unknown as import('./protocol.js').UsageDiagnostics;
}

export function validateSessionText(value:unknown):import('./protocol.js').SessionText & {more?:boolean}{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid session text');const v=value as Record<string,unknown>;
 // Only newline survives among C0/C1 controls; terminal escape sequences cannot reach the clipboard.
 if(Object.keys(v).some(k=>!['sessionId','text','truncated','more'].includes(k))||!isUUID(v.sessionId)||typeof v.text!=='string'||Buffer.byteLength(v.text)>5*1024*1024||/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/u.test(v.text)||typeof v.truncated!=='boolean'||v.more!==undefined&&typeof v.more!=='boolean')throw new ValidationError('Invalid session text');
 return v as unknown as import('./protocol.js').SessionText & {more?:boolean};
}

import { MCP_MAX_SERVERS, MCP_MAX_TOOLS, mcpTokens, type McpConfig, type McpServer, type McpCatalog, type McpRequest } from './mcp.js';
import { isExtensionId, EXTENSION_MAX_ITEMS, EXTENSION_FILE_BYTES, EXTENSION_DESCRIPTION_CHARS, catalogTokens, type ExtensionCatalog, type ExtensionFile } from './extensions.js';
import { isAgentCaps } from './agent-facts.js';
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
import {MAX_COPY_BYTES, MAX_SEND_BYTES, MAX_FIND_CHARS, MAX_FIND_RESULTS, FIND_LINE_CHARS, type FindMatch, type Request, type SuccessResponse } from './protocol.js';
export class ValidationError extends Error {
    readonly code = 'INVALID_REQUEST';
}
export const MAX_FIRST_MESSAGE_BYTES = 16 * 1024;
export function isFirstMessage(value: unknown): value is string {
    return typeof value === 'string' && Buffer.byteLength(value) <= MAX_FIRST_MESSAGE_BYTES && !value.includes('\0');
}
export function warningText(value: string): string {
    // Strip whole escape sequences as well as individual controls before drawing.
    return [...stripVTControlCharacters(value).replace(/[\p{C}]/gu, '')].slice(0, 200).join('');
}
// /send keeps newlines and nothing else from C0/C1: no escape can end its bracketed paste early or press a key.
// eslint-disable-next-line no-control-regex -- the controls are the point.
const SEND_CONTROLS = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g;
export function cleanSendText(text: string): string { return text.replace(/\r\n?/g, '\n').replace(SEND_CONTROLS, ''); }
export function isSendText(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && Buffer.byteLength(value) <= MAX_SEND_BYTES && cleanSendText(value) === value;
}
export function isFindQuery(value: unknown): value is string {
    return typeof value === 'string' && value.trim() !== '' && [...value].length <= MAX_FIND_CHARS && !/[\p{C}]/u.test(value);
}
export function validateFindMatches(value: unknown): FindMatch[] {
    if (!Array.isArray(value) || value.length > MAX_FIND_RESULTS) throw new Error('Invalid find results');
    return value.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid find results');
        const m = entry as Record<string, unknown>;
        const whole = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
        if (Object.keys(m).some(k => !['sessionId', 'fromEnd', 'text', 'start', 'length'].includes(k)) || !isUUID(m.sessionId) || !whole(m.fromEnd) || m.fromEnd > 1_000_000
            || typeof m.text !== 'string' || m.text.length > FIND_LINE_CHARS * 2 + MAX_FIND_CHARS * 2 || /[\p{C}]/u.test(m.text)
            || !whole(m.start) || !whole(m.length) || m.length < 1 || m.start + m.length > m.text.length) throw new Error('Invalid find results');
        return { sessionId: m.sessionId, fromEnd: m.fromEnd, text: m.text, start: m.start, length: m.length };
    });
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
            if(v.refreshNotifications!==undefined&&typeof v.refreshNotifications!=='boolean')throw new ValidationError('Invalid notification refresh');
            fields = ['refreshNotifications'];
            break;
        case 'settings.set':
            fields = ['patch'];
            validateSettingsPatch(v.patch, true);
            break;
        case 'extensions.list': case 'extensions.read': case 'extensions.toggle':
            fields = v.kind === 'extensions.list' ? ['cwd'] : v.kind === 'extensions.read' ? ['cwd','extensionId'] : ['cwd','extensionId','enabled'];
            validateExtensionRequest(v); break;
        case 'mcp.list': case 'mcp.add': case 'mcp.remove': case 'mcp.toggle': case 'mcp.approve': case 'mcp.discover': case 'mcp.schema': case 'mcp.call': case 'mcp.cancel': case 'mcp.stop':
            fields = validateMcpRequest(v); break;
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
        case 'worktrees.preview':
            fields=['cwd','title'];
            if(!(await validCwd(v.cwd))||!isTitle(v.title))throw new ValidationError('Invalid worktree preview');
            break;
        case 'worktrees.list': fields=[]; break;
        case 'worktrees.check': case 'worktrees.delete':
            fields=v.kind==='worktrees.check'?['path']:['path','fingerprint','confirm'];
            if(!isSafeAbsolutePath(v.path)||v.kind==='worktrees.delete'&&(!isFingerprint(v.fingerprint)||v.confirm!==undefined&&!isWorktreeBranch(v.confirm)))throw new ValidationError('Invalid worktree request');
            break;
        case 'sessions.create':
            fields = v.engine === 'shell' ? ['engine','cwd','title'] : ['engine','model','effort','auth','cwd','permission','title','firstMessage','login'];
            if (!(await validCwd(v.cwd))) throw new ValidationError('Folder must be an existing absolute directory');
            if (v.engine !== 'shell' && (!isAgentEngine(v.engine) || !isModel(v.model) || !isAuthRef(v.auth) || !isPermissionForEngine(v.engine,v.permission) || v.effort !== undefined && !isEffortForEngine(v.engine,v.effort) || (v.firstMessage !== undefined && !isFirstMessage(v.firstMessage)))) throw new ValidationError('Invalid account agent request');
            if (v.engine === 'ai-term' && (!v.auth || typeof v.auth !== 'object' || !('kind' in v.auth) || v.auth.kind !== 'key' || v.login !== undefined)) throw new ValidationError('AI Term agent needs an API key');
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
        case 'sessions.text':
            fields=['sessionId','lastReply'];if(!isUUID(v.sessionId)||v.lastReply!==undefined&&typeof v.lastReply!=='boolean')throw new ValidationError('Invalid session UUID');break;
        case 'sessions.send':
            fields=['sessionId','text'];if(!isUUID(v.sessionId)||!isSendText(v.text))throw new ValidationError('Invalid send request');break;
        case 'sessions.find':
            fields=['text'];if(!isFindQuery(v.text))throw new ValidationError('Invalid find request');break;
        case 'sessions.detach':
        case 'sessions.stop':
        case 'sessions.remove':
        case 'sessions.resume':
        case 'sessions.retry':
        case 'sessions.rename':
            fields = v.kind === 'sessions.rename' ? ['sessionId', 'title'] : ['sessionId'];
            if (!isUUID(v.sessionId) || (v.kind === 'sessions.rename' && !isTitle(v.title)))
                throw new ValidationError('Invalid session UUID or title');
            break;
        case 'clicks.subscribe':
            fields=['on','terminal'];
            if(typeof v.on!=='boolean'||v.terminal!==undefined&&!isTerminalBundle(v.terminal))throw new ValidationError('Invalid click subscription');
            break;
        case 'usage.subscribe':
        case 'system.subscribe':
            fields = ['on'];
            if (typeof v.on !== 'boolean') throw new ValidationError(`${v.kind} needs on: boolean`);
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
    if(v.worktreePreview!==undefined)validateWorktreePreview(v.worktreePreview);
    if(v.keptWorktree!==undefined&&!isSafeAbsolutePath(v.keptWorktree))throw new ValidationError('Invalid kept worktree');
    if(v.deletedWorktree!==undefined&&!isSafeAbsolutePath(v.deletedWorktree))throw new ValidationError('Invalid deleted worktree');
    if(v.worktree!==undefined)validateWorktreeView(v.worktree);
    if(v.worktrees!==undefined){if(!Array.isArray(v.worktrees)||v.worktrees.length>500)throw new ValidationError('Invalid worktrees');v.worktrees.forEach(validateWorktreeView);}
    if(v.mcp!==undefined)validateMcpCatalog(v.mcp);
    if(v.mcpSchema!==undefined)validateMcpObject(v.mcpSchema);
    if(v.mcpResult!==undefined&&(typeof v.mcpResult!=='string'||Buffer.byteLength(v.mcpResult)>64*1024))throw new ValidationError('Invalid MCP result');
    if(v.extensions!==undefined)validateExtensionCatalog(v.extensions);
    if(v.extension!==undefined)validateExtensionFile(v.extension);
    if(v.settings!==undefined)validateSettings(v.settings);
    if(v.engines!==undefined) { if (!v.engines || typeof v.engines !== 'object' || !('claudeCode' in v.engines) || !('codex' in v.engines)) throw new ValidationError('Invalid engines status'); validateEngineStatus(v.engines.claudeCode); validateEngineStatus(v.engines.codex); }
    if(v.notifier!==undefined&&!['ready','not built','launch failed'].includes(String(v.notifier)))throw new ValidationError('Invalid notifier state');
    if(v.notificationPermission!==undefined&&!['allowed','denied','not-asked','unknown'].includes(String(v.notificationPermission)))throw new ValidationError('Invalid notification permission');
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
    if(m.cursorShape!==undefined&&(!Number.isInteger(m.cursorShape)||Number(m.cursorShape)<0||Number(m.cursorShape)>6))throw new ValidationError('Invalid cursor shape');
    if(m.title!==undefined&&(typeof m.title!=='string'||m.title.length>1024||/[\p{C}\p{Zl}\p{Zp}]/u.test(m.title)))throw new ValidationError('Invalid terminal title');
    if(m.kittyFlags!==undefined&&(!Array.isArray(m.kittyFlags)||m.kittyFlags.length<1||m.kittyFlags.length>64||m.kittyFlags.some(v=>!Number.isInteger(v)||v<0||v>31)))throw new ValidationError('Invalid kitty flags');
    if(m.themeReports!==undefined&&typeof m.themeReports!=='boolean')throw new ValidationError('Invalid theme reports');
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
export function isAgentEngine(value: unknown): value is import('./protocol.js').AgentEngine { return value === 'claude-code' || value === 'codex' || value === 'ai-term'; }
export function isCliEngine(value: unknown): value is import('./protocol.js').CliEngine { return value === 'claude-code' || value === 'codex'; }
export function isModel(value: unknown): value is string | null { return value === null || typeof value === 'string' && isValidModelId(value); }
export function isPermission(value: unknown): value is import('./protocol.js').Permission { return value === 'ask' || value === 'auto' || value === 'dontAsk'; }

// Installed Claude help and Codex rust-v0.160.1 ReasoningEffort/config define these values.
export const EFFORT_LEVELS:Record<import('./protocol.js').AgentEngine,readonly import('./protocol.js').Effort[]>={
 'claude-code':['low','medium','high','xhigh','max'],
 codex:['none','minimal','low','medium','high','xhigh','max','ultra','persistent'],
 // AI Term's agent takes no effort level in v0.4.1; null (the model's default) only.
 'ai-term':[],
};
export function isEffort(value:unknown):value is import('./protocol.js').Effort|null{return value===null||typeof value==='string'&&EFFORT_LEVELS.codex.includes(value as import('./protocol.js').Effort);}
export function isEffortForEngine(engine:unknown,value:unknown):value is import('./protocol.js').Effort|null{return isAgentEngine(engine)&&isEffort(value)&&(value===null||EFFORT_LEVELS[engine].includes(value));}
export function isPermissionForEngine(engine:unknown,value:unknown):value is import('./protocol.js').Permission{return isAgentEngine(engine)&&isPermission(value)&&(value!=='auto'||engine==='claude-code');}
function isAccount(value: unknown): boolean { return !!value && typeof value === 'object' && Object.keys(value).length === 1 && 'kind' in value && value.kind === 'account'; }
export function sanitizeTitle(value: string): string { return [...stripVTControlCharacters(value).replace(/[\p{C}]/gu, '').trim()].slice(0,60).join(''); }
export function validateSettingsPatch(value: unknown, patchOnly = false): import('./protocol.js').SettingsPatch {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Expected settings patch');
    const v = value as Record<string,unknown>;
    if (patchOnly && Object.keys(v).some(k=>!['theme','defaultEngine','defaultModel','defaultEffort','defaultCwd','permission','budgets','priceOverrides','notifications','bar','worktrees','keysRunOn','deploymentModels','agentCaps','contextWarning','extensions','mcp','mcpApprovals','mcpOverrides'].includes(k))) throw new ValidationError('Unknown settings patch field');
    if (!Object.keys(v).length || Object.keys(v).some(k => ['__proto__','prototype','constructor'].includes(k)) ||
        v.theme !== undefined && !isThemeName(v.theme) || v.defaultEngine !== undefined && !isCliEngine(v.defaultEngine) || v.keysRunOn !== undefined && v.keysRunOn !== 'ai-term' && v.keysRunOn !== 'cli' ||
        v.defaultModel !== undefined && !isModel(v.defaultModel) || v.defaultEffort !== undefined && !isEffort(v.defaultEffort) || v.permission !== undefined && v.permission !== 'ask' || v.worktrees !== undefined && !['on','off'].includes(String(v.worktrees)) || v.bar !== undefined && !['on','off'].includes(String(v.bar)) || v.notifications !== undefined && typeof v.notifications !== 'boolean' ||
        v.defaultCwd !== undefined && (typeof v.defaultCwd !== 'string' || !isAbsolute(v.defaultCwd) || v.defaultCwd.includes('\0')) || Buffer.byteLength(JSON.stringify(v) + '\n') > 16384) throw new ValidationError('Invalid settings patch; permission default must be ask');
    // v0.4.2: "this deployment is model X" (values are checked against the catalog by the daemon), AI Term agent's
    // per-run caps (D53) and the 85% context warning (D55).
    if(v.deploymentModels!==undefined&&(!v.deploymentModels||typeof v.deploymentModels!=='object'||Array.isArray(v.deploymentModels)||Object.keys(v.deploymentModels).length>200||Object.entries(v.deploymentModels).some(([k,m])=>['__proto__','prototype','constructor'].includes(k)||!isValidModelId(k)||typeof m!=='string'||!isValidModelId(m))))throw new ValidationError('Invalid deployment models');
    if(v.agentCaps!==undefined&&!isAgentCaps(v.agentCaps))throw new ValidationError('Invalid agent caps');
    if(v.extensions!==undefined&&(!v.extensions||typeof v.extensions!=='object'||Array.isArray(v.extensions)||Object.keys(v.extensions).length>EXTENSION_MAX_ITEMS||Object.entries(v.extensions).some(([id,on])=>!isExtensionId(id)||typeof on!=='boolean')))throw new ValidationError('Invalid extension settings');
    if(v.mcp!==undefined){if(!Array.isArray(v.mcp)||v.mcp.length>MCP_MAX_SERVERS)throw new ValidationError('Invalid MCP servers');v.mcp.forEach(validateMcpServer);if(new Set(v.mcp.map(s=>s.config.name)).size!==v.mcp.length)throw new ValidationError('Duplicate MCP name');}
    if(v.mcpApprovals!==undefined&&(!isRecord(v.mcpApprovals)||Object.keys(v.mcpApprovals).length>64||Object.entries(v.mcpApprovals).some(([id,hash])=>!isExtensionId(id)||!isMcpHash(hash))))throw new ValidationError('Invalid MCP approvals');
    if(v.mcpOverrides!==undefined&&(!isRecord(v.mcpOverrides)||Object.keys(v.mcpOverrides).length>64||Object.entries(v.mcpOverrides).some(([id,value])=>!isExtensionId(id)||!isRecord(value)||Object.keys(value).some(k=>!['enabled','tools'].includes(k))||value.enabled!==undefined&&typeof value.enabled!=='boolean'||!isMcpTools(value.tools))))throw new ValidationError('Invalid MCP switches');
    if(v.contextWarning!==undefined&&typeof v.contextWarning!=='boolean')throw new ValidationError('Invalid context warning');
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
    if (Object.keys(v).some(k=>!['installed','path','version','loggedIn','authMethod','error'].includes(k)) || typeof v.installed !== 'boolean' || !(v.path === null || typeof v.path === 'string' && isAbsolute(v.path)) || !(v.version === null || typeof v.version === 'string' && /^[A-Za-z0-9.-]{1,80}$/.test(v.version)) || !(v.loggedIn === null || typeof v.loggedIn === 'boolean') || !['subscription','api-key','unknown'].includes(String(v.authMethod)) || v.error!==undefined&&!['Engine executable check failed','Engine version check failed','Engine login check failed'].includes(String(v.error))) throw new ValidationError('Invalid engine status');
    return {installed:v.installed,path:v.path as string|null,version:v.version as string|null,loggedIn:v.loggedIn as boolean|null,authMethod:v.authMethod as import('./protocol.js').AuthMethod,...(v.error!==undefined?{error:v.error as import('./protocol.js').EngineCheckError}:{})};
}
export function validateSession(value: unknown): import('./protocol.js').SessionInfo {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid daemon session');
    const s = value as Record<string, unknown>;
    const date = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
    if (!isUUID(s.id) || !isTitle(s.title) || (typeof s.engine !== 'string' || !['shell', 'claude-code', 'codex', 'ai-term'].includes(s.engine)) || s.engine === 'ai-term' && (!s.auth || typeof s.auth !== 'object' || !('kind' in s.auth) || s.auth.kind !== 'key') ||
        !isModel(s.model) || typeof s.cwd !== 'string' || !isAbsolute(s.cwd) || s.cwd.includes('\0') ||
        s.worktree!==undefined&&!isSafeAbsolutePath(s.worktree) || s.branch!==undefined&&!isWorktreeBranch(s.branch) || (s.worktree===undefined)!==(s.branch===undefined) || s.worktreeNote!==undefined&&!isWorktreeNote(s.worktreeNote) || s.login!==undefined&&(s.login!==true||s.engine==='shell') ||
        !isAuthView(s.auth) || !(s.engine==='shell'?s.permission==='ask':isPermissionForEngine(s.engine,s.permission)) || s.effort!==undefined && !isEffortForEngine(s.engine,s.effort) || s.conversationId!==undefined && (s.engine!=='claude-code'||!isUUID(s.conversationId)) ||
        (typeof s.status !== 'string' || !['starting', 'running', 'waiting', 'done', 'exited', 'error'].includes(s.status)) ||
        typeof s.statusDetail !== 'string' || s.statusDetail.length > 4096 || !date(s.statusSince) || !date(s.createdAt) ||
        !(s.lastOutputAt === null || date(s.lastOutputAt)) || !(s.ctxPercent===null||isShare(s.ctxPercent)) || s.lastActivity!==undefined&&s.lastActivity!==null&&!isActivity(s.lastActivity) ||
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
    if(!Array.isArray(v)||v.length>40||v.some(r=>!r||typeof r!=='object'||Object.keys(r).some(k=>!['model','status','httpStatus','errorCode','reason'].includes(k))||typeof r.model!=='string'||!isValidModelId(r.model)||!['ready','chat','not a chat model','error'].includes(r.status)||r.httpStatus!==undefined&&(!Number.isInteger(r.httpStatus)||r.httpStatus<100||r.httpStatus>599)||r.errorCode!==undefined&&(typeof r.errorCode!=='string'||!/^[A-Za-z0-9_.-]{1,80}$/.test(r.errorCode))||r.reason!==undefined&&!['Provider request timed out','Provider connection failed','Provider reply too large','Provider request failed'].includes(r.reason)))throw new ValidationError('Invalid deployment results');
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
// One export point never carries more than this. Larger values are forged (the receiver credential sits in the
// agent's env/argv), and summed totals must stay safe integers or the summary fails validation on every client.
export const MAX_RECORD_TOKENS=1_000_000_000,MAX_RECORD_COST_USD=10_000;
const isRecordTokens=(n:unknown)=>Number.isSafeInteger(n)&&isAmount(n)&&n<=MAX_RECORD_TOKENS;
export function validateUsageRecord(v:unknown):import('./protocol.js').UsageRecord{
 if(!v||typeof v!=='object'||Array.isArray(v))throw new ValidationError('Invalid usage record');const r=v as Record<string,unknown>;
 if(Object.keys(r).some(k=>!['ts','sessionId','provider','model','inputTokens','outputTokens','cachedTokens','costUsd','costSource'].includes(k))||typeof r.ts!=='string'||!Number.isFinite(Date.parse(r.ts))||!isUUID(r.sessionId)||!isKeyProvider(r.provider)||typeof r.model!=='string'||!isValidModelId(r.model)||!isRecordTokens(r.inputTokens)||!isRecordTokens(r.outputTokens)||r.cachedTokens!==undefined&&!isRecordTokens(r.cachedTokens)||r.costUsd!==null&&(!isAmount(r.costUsd)||r.costUsd>MAX_RECORD_COST_USD)||!['cli-estimate','price-table'].includes(String(r.costSource)))throw new ValidationError('Invalid usage record');
 return r as unknown as import('./protocol.js').UsageRecord;
}
export function validateUsageSummary(v:unknown):import('./protocol.js').UsageSummary{
 if(!v||typeof v!=='object'||Array.isArray(v)||!hasOnly(v as Record<string,unknown>,['today','week','month']))throw new ValidationError('Invalid usage summary');
 const total=(t:unknown,provider=false)=>{if(!t||typeof t!=='object'||Array.isArray(t))throw new ValidationError('Invalid usage total');const r=t as Record<string,unknown>,{cachedTokens,...required}=r;if(!hasOnly(required,provider?['provider','costUsd','tokens','unknownPrice']:['costUsd','tokens','unknownPrice','providers'])||cachedTokens!==undefined&&(!Number.isSafeInteger(cachedTokens)||!isAmount(cachedTokens))||!isAmount(r.costUsd)||!Number.isSafeInteger(r.tokens)||!isAmount(r.tokens)||typeof r.unknownPrice!=='boolean'||provider&&!isKeyProvider(r.provider))throw new ValidationError('Invalid usage total');};
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
 // eslint-disable-next-line no-control-regex -- Newlines alone are allowed in clipboard text.
 if(Object.keys(v).some(k=>!['sessionId','text','truncated','more','source'].includes(k))||!isUUID(v.sessionId)||typeof v.text!=='string'||Buffer.byteLength(v.text)>MAX_COPY_BYTES||/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\p{Zl}\p{Zp}]|(?!\u200d)\p{Cf}/u.test(v.text)||typeof v.truncated!=='boolean'||v.more!==undefined&&typeof v.more!=='boolean'||v.source!==undefined&&!['last-reply','session'].includes(String(v.source)))throw new ValidationError('Invalid session text');
 return v as unknown as import('./protocol.js').SessionText & {more?:boolean};
}

export function isActivity(value:unknown):boolean{if(!value||typeof value!=='object'||Array.isArray(value))return false;const v=value as Record<string,unknown>;return Object.keys(v).length===2&&isToolName(v.tool)&&typeof v.at==='string'&&Number.isFinite(Date.parse(v.at));}
export function isToolName(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(value)&&!value.includes('sk-');}
export function isStatusCommandPath(value:unknown):value is string{return typeof value==='string'&&value.length<=4096&&/^\/[A-Za-z0-9_./-]+$/.test(value)&&!value.split('/').some(p=>p==='.'||p==='..');}

// Generated names use a smaller alphabet than git refs: no metacharacters, separators or option prefixes.
export function isWorktreeSlug(value:unknown):value is string{return typeof value==='string'&&/^[a-z0-9][a-z0-9-]{0,39}$/.test(value);}
export function worktreeSlug(name:string):string{return name.toLowerCase().replace(/[^a-z0-9-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,40).replace(/-+$/g,'')||'agent';}
export function availableWorktreeSlug(name:string,occupied:ReadonlySet<string>):string{
 const base=worktreeSlug(name);let slug=base;
 for(let n=2;occupied.has(slug);n++){const suffix=`-${n}`;slug=base.slice(0,40-suffix.length).replace(/-+$/g,'')+suffix;}
 return slug;
}
export function isWorktreeBranch(value:unknown):value is string{return typeof value==='string'&&value.startsWith('ai/')&&isWorktreeSlug(value.slice(3));}
export function isSafeAbsolutePath(value:unknown):value is string{return typeof value==='string'&&isAbsolute(value)&&value.length<=4096&&!/[\p{C}\p{Zl}\p{Zp}]/u.test(value)&&!value.split('/').some(p=>p==='.'||p==='..');}
const WORKTREE_NOTES=['worktree off: not a git repo','worktree off: repo has no commits','worktree off: git check failed','worktree off: creation failed'];
export function isWorktreeNote(value:unknown):value is import('./protocol.js').WorktreeNote{return typeof value==='string'&&WORKTREE_NOTES.includes(value);}
export function validateWorktreePreview(value:unknown):import('./protocol.js').WorktreePreview{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid worktree preview');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['branch','head','dirty','note'].includes(k))||v.branch!==undefined&&!isWorktreeBranch(v.branch)||v.head!==undefined&&(typeof v.head!=='string'||!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v.head))||v.dirty!==undefined&&typeof v.dirty!=='boolean'||v.note!==undefined&&!isWorktreeNote(v.note)||(v.branch===undefined)!==(v.head===undefined))throw new ValidationError('Invalid worktree preview');
 return v as import('./protocol.js').WorktreePreview;
}
export function isTerminalBundle(value:unknown):value is import('./protocol.js').TerminalBundle{return typeof value==='string'&&['com.apple.Terminal','com.googlecode.iterm2','com.mitchellh.ghostty','com.github.wez.wezterm'].includes(value);}
// Only plain branch names are stored or put into a git --format atom, so a name can never add or close an atom.
export function isPlainBranch(value:unknown):value is string{return typeof value==='string'&&/^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/.test(value);}
const COMMIT_ID=/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
export function isFingerprint(value:unknown):value is string{return typeof value==='string'&&/^[0-9a-f]{64}$/.test(value);}
const WORKTREE_REFUSALS=["Not in AI Term's record",'Outside the worktrees folder','Path has a symlink','Original repo unknown','Worktree does not match its repo','Main checkout is never deleted','Git does not list this worktree','Worktree is not on its ai/ branch','Worktree is locked','Branch is checked out elsewhere','Stop the agent first','Worktree is busy','Git check failed'];
const count=(n:unknown)=>Number.isSafeInteger(n)&&Number(n)>=0;
// Records come from state.json, which only the daemon writes; still, a malformed one must never steer a deletion.
export function validateWorktreeRecord(value:unknown):import('./protocol.js').WorktreeRecord{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid worktree record');
 const v=value as Record<string,unknown>;
 if(Object.keys(v).some(k=>!['path','branch','repo','baseBranch','baseCommit','createdAt'].includes(k))||!isSafeAbsolutePath(v.path)||!isWorktreeBranch(v.branch)||v.repo!==undefined&&!isSafeAbsolutePath(v.repo)||
  v.baseBranch!==undefined&&!isPlainBranch(v.baseBranch)||v.baseCommit!==undefined&&(typeof v.baseCommit!=='string'||!COMMIT_ID.test(v.baseCommit))||
  typeof v.createdAt!=='string'||!Number.isFinite(Date.parse(v.createdAt)))throw new ValidationError('Invalid worktree record');
 return v as unknown as import('./protocol.js').WorktreeRecord;
}
export function validateWorktreeView(value:unknown):import('./protocol.js').WorktreeView{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new ValidationError('Invalid worktree view');
 const v=value as Record<string,unknown>,agent=v.agent as Record<string,unknown>|undefined,loss=v.loss as Record<string,unknown>|undefined;
 if(Object.keys(v).some(k=>!['path','branch','agent','loss','fingerprint','refusal'].includes(k))||!isSafeAbsolutePath(v.path)||v.branch!==undefined&&!isWorktreeBranch(v.branch)||v.fingerprint!==undefined&&!isFingerprint(v.fingerprint)||v.refusal!==undefined&&!WORKTREE_REFUSALS.includes(String(v.refusal))||
  agent!==undefined&&(!agent||typeof agent!=='object'||Object.keys(agent).some(k=>!['id','title','status'].includes(k))||!isUUID(agent.id)||!isTitle(agent.title)||!['starting','running','waiting','done','exited','error'].includes(String(agent.status)))||
  loss!==undefined&&(!loss||typeof loss!=='object'||Object.keys(loss).some(k=>!['changed','untracked','ignored','repos','commits','base','baseSource','missing'].includes(k))||!count(loss.changed)||!count(loss.untracked)||!count(loss.ignored)||!count(loss.repos)||Number(loss.repos)>Number(loss.untracked)||!count(loss.commits)||typeof loss.base!=='string'||!/^[A-Za-z0-9._/-]{1,200}$/.test(loss.base)||!['recorded','start commit','checkout'].includes(String(loss.baseSource))||typeof loss.missing!=='boolean'))throw new ValidationError('Invalid worktree view');
 return v as unknown as import('./protocol.js').WorktreeView;
}

// Both socket and engine-bound HTTP extension requests use these exact fields. No request supplies a file path.
export function validateExtensionRequest(v: Record<string, unknown>): void {
    const fields = v.kind === 'extensions.list' ? ['kind','cwd'] : v.kind === 'extensions.read' ? ['kind','cwd','extensionId'] : v.kind === 'extensions.toggle' ? ['kind','cwd','extensionId','enabled'] : [];
    if (!fields.length || Object.keys(v).some(k => k !== 'id' && !fields.includes(k)) || typeof v.cwd !== 'string' || !isAbsolute(v.cwd) || v.cwd.length > 3000 || /[\p{C}]/u.test(v.cwd) || v.kind !== 'extensions.list' && !isExtensionId(v.extensionId) || v.kind === 'extensions.toggle' && typeof v.enabled !== 'boolean') throw new ValidationError('Invalid extension request');
}
export function validateExtensionCatalog(value: unknown): ExtensionCatalog {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ValidationError('Invalid extensions');
    const c = value as Record<string, unknown>;
    if (Object.keys(c).some(k=>!['items','notes','tokens'].includes(k)) || !Array.isArray(c.items) || c.items.length > EXTENSION_MAX_ITEMS || !Array.isArray(c.notes) || c.notes.length > 100 || c.notes.some(n=>typeof n!=='string'||n.length>4096||/[\p{C}]/u.test(n)) || !Number.isSafeInteger(c.tokens) || Number(c.tokens) < 0) throw new ValidationError('Invalid extensions');
    for (const raw of c.items) {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ValidationError('Invalid extension');
        const i = raw as Record<string,unknown>;
        if (Object.keys(i).some(k=>!['id','kind','name','description','source','enabled','tokens','model'].includes(k)) || !isExtensionId(i.id) || !['skill','agent','command'].includes(String(i.kind)) || typeof i.name!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(i.name) || typeof i.description!=='string'||i.description.length>EXTENSION_DESCRIPTION_CHARS||/[\p{C}]/u.test(i.description) || !['Claude','Codex','shared','this project'].includes(String(i.source)) || typeof i.enabled!=='boolean' || !Number.isSafeInteger(i.tokens)||Number(i.tokens)<0 || i.model!==undefined&&(typeof i.model!=='string'||i.model.length>240||/[\p{C}]/u.test(i.model))) throw new ValidationError('Invalid extension');
    }
    const result = value as ExtensionCatalog;
    if (new Set(result.items.map(i=>i.id)).size !== result.items.length || result.tokens !== catalogTokens(result.items)) throw new ValidationError('Invalid extension total');
    return result;
}
export function validateExtensionFile(value: unknown): ExtensionFile {
    if (!value || typeof value!=='object'||Array.isArray(value)) throw new ValidationError('Invalid extension file');
    const f = value as Record<string,unknown>;
    if (Object.keys(f).length!==3 || !('item' in f) || typeof f.text!=='string'||typeof f.body!=='string'||Buffer.byteLength(f.text)>EXTENSION_FILE_BYTES||Buffer.byteLength(f.body)>EXTENSION_FILE_BYTES) throw new ValidationError('Invalid extension file');
    const item = f.item as import('./extensions.js').ExtensionItem;
    validateExtensionCatalog({items:[item],notes:[],tokens:catalogTokens([item])});
    return value as ExtensionFile;
}

const isRecord=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
export const isMcpName=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
export const isMcpTool=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)&&!['__proto__','prototype','constructor'].includes(value);
export const isMcpHash=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
export const isMcpEnv=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(value)&&!/^(?:AITERM|AI_TERM|OTEL|NODE_|LD_|DYLD_)/i.test(value)&&!['PATH','HOME','SHELL','USER','LOGNAME','TMPDIR','TERM','LANG'].includes(value.toUpperCase());
export const isMcpHeader=(value:unknown):value is string=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(value)&&!['host','content-length','connection','origin','content-type','accept','mcp-session-id','mcp-protocol-version','last-event-id','transfer-encoding','proxy-authorization'].includes(value.toLowerCase());
function isMcpTools(value:unknown):value is Record<string,boolean>{return isRecord(value)&&Object.keys(value).length<=MCP_MAX_TOOLS&&Object.entries(value).every(([name,on])=>isMcpTool(name)&&typeof on==='boolean');}
export function validateMcpConfig(value:unknown):McpConfig {
 if(!isRecord(value)||!isMcpName(value.name)||!['stdio','http'].includes(String(value.type)))throw new ValidationError('Invalid MCP configuration');
 const fields=value.type==='stdio'?['name','type','command','args','env']:['name','type','url','headers'];if(Object.keys(value).some(k=>!fields.includes(k)))throw new ValidationError('Invalid MCP configuration');
 const names=value.type==='stdio'?value.env:value.headers;
 if(!Array.isArray(names)||names.length>16||names.some(n=>value.type==='stdio'?!isMcpEnv(n):!isMcpHeader(n))||new Set(names.map(n=>String(n).toLowerCase())).size!==names.length)throw new ValidationError('Invalid MCP value names');
 if(value.type==='stdio'){
  if(typeof value.command!=='string'||!value.command||value.command.startsWith('-')||Buffer.byteLength(value.command)>2048||/[\p{C}]/u.test(value.command)||!isAbsolute(value.command)&&/[\s/\\]/u.test(value.command)||!Array.isArray(value.args)||value.args.length>64||value.args.some(a=>typeof a!=='string'||Buffer.byteLength(a)>2048||/[\p{C}]/u.test(a)))throw new ValidationError('Invalid MCP argv');
 }else{
  if(typeof value.url!=='string'||value.url.length>2048)throw new ValidationError('Invalid MCP URL');let url:URL;try{url=new URL(value.url);}catch{throw new ValidationError('Invalid MCP URL');}
  if(url.username||url.password||url.search||url.hash||url.protocol!=='https:'&&(url.protocol!=='http:'||!['127.0.0.1','localhost','[::1]'].includes(url.hostname))||url.href!==value.url)throw new ValidationError('Invalid MCP URL');
 }
 if(Buffer.byteLength(JSON.stringify(value))>12*1024)throw new ValidationError('MCP configuration too large');return value as unknown as McpConfig;
}
export function validateMcpValues(config:McpConfig,value:unknown):Record<string,string>{
 const names=config.type==='stdio'?config.env:config.headers;
 if(!isRecord(value)||Object.keys(value).length!==names.length||Object.keys(value).some(n=>!names.includes(n))||Object.values(value).some(v=>typeof v!=='string'||!v||Buffer.byteLength(v)>2048||/[\p{C}]/u.test(v)))throw new ValidationError('Invalid MCP values');return value as Record<string,string>;
}
export function validateMcpServer(value:unknown):McpServer {
 if(!isRecord(value)||Object.keys(value).some(k=>!['id','config','hash','enabled','values','tools'].includes(k))||!isExtensionId(value.id)||!isMcpHash(value.hash)||typeof value.enabled!=='boolean'||!isMcpTools(value.tools))throw new ValidationError('Invalid MCP server');
 const config=validateMcpConfig(value.config),names=config.type==='stdio'?config.env:config.headers;
 if(!Array.isArray(value.values)||value.values.length!==names.length||value.values.some(v=>!isRecord(v)||Object.keys(v).some(k=>!['name','last4'].includes(k))||!names.includes(String(v.name))||typeof v.last4!=='string'||v.last4.length!==4&&v.last4!==''||/[\p{C}]/u.test(v.last4))||new Set(value.values.map(v=>v.name)).size!==names.length)throw new ValidationError('Invalid MCP secret references');return value as unknown as McpServer;
}
export function validateMcpCatalog(value:unknown):McpCatalog {
 if(!isRecord(value)||Object.keys(value).some(k=>!['servers','notes','tokens'].includes(k))||!Array.isArray(value.servers)||value.servers.length>MCP_MAX_SERVERS*2||!Array.isArray(value.notes)||value.notes.length>32||value.notes.some(n=>typeof n!=='string'||n.length>240||/[\p{C}]/u.test(n)))throw new ValidationError('Invalid MCP catalog');
 for(const s of value.servers){if(!isRecord(s)||Object.keys(s).some(k=>!['id','config','hash','enabled','values','tools','source','approved','note','available'].includes(k)))throw new ValidationError('Invalid MCP catalog');const {source,approved,note,available,...stored}=s;validateMcpServer(stored);if(!['AI Term','this project'].includes(String(source))||typeof approved!=='boolean'||note!==undefined&&(typeof note!=='string'||note.length>240||/[\p{C}]/u.test(note))||!Array.isArray(available)||available.length>MCP_MAX_TOOLS||available.some(t=>!isRecord(t)||Object.keys(t).some(k=>!['name','description','enabled','tokens'].includes(k))||!isMcpTool(t.name)||typeof t.description!=='string'||t.description.length>240||/[\p{C}]/u.test(t.description)||typeof t.enabled!=='boolean'||!Number.isSafeInteger(t.tokens)||Number(t.tokens)<0))throw new ValidationError('Invalid MCP tools');}
 const c=value as unknown as McpCatalog;if(c.tokens!==mcpTokens(c))throw new ValidationError('Invalid MCP token estimate');return c;
}
export function validateMcpObject(value:unknown):Record<string,unknown>{
 if(!isRecord(value)||Buffer.byteLength(JSON.stringify(value))>64*1024)throw new ValidationError('Invalid MCP object');return value;
}
export function validateMcpRequest(value:unknown):string[]{
 if(!isRecord(value)||typeof value.kind!=='string')throw new ValidationError('Invalid MCP request');const v=value;
 let fields:string[];
 if(v.kind==='mcp.add'){fields=['config','values'];validateMcpValues(validateMcpConfig(v.config),v.values);}
 else if(v.kind==='mcp.remove'){fields=['name'];if(!isMcpName(v.name))throw new ValidationError('Invalid MCP name');}
 else if(v.kind==='mcp.cancel'||v.kind==='mcp.stop')fields=[];
 else{
  fields=['cwd'];if(!isSafeAbsolutePath(v.cwd))throw new ValidationError('Invalid MCP folder');
  if(v.kind!=='mcp.list'){
   fields.push('serverId');if(!isExtensionId(v.serverId))throw new ValidationError('Invalid MCP server id');
   if(v.kind==='mcp.toggle'){fields.push('tool','enabled');if(typeof v.enabled!=='boolean'||v.tool!==undefined&&!isMcpTool(v.tool))throw new ValidationError('Invalid MCP switch');}
   else{fields.push('hash');if(!isMcpHash(v.hash))throw new ValidationError('Invalid MCP hash');if(v.kind==='mcp.schema'||v.kind==='mcp.call'){fields.push('tool');if(!isMcpTool(v.tool))throw new ValidationError('Invalid MCP tool');if(v.kind==='mcp.call'){fields.push('arguments');validateMcpObject(v.arguments);}}else if(!['mcp.approve','mcp.discover'].includes(String(v.kind)))throw new ValidationError('Invalid MCP operation');}
  }
 }
 if(Object.keys(v).some(k=>k!=='id'&&!fields.includes(k)&&k!=='kind')||Buffer.byteLength(JSON.stringify(v))>64*1024)throw new ValidationError('Invalid MCP request');return fields;
}
export function parseMcpRequest(value:unknown):McpRequest{validateMcpRequest(value);return value as McpRequest;}

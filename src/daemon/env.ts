// Only the architecture's always rules apply to the internal shell engine.
// ELECTRON_RUN_AS_NODE comes from AI Term's own launcher (S25); keepElectronNode is only for a dev daemon running as the
// plain Electron binary, whose status commands need it (electronNodeNeeded in runtime-paths.ts).
export function buildShellEnv(base: NodeJS.ProcessEnv, options: {keepElectronNode?: boolean} = {}): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && !/^npm_/.test(key) && !/^AI_TERM_/.test(key) && !['INIT_CWD', 'NODE_ENV','AITERM_STATUS_TOKEN','AITERM_STATUS_PORT'].includes(key) && (key !== 'ELECTRON_RUN_AS_NODE' || options.keepElectronNode))
            result[key] = value;
    }
    Object.assign(result, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' });
    if (!result.LANG && !result.LC_ALL && !result.LC_CTYPE)
        result.LANG = 'en_US.UTF-8';
    return result;
}

import { dirname, resolve } from 'node:path';
import type { AgentEngine, CliEngine, Permission, Effort, ThemeName, KeyProvider } from '../shared/protocol.js';
import { isModel, isPermissionForEngine, isEffortForEngine, isUUID, isStatusCommandPath, isValidModelId, isThemeName, isEndpoint, isSecret } from '../shared/validate.js';
export const CLAUDE_AUTH_VARS = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_REFRESH_TOKEN','CLAUDE_CODE_OAUTH_SCOPES','ANTHROPIC_PROFILE','ANTHROPIC_FEDERATION_RULE_ID','ANTHROPIC_ORGANIZATION_ID','ANTHROPIC_WORKSPACE_ID','ANTHROPIC_AWS_*','ANTHROPIC_BEDROCK_*','ANTHROPIC_VERTEX_*','ANTHROPIC_FOUNDRY_*','AWS_BEARER_TOKEN_BEDROCK','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SIMPLE',
    // B21 (code.claude.com/docs/en/env-vars, 2026-10-13): provider switches, auth skips, auth-capable headers, host routing, mTLS.
    'CLAUDE_CODE_USE_ANTHROPIC_AWS','CLAUDE_CODE_USE_MANTLE','CLAUDE_CODE_SKIP_BEDROCK_AUTH','CLAUDE_CODE_SKIP_VERTEX_AUTH','CLAUDE_CODE_SKIP_FOUNDRY_AUTH','CLAUDE_CODE_SKIP_MANTLE_AUTH','CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH','ANTHROPIC_CUSTOM_HEADERS','CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST','CLAUDE_CODE_CLIENT_CERT','CLAUDE_CODE_CLIENT_KEY','CLAUDE_CODE_CLIENT_KEY_PASSPHRASE'] as const;
export const CODEX_AUTH_VARS = ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','AITERM_FOUNDRY_KEY',
    // B21 (learn.chatgpt.com/docs/config-file/environment-variables, 2026-10-13): access token and workload identity.
    'CODEX_ACCESS_TOKEN','OPENAI_FEDERATION_RULE_ID','OPENAI_IDENTITY_TOKEN_FILE'] as const;
// D41: a Codex account config may route Azure through AZURE_OPENAI_API_KEY, so account sessions keep it. A key session still gets only its own key (D16).
const CODEX_KEY_EXTRA_VARS = ['AZURE_OPENAI_API_KEY'] as const;
// Key rows are pure/tested only. No v0.1.6 handler accepts a key or invokes these rows.
// profileDir (v0.6.4, D53): an account profile's own config folder; the CLI keeps that account's login there (Claude Code
// also keys its Keychain entry to it). Set only here, and AI Term never reads what the CLI writes into it.
export function buildSpawnEnv(engine: CliEngine, auth: {kind:'account'} | {kind:'key';secret:string;provider?:'openai'}, base: NodeJS.ProcessEnv, options: {keepElectronNode?: boolean; profileDir?: string} = {}): Record<string,string> {
    const result=buildShellEnv(base,options), vars:readonly string[]=engine==='claude-code'?CLAUDE_AUTH_VARS:auth.kind==='key'?[...CODEX_AUTH_VARS,...CODEX_KEY_EXTRA_VARS]:CODEX_AUTH_VARS;
    for(const key of Object.keys(result))if(vars.some(pattern=>pattern.endsWith('*')?key.startsWith(pattern.slice(0,-1)):key===pattern))delete result[key];
    if(auth.kind==='key')result[engine==='claude-code'?'ANTHROPIC_API_KEY':auth.provider==='openai'?'OPENAI_API_KEY':'AITERM_FOUNDRY_KEY']=auth.secret;
    if(auth.kind==='account'&&options.profileDir)result[engine==='claude-code'?'CLAUDE_CONFIG_DIR':'CODEX_HOME']=options.profileDir;
    return result;
}
// D40: Ask passes explicit ask flags, or the user's own CLI config (e.g. Codex YOLO) silently turns Ask into Don't ask. Claude 2.1.296 help lists this mode as 'manual'; the CLI maps 'manual' to its canonical 'default'.
// AI Term's own agent reads its mode from these two flags only; it imports the constants, so the spelling lives here (S10).
export const AGENT_ASK_FLAG='--ask',AGENT_DONT_ASK_FLAG='--dont-ask';
const PERMISSION_ARGS:Record<AgentEngine,Partial<Record<Permission,readonly string[]>>>={
    'claude-code':{ask:['--permission-mode=default'],auto:['--permission-mode=auto'],dontAsk:['--permission-mode=bypassPermissions']},
    codex:{ask:['--ask-for-approval=on-request','--sandbox=workspace-write'],dontAsk:['--ask-for-approval=never','--sandbox=workspace-write']},
    'ai-term':{ask:[AGENT_ASK_FLAG],dontAsk:[AGENT_DONT_ASK_FLAG]},
};
export interface CodexStatusCommand {node:string;entry:string;loader?:string}
// Source mode only: tsx reads tsconfig.json from the current folder, which for status commands is the agent's project, and a
// project's tsconfig `paths` could swap AI Term's imports for project code. Pinning AI Term's own tsconfig (two levels above
// src/cli/index.ts) closes that. Built mode runs plain JS and needs nothing.
export function sourceTsconfig(entry:string):string{return resolve(dirname(entry),'..','..','tsconfig.json');}
export const TSX_PIN='/usr/bin/env';
// Codex status needs no file and no credential in argv: notify inherits the session env (AITERM_STATUS_TOKEN/PORT),
// and the TUI's own terminal signals are read by the daemon mirror (osc9, since TERM_PROGRAM=AITerm makes auto pick BEL).
function codexStatusArgs(command:CodexStatusCommand):string[]{
    const source=command.entry.endsWith('.ts');
    // Paths go inside a TOML string array, so only the strict path alphabet (no quotes, spaces or brackets) may enter it.
    const tsconfig=sourceTsconfig(command.entry);
    const notify=isStatusCommandPath(command.node)&&isStatusCommandPath(command.entry)&&(!source||isStatusCommandPath(command.loader)&&isStatusCommandPath(tsconfig))?[...(source&&command.loader?[TSX_PIN,`TSX_TSCONFIG_PATH=${tsconfig}`]:[]),command.node,...(source&&command.loader?['--import',command.loader]:[]),command.entry,'status-notify']:null;
    return [...(notify?['-c',`notify=[${notify.map(part=>`"${part}"`).join(',')}]`]:[]),'-c','tui.notifications=["agent-turn-complete","approval-requested"]','-c','tui.notification_method="osc9"','-c','tui.notification_condition="always"','-c','tui.terminal_title=["activity","run-state","context-remaining"]'];
}
export function buildArgs(request:{engine:CliEngine;model:string|null;permission:Permission;effort?:Effort|null;conversationId?:string;resume?:boolean;firstMessage?:string;foundryEndpoint?:string;openaiKey?:boolean;codexStatus?:CodexStatusCommand}):string[] {
    if(request.engine!=='claude-code'&&request.engine!=='codex'||!isModel(request.model)||!isPermissionForEngine(request.engine,request.permission)||request.effort!==undefined&&!isEffortForEngine(request.engine,request.effort)||request.conversationId!==undefined&&(request.engine!=='claude-code'||!isUUID(request.conversationId))||request.resume!==undefined&&typeof request.resume!=='boolean'||request.resume&&request.engine==='claude-code'&&!request.conversationId||request.firstMessage!==undefined&&(Buffer.byteLength(request.firstMessage)>16384||request.firstMessage.includes('\0'))||request.codexStatus!==undefined&&request.engine!=='codex')throw new Error('Invalid spawn arguments');
    // D41: without --no-daemon the Codex TUI may join a shared background server started elsewhere, whose env and config win over this recipe's env and -c overrides. Codex rejects the flag twice, so only this line adds it.
    // B5: Codex's startup update menu takes Enter as "Update now"; its own check_for_update_on_startup (config_toml.rs, rust-v0.160.1) turns the check off for this session only.
    const args:string[]=request.engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false']:[];
    if(request.codexStatus)args.push(...codexStatusArgs(request.codexStatus));
    if(request.resume&&request.engine==='codex')args.push('resume');
    if(request.foundryEndpoint!==undefined){
        const endpoint=request.foundryEndpoint;
        let url:URL;try{url=new URL(endpoint);}catch{throw new Error('Invalid Foundry endpoint');}
        if(request.engine!=='codex'||!request.model||url.protocol!=='https:'||!url.hostname||url.username||url.password||/[\s"'\\]/.test(endpoint))throw new Error('Invalid Foundry endpoint');
        for(const config of ['model_provider="aiterm_foundry"','model_providers.aiterm_foundry.name="AI Term Foundry"',`model_providers.aiterm_foundry.base_url="${endpoint}"`,'model_providers.aiterm_foundry.env_key="AITERM_FOUNDRY_KEY"','model_providers.aiterm_foundry.env_http_headers={"api-key"="AITERM_FOUNDRY_KEY"}','model_providers.aiterm_foundry.wire_api="responses"','model_providers.aiterm_foundry.requires_openai_auth=false'])args.push('-c',config);
    }
    if(request.openaiKey){if(request.engine!=='codex')throw new Error('Invalid OpenAI engine');args.push('-c','model_provider="openai"');}
    if(request.model!==null)args.push(`--model=${request.model}`);
    if(request.effort!==undefined&&request.effort!==null)args.push(...(request.engine==='codex'?['-c',`model_reasoning_effort="${request.effort}"`]:[`--effort=${request.effort}`]));
    if(request.conversationId)args.push(`${request.resume?'--resume':'--session-id'}=${request.conversationId}`);
    args.push(...(PERMISSION_ARGS[request.engine][request.permission]??[]));
    if(request.firstMessage!==undefined)args.push('--',request.firstMessage);
    return args;
}

export interface UsageTelemetry {port:number;credential:string}
function validTelemetry(telemetry:UsageTelemetry):void{if(!Number.isInteger(telemetry.port)||telemetry.port<1||telemetry.port>65535||! /^[a-f0-9]{64}$/.test(telemetry.credential))throw new Error('Invalid usage telemetry');}
export function buildUsageEnv(engine:CliEngine,telemetry:UsageTelemetry):Record<string,string>{
 validTelemetry(telemetry);if(engine!=='claude-code')return {};
 return {CLAUDE_CODE_ENABLE_TELEMETRY:'1',OTEL_METRICS_EXPORTER:'otlp',OTEL_LOGS_EXPORTER:'none',OTEL_EXPORTER_OTLP_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:`http://127.0.0.1:${telemetry.port}/v1/metrics`,OTEL_EXPORTER_OTLP_METRICS_HEADERS:`x-ai-term-session=${telemetry.credential}`,OTEL_METRICS_INCLUDE_SESSION_ID:'true',OTEL_METRIC_EXPORT_INTERVAL:'10000'};
}
export function buildUsageArgs(engine:CliEngine,telemetry:UsageTelemetry):string[]{
 validTelemetry(telemetry);if(engine!=='codex')return [];
 // rust-v0.160.1 explicitly configures HTTP log exporter headers; no env header route is documented.
 return ['-c','otel.log_user_prompt=false','-c',`otel.exporter={otlp-http={endpoint="http://127.0.0.1:${telemetry.port}/v1/logs",protocol="json",headers={"x-ai-term-session"="${telemetry.credential}"}}}`];
}

export function buildStatusEnv(telemetry:UsageTelemetry):Record<string,string>{validTelemetry(telemetry);return {AITERM_STATUS_TOKEN:telemetry.credential,AITERM_STATUS_PORT:String(telemetry.port)};}
export function buildStatusArgs(path:string):string[]{if(!path.startsWith('/')||path.includes('\0')||path.length>4096)throw new Error('Invalid Claude settings path');return [`--settings=${path}`];}

// ---- AI Term's own agent (v0.4.1, architecture §12.5) ----
export interface AgentCommand {node:string;entry:string;loader?:string}
// /model choices passed to the agent: a Foundry key's tested deployments (at most 40) or a provider's catalog models.
const MAX_AGENT_MODELS=200;
const absolute=(path:unknown):path is string=>typeof path==='string'&&path.startsWith('/')&&!path.includes('\0')&&path.length<=4096;
// `ai agent` runs like the status commands: node plus AI Term's entry (source mode adds the tsx loader). No shell, no secret:
// the model, the deployments it may switch to and the mode are plain argv; the key goes only into buildAgentEnv.
export function buildAgentArgs(request:{command:AgentCommand;provider:KeyProvider;model:string;models:readonly string[];permission:Permission;theme:ThemeName;transcript:string;firstMessage?:string}):{executable:string;args:string[]}{
    const {command}=request;
    if(!absolute(command.node)||!absolute(command.entry)||command.loader!==undefined&&!absolute(command.loader)||command.entry.endsWith('.ts')&&command.loader===undefined)throw new Error('Invalid agent command');
    if(!['foundry','anthropic','openai'].includes(request.provider)||!isValidModelId(request.model)||!request.models.length||request.models.length>MAX_AGENT_MODELS||!request.models.every(isValidModelId)||!request.models.includes(request.model)||!isPermissionForEngine('ai-term',request.permission)||!isThemeName(request.theme)||!absolute(request.transcript)||request.firstMessage!==undefined&&(Buffer.byteLength(request.firstMessage)>16384||request.firstMessage.includes('\0')))throw new Error('Invalid agent arguments');
    const args=[...(command.loader?['--import',command.loader]:[]),command.entry,'agent',`--provider=${request.provider}`,`--model=${request.model}`,`--models=${request.models.join(',')}`,`--theme=${request.theme}`,`--transcript=${request.transcript}`,...(PERMISSION_ARGS['ai-term'][request.permission]??[])];
    if(request.firstMessage!==undefined)args.push('--',request.firstMessage);
    return {executable:command.node,args};
}
// What a program needs to run as you in a terminal. Everything else in the daemon's env (other keys, cloud and CLI
// credentials, NODE_OPTIONS, npm and AI Term variables) stays out of AI Term's agent.
const AGENT_BASE_VARS=['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','LC_CTYPE'] as const;
function pick(base:NodeJS.ProcessEnv,names:readonly string[]):Record<string,string>{const result:Record<string,string>={};for(const name of names){const value=base[name];if(typeof value==='string')result[name]=value;}return result;}
// endpoint: the Foundry key's Keychain-bound endpoint; null for Anthropic and OpenAI, whose hosts are fixed in the agent.
export function buildAgentEnv(base:NodeJS.ProcessEnv,agent:{secret:string;endpoint:string|null;status?:UsageTelemetry;usage?:UsageTelemetry;entry:string}):Record<string,string>{
    if(!isSecret(agent.secret)||agent.endpoint!==null&&!isEndpoint(agent.endpoint)||!absolute(agent.entry))throw new Error('Invalid agent env');
    const result:Record<string,string>={...pick(base,AGENT_BASE_VARS),TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'AITerm'};
    if(!result.LANG&&!result.LC_ALL&&!result.LC_CTYPE)result.LANG='en_US.UTF-8';
    // Source mode: tsx would read tsconfig.json from the agent's folder, whose `paths` could swap AI Term's imports.
    if(agent.entry.endsWith('.ts'))result.TSX_TSCONFIG_PATH=sourceTsconfig(agent.entry);
    Object.assign(result,agent.status?buildStatusEnv(agent.status):{},{AITERM_AGENT_KEY:agent.secret},agent.endpoint?{AITERM_AGENT_ENDPOINT:agent.endpoint}:{});
    if(agent.usage){validTelemetry(agent.usage);result.AITERM_USAGE_TOKEN=agent.usage.credential;}
    return result;
}
// The env of every command the agent's bash tool runs: an allowlist, so no API key, no AI Term credential and nothing the
// daemon set can reach a command the model wrote. The name check is a second guard in case a base name ever carries one.
const BASH_BASE_VARS=['PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','LANG','LC_ALL','LC_CTYPE'] as const;
export function buildBashEnv(base:NodeJS.ProcessEnv):Record<string,string>{
    const result=pick(base,BASH_BASE_VARS);
    for(const name of Object.keys(result))if(/KEY|TOKEN|SECRET|PASSWORD|AITERM|AI_TERM/i.test(name))delete result[name];
    // No pager or credential prompt may wait on a terminal the command doesn't have.
    return {...result,TERM:'dumb',PAGER:'cat',GIT_PAGER:'cat',GIT_TERMINAL_PROMPT:'0'};
}

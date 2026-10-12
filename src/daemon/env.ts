// Only the architecture's always rules apply to the internal shell engine.
export function buildShellEnv(base: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(base)) {
        if (value !== undefined && !/^npm_/.test(key) && !/^AI_TERM_/.test(key) && !['INIT_CWD', 'NODE_ENV'].includes(key))
            result[key] = value;
    }
    Object.assign(result, { TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' });
    if (!result.LANG && !result.LC_ALL && !result.LC_CTYPE)
        result.LANG = 'en_US.UTF-8';
    return result;
}

import type { AgentEngine, Permission } from '../shared/protocol.js';
import { isModel, isPermission } from '../shared/validate.js';
export const CLAUDE_AUTH_VARS = ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','CLAUDE_CODE_OAUTH_REFRESH_TOKEN','CLAUDE_CODE_OAUTH_SCOPES','ANTHROPIC_PROFILE','ANTHROPIC_FEDERATION_RULE_ID','ANTHROPIC_ORGANIZATION_ID','ANTHROPIC_WORKSPACE_ID','ANTHROPIC_AWS_*','ANTHROPIC_BEDROCK_*','ANTHROPIC_VERTEX_*','ANTHROPIC_FOUNDRY_*','AWS_BEARER_TOKEN_BEDROCK','CLAUDE_CODE_USE_BEDROCK','CLAUDE_CODE_USE_VERTEX','CLAUDE_CODE_USE_FOUNDRY','CLAUDE_CODE_SIMPLE'] as const;
export const CODEX_AUTH_VARS = ['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','AITERM_FOUNDRY_KEY'] as const;
// D41: a Codex account config may route Azure through AZURE_OPENAI_API_KEY, so account sessions keep it. A key session still gets only its own key (D16).
const CODEX_KEY_EXTRA_VARS = ['AZURE_OPENAI_API_KEY'] as const;
// Key rows are pure/tested only. No v0.1.6 handler accepts a key or invokes these rows.
export function buildSpawnEnv(engine: AgentEngine, auth: {kind:'account'} | {kind:'key';secret:string;provider?:'openai'}, base: NodeJS.ProcessEnv): Record<string,string> {
    const result=buildShellEnv(base), vars:readonly string[]=engine==='claude-code'?CLAUDE_AUTH_VARS:auth.kind==='key'?[...CODEX_AUTH_VARS,...CODEX_KEY_EXTRA_VARS]:CODEX_AUTH_VARS;
    for(const key of Object.keys(result))if(vars.some(pattern=>pattern.endsWith('*')?key.startsWith(pattern.slice(0,-1)):key===pattern))delete result[key];
    if(auth.kind==='key')result[engine==='claude-code'?'ANTHROPIC_API_KEY':auth.provider==='openai'?'OPENAI_API_KEY':'AITERM_FOUNDRY_KEY']=auth.secret;
    return result;
}
// D40: Ask passes explicit ask flags, or the user's own CLI config (e.g. Codex YOLO) silently turns Ask into Don't ask. Claude 2.1.296 help lists this mode as 'manual'; the CLI maps 'manual' to its canonical 'default'.
const PERMISSION_ARGS:Record<AgentEngine,Record<Permission,readonly string[]>>={
    'claude-code':{ask:['--permission-mode=default'],dontAsk:['--permission-mode=bypassPermissions']},
    codex:{ask:['--ask-for-approval=on-request','--sandbox=workspace-write'],dontAsk:['--ask-for-approval=never','--sandbox=workspace-write']},
};
export function buildArgs(request:{engine:AgentEngine;model:string|null;permission:Permission;firstMessage?:string;foundryEndpoint?:string;openaiKey?:boolean}):string[] {
    if(!isModel(request.model)||!isPermission(request.permission)||request.firstMessage!==undefined&&(Buffer.byteLength(request.firstMessage)>16384||request.firstMessage.includes('\0')))throw new Error('Invalid spawn arguments');
    // D41: without --no-daemon the Codex TUI may join a shared background server started elsewhere, whose env and config win over this recipe's env and -c overrides. Codex rejects the flag twice, so only this line adds it.
    // B5: Codex's startup update menu takes Enter as "Update now"; its own check_for_update_on_startup (config_toml.rs, rust-v0.160.1) turns the check off for this session only.
    const args:string[]=request.engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false']:[];
    if(request.foundryEndpoint!==undefined){
        const endpoint=request.foundryEndpoint;
        let url:URL;try{url=new URL(endpoint);}catch{throw new Error('Invalid Foundry endpoint');}
        if(request.engine!=='codex'||!request.model||url.protocol!=='https:'||!url.hostname||url.username||url.password||/[\s"'\\]/.test(endpoint))throw new Error('Invalid Foundry endpoint');
        for(const config of ['model_provider="aiterm_foundry"','model_providers.aiterm_foundry.name="AI Term Foundry"',`model_providers.aiterm_foundry.base_url="${endpoint}"`,'model_providers.aiterm_foundry.env_key="AITERM_FOUNDRY_KEY"','model_providers.aiterm_foundry.env_http_headers={"api-key"="AITERM_FOUNDRY_KEY"}','model_providers.aiterm_foundry.wire_api="responses"','model_providers.aiterm_foundry.requires_openai_auth=false'])args.push('-c',config);
    }
    if(request.openaiKey){if(request.engine!=='codex')throw new Error('Invalid OpenAI engine');args.push('-c','model_provider="openai"');}
    if(request.model!==null)args.push(`--model=${request.model}`);
    args.push(...PERMISSION_ARGS[request.engine][request.permission]);
    if(request.firstMessage!==undefined)args.push('--',request.firstMessage);
    return args;
}

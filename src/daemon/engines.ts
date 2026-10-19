import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import type { CliEngine, EngineStatus, EnginesStatus, AuthMethod, EngineCheckError, ExtraEngine } from '../shared/protocol.js';
import { EXTRA_ENGINES, EXTRA_ENGINE_FACTS } from '../shared/cli-engines.js';
import { buildExtraEnv, buildSpawnEnv } from './env.js';
import { windowsRecipe } from './win-launch.js';
// Windows (v0.8.2): name.exe (a native install), then name.cmd (npm's launcher, which win-launch.ts reads, never runs),
// folder by folder in PATH order.
export async function resolveExecutable(name:string,path:string,platform:NodeJS.Platform=process.platform):Promise<string|null>{
    if(!/^[A-Za-z0-9._-]+$/.test(name))throw new Error('Invalid executable name');
    const names=platform==='win32'?[`${name}.exe`,`${name}.cmd`]:[name];
    for(const folder of path.split(delimiter)){
        if(!isAbsolute(folder))continue;
        for(const file of names){
            const candidate=join(folder,file);
            try{if(!(await stat(candidate)).isFile())continue;await access(candidate,constants.X_OK);return candidate;}
            catch(error){if(!['ENOENT','ENOTDIR','EACCES'].some(code=>isFsError(error,code)))throw error;}
        }
    }
    return null;
}
// Part B review: Gemini CLI's Don't ask is its yolo mode with --sandbox, which needs a runner: sandbox-exec (Seatbelt) on
// macOS, Docker or Podman elsewhere. Without one it isn't started, so Don't ask never runs unsandboxed.
export const GEMINI_NO_SANDBOX="Gemini CLI's sandbox needs Docker or Podman here · Don't ask is off until one is installed";
export async function geminiSandboxRunner(path:string,platform:NodeJS.Platform=process.platform):Promise<string|null>{
    for(const name of platform==='darwin'?['sandbox-exec']:['docker','podman']){const found=await resolveExecutable(name,path,platform);if(found)return found;}
    return null;
}
export interface EngineRunResult {code:number|null;stdout:string;stderr:string}
export type EngineRunner=(file:string,args:string[],options:{env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number;windowsHide?:boolean})=>Promise<EngineRunResult>;
const run:EngineRunner=(file,args,options)=>new Promise(resolve=>execFile(file,args,options,(error,stdout,stderr)=>resolve({code:error?typeof error.code==='number'?error.code:null:0,stdout,stderr})));
// profileDir (v0.6.4): check that account profile's login, not your normal one.
export async function checkEngine(engine:CliEngine,base:NodeJS.ProcessEnv=process.env,runner:EngineRunner=run,profileDir?:string):Promise<EngineStatus>{
    const env=buildSpawnEnv(engine,{kind:'account'},base,profileDir?{profileDir}:{}), name=engine==='claude-code'?'claude':'codex';
    let path:string|null;
    try{path=await resolveExecutable(name,env.PATH??'');}catch{return {installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown',error:'Engine executable check failed'};}
    if(!path)return {installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'};
    const options={env,timeout:5000,maxBuffer:64*1024,windowsHide:true};
    // Windows: node refuses a .cmd without a shell, so npm's launcher is run as node + its script (win-launch.ts).
    let launch:{executable:string;args:string[]};try{launch=await windowsRecipe({executable:path,args:[]},env.PATH??'');}catch{return {installed:true,path,version:null,loggedIn:null,authMethod:'unknown',error:'Engine executable check failed'};}
    let error:EngineCheckError|undefined;
    let versionResult:EngineRunResult;
    try{versionResult=await runner(launch.executable,[...launch.args,'--version'],options);}catch{versionResult={code:null,stdout:'',stderr:''};}
    if(versionResult.code!==0)error='Engine version check failed';
    const version=versionResult.code===0?(versionResult.stdout+versionResult.stderr).match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0]??null:null;
    let auth:EngineRunResult;
    try{auth=await runner(launch.executable,[...launch.args,...engine==='claude-code'?['auth','status','--json']:['login','status']],options);}catch{auth={code:null,stdout:'',stderr:''};}
    let loggedIn:boolean|null=null,authMethod:AuthMethod='unknown';
    if(engine==='claude-code'){
        let value:unknown;try{value=JSON.parse(auth.stdout) as unknown;}catch{value=null;}
        if(value&&typeof value==='object'&&'loggedIn' in value&&typeof value.loggedIn==='boolean'){
            loggedIn=value.loggedIn;const method='authMethod' in value?value.authMethod:null;
            if(loggedIn)authMethod=method==='claude.ai'?'subscription':method==='api_key'?'api-key':'unknown';
        }
    }else{
        const output=auth.stdout+auth.stderr;
        if(auth.code===0&&/^Logged in using ChatGPT\b/i.test(output.trim())){loggedIn=true;authMethod='subscription';}
        else if(auth.code===0&&/^Logged in using an API key\b/i.test(output.trim())){loggedIn=true;authMethod='api-key';}
        else if(auth.code===1&&/^Not logged in\b/i.test(output.trim()))loggedIn=false;
    }
    if(loggedIn===null)error='Engine login check failed';
    return {installed:true,path,version,loggedIn,authMethod,...(error?{error}:{})};
}
// Part B: the added CLIs. Found on PATH with the account env they will run in, version from --version; their login status
// is the CLI's own business (none documents a status AI Term could read without touching its files), so it is unknown and
// the CLI asks you to sign in when it needs to. Cursor's `agent` counts only when its own --help names Cursor.
export async function checkExtraEngine(engine:ExtraEngine,base:NodeJS.ProcessEnv=process.env,runner:EngineRunner=run,profileDir?:string):Promise<EngineStatus>{
    const env=buildExtraEnv(engine,base,profileDir?{profileDir}:{}),options={env,timeout:5000,maxBuffer:64*1024,windowsHide:true};
    const missing:EngineStatus={installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'};
    for(const name of EXTRA_ENGINE_FACTS[engine].executables){
        let path:string|null;
        try{path=await resolveExecutable(name,env.PATH??'');}catch{return {...missing,error:'Engine executable check failed'};}
        if(!path)continue;
        let launch:{executable:string;args:string[]};try{launch=await windowsRecipe({executable:path,args:[]},env.PATH??'');}catch{continue;}
        if(engine==='cursor'&&name==='agent'){
            let help:EngineRunResult;try{help=await runner(launch.executable,[...launch.args,'--help'],options);}catch{continue;}
            if(!/\bcursor\b/i.test(help.stdout+help.stderr))continue;
        }
        let versionResult:EngineRunResult;
        try{versionResult=await runner(launch.executable,[...launch.args,'--version'],options);}catch{versionResult={code:null,stdout:'',stderr:''};}
        const version=versionResult.code===0?(versionResult.stdout+versionResult.stderr).match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0]??null:null;
        return {installed:true,path,version,loggedIn:null,authMethod:'unknown',...(versionResult.code===0?{}:{error:'Engine version check failed' as const})};
    }
    return missing;
}
export async function enginesStatus(base:NodeJS.ProcessEnv=process.env):Promise<EnginesStatus>{
    const [claudeCode,codex,cursor,gemini,copilot]=await Promise.all([checkEngine('claude-code',base),checkEngine('codex',base),...EXTRA_ENGINES.map(engine=>checkExtraEngine(engine,base))]);
    return {claudeCode,codex,extra:{...(cursor?{cursor}:{}),...(gemini?{gemini}:{}),...(copilot?{copilot}:{})}};
}

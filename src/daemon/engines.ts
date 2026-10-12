import { execFile } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import type { AgentEngine, EngineStatus, EnginesStatus, AuthMethod } from '../shared/protocol.js';
import { buildSpawnEnv } from './env.js';
export async function resolveExecutable(name:string,path:string):Promise<string|null>{
    if(!/^[A-Za-z0-9._-]+$/.test(name))throw new Error('Invalid executable name');
    for(const folder of path.split(delimiter)){
        if(!isAbsolute(folder))continue;
        const candidate=join(folder,name);
        try{if(!(await stat(candidate)).isFile())continue;await access(candidate,constants.X_OK);return candidate;}
        catch(error){if(!['ENOENT','ENOTDIR','EACCES'].some(code=>isFsError(error,code)))throw error;}
    }
    return null;
}
export interface EngineRunResult {code:number|null;stdout:string;stderr:string}
export type EngineRunner=(file:string,args:string[],options:{env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number})=>Promise<EngineRunResult>;
const run:EngineRunner=(file,args,options)=>new Promise(resolve=>execFile(file,args,options,(error,stdout,stderr)=>resolve({code:error?typeof error.code==='number'?error.code:null:0,stdout,stderr})));
export async function checkEngine(engine:AgentEngine,base:NodeJS.ProcessEnv=process.env,runner:EngineRunner=run):Promise<EngineStatus>{
    const env=buildSpawnEnv(engine,{kind:'account'},base), name=engine==='claude-code'?'claude':'codex';
    const path=await resolveExecutable(name,env.PATH??'');
    if(!path)return {installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'};
    const options={env,timeout:5000,maxBuffer:64*1024};
    const versionResult=await runner(path,['--version'],options);
    const version=versionResult.code===0?(versionResult.stdout+versionResult.stderr).match(/\b\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?\b/)?.[0]??null:null;
    const auth=await runner(path,engine==='claude-code'?['auth','status','--json']:['login','status'],options);
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
    return {installed:true,path,version,loggedIn,authMethod};
}
export async function enginesStatus(base:NodeJS.ProcessEnv=process.env):Promise<EnginesStatus>{
    const [claudeCode,codex]=await Promise.all([checkEngine('claude-code',base),checkEngine('codex',base)]);
    return {claudeCode,codex};
}

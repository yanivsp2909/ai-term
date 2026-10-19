import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveExecutable, checkEngine } from '../src/daemon/engines.js';
import { CLAUDE_AUTH_VARS, CODEX_AUTH_VARS } from '../src/daemon/env.js';
it('resolves the first regular executable file from absolute PATH entries',async()=>{
 const root=await mkdtemp('/tmp/ai-engines-');try{
  await mkdir(join(root,'a'));await mkdir(join(root,'b'));await mkdir(join(root,'a','claude'));await writeFile(join(root,'b','claude'),'stub',{mode:0o700});
  expect(await resolveExecutable('claude',`.:${root}/a:${root}/b`)).toBe(join(root,'b','claude'));
  expect(await resolveExecutable('codex',root)).toBeNull();
 }finally{await rm(root,{recursive:true,force:true});}
});
it('execFile checks use cleaned session env, argv arrays, 5s timeout and drop all private CLI fields',async()=>{
 const root=await mkdtemp('/tmp/ai-eng-check-');try{
  for(const name of ['claude','codex'])await writeFile(join(root,name),'stub',{mode:0o700});
  for(const engine of ['claude-code','codex'] as const){
   const run=vi.fn(async(_file:string,args:string[],_options:{env:NodeJS.ProcessEnv;timeout:number;maxBuffer:number})=>{expect(_options.timeout).toBe(5000);return {code:0,stdout:args[0]==='--version'?'tool 2.1.295 PRIVATE':engine==='claude-code'?JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'PRIVATE',secret:'sk-ant-' + 'AITERMCANARY0000'}):'',stderr:engine==='codex'&&args[0]!=='--version'?'Logged in using an API key - sk-ant-AITERMCANARY0000':''};});
   const vars=engine==='claude-code'?CLAUDE_AUTH_VARS:CODEX_AUTH_VARS;
   const base={PATH:root,...Object.fromEntries(vars.map(v=>[v.replace('*','TEST'),'private']))};
   const status=await checkEngine(engine,base,run);expect(status).toMatchObject({installed:true,version:'2.1.295',loggedIn:true,authMethod:engine==='claude-code'?'subscription':'api-key'});expect(JSON.stringify(status)).not.toMatch(/PRIVATE|AITERMCANARY/);
   expect(run.mock.calls[1]?.[1]).toEqual(engine==='claude-code'?['auth','status','--json']:['login','status']);
   for(const call of run.mock.calls){expect(call[2].timeout).toBe(5000);for(const v of vars)expect(call[2].env[v.replace('*','TEST')]).toBeUndefined();}
   const unknown=await checkEngine(engine,base,async()=>({code:null,stdout:'PRIVATE',stderr:'PRIVATE'}));expect(unknown.loggedIn).toBeNull();
  }
 }finally{await rm(root,{recursive:true,force:true});}
});

import { expect, it } from 'vitest';
import { buildArgs, buildSpawnEnv, CLAUDE_AUTH_VARS, CODEX_AUTH_VARS } from '../src/daemon/env.js';
const canary='sk-ant-AITERMCANARY0000';
const base={PATH:'/usr/bin:/bin',HOME:'/tmp/ai-env',OPENAI_API_KEY:'openai',ANTHROPIC_API_KEY:'anthropic',npm_test:'remove',AI_TERM_HOME:'remove',NPM_TOKEN:'keep'};
it('S6 removes every own-provider auth/routing variable, leaves other provider vars, and returns fresh env',()=>{
 for(const [engine,vars,other] of [['claude-code',CLAUDE_AUTH_VARS,'OPENAI_API_KEY'],['codex',CODEX_AUTH_VARS,'ANTHROPIC_API_KEY']] as const){
  const all={...base,...Object.fromEntries(vars.map(key=>[key.replace('*','CANARY'),'private']))};
  const env=buildSpawnEnv(engine,{kind:'account'},all);
  for(const key of vars)expect(env[key.replace('*','CANARY')]).toBeUndefined();expect(env[other]).toBe(base[other]);
  expect(env).toMatchObject({TERM:'xterm-256color',COLORTERM:'truecolor',TERM_PROGRAM:'AITerm',LANG:'en_US.UTF-8',NPM_TOKEN:'keep'});
  expect(env.npm_test).toBeUndefined();expect(env.AI_TERM_HOME).toBeUndefined();env.PATH='changed';expect(buildSpawnEnv(engine,{kind:'account'},all).PATH).toBe('/usr/bin:/bin');expect(all.PATH).toBe('/usr/bin:/bin');
 }
});
it('S7 key rows set only own secret and strip other own-provider credentials',()=>{
 const all={...base,...Object.fromEntries([...CLAUDE_AUTH_VARS,...CODEX_AUTH_VARS].map(key=>[key.replace('*','CANARY'),'private']))};
 for(const [engine,key,vars] of [['claude-code','ANTHROPIC_API_KEY',CLAUDE_AUTH_VARS],['codex','AITERM_FOUNDRY_KEY',CODEX_AUTH_VARS]] as const){
  const env=buildSpawnEnv(engine,{kind:'key',secret:canary},all);expect(env[key]).toBe(canary);
  for(const v of vars)if(v!==key)expect(env[v.replace('*','CANARY')]).toBeUndefined();
 }
 expect(buildSpawnEnv('claude-code',{kind:'account'},{LC_ALL:'custom'}).LANG).toBeUndefined();
});
it('S9/S10 builds argv only with validated model, positional first message and explicit per-session permissions',()=>{
 for(const engine of ['claude-code','codex'] as const){
  expect(buildArgs({engine,model:null,permission:'ask'})).toEqual([]);
  expect(buildArgs({engine,model:'test-model',permission:'ask',firstMessage:'$(touch nope) "hello"'})).toEqual(['--model=test-model','--','$(touch nope) "hello"']);
  expect(buildArgs({engine,model:null,permission:'dontAsk'})).toEqual(engine==='claude-code'?['--permission-mode=bypassPermissions']:['--ask-for-approval=never','--sandbox=workspace-write']);
  for(const model of ['-x','a b','"x"'])expect(()=>buildArgs({engine,model,permission:'ask'})).toThrow();
 }
});
it('Foundry args carry validated endpoint and env variable name, never secret, and use no-daemon',()=>{
 const args=buildArgs({engine:'codex',model:'deployment',permission:'ask',foundryEndpoint:'https://example.openai.azure.com/openai/v1'});
 expect(args).toContain('--no-daemon');expect(args).toContain('model_providers.aiterm_foundry.env_key="AITERM_FOUNDRY_KEY"');expect(args.join(' ')).not.toContain(canary);
 expect(args).toContain('model_providers.aiterm_foundry.wire_api="responses"');
 for(const endpoint of ['http://example.com','https://bad.com/"','https://bad.com/ space'])expect(()=>buildArgs({engine:'codex',model:'deployment',permission:'ask',foundryEndpoint:endpoint})).toThrow();
});
it('S6 recipe in a real stub child exposes no own-provider auth variables',async()=>{
 const {execFile}=await import('node:child_process');
 for(const [engine,vars] of [['claude-code',CLAUDE_AUTH_VARS],['codex',CODEX_AUTH_VARS]] as const){
  const base={...Object.fromEntries(vars.map(v=>[v.replace('*','TEST'),canary]))};
  const env=buildSpawnEnv(engine,{kind:'account'},base);
  const source='const names='+JSON.stringify(vars)+';process.stdout.write(JSON.stringify(names.filter(p=>Object.keys(process.env).some(k=>p.endsWith("*")?k.startsWith(p.slice(0,-1)):k===p))));';
  const stdout=await new Promise<string>((resolve,reject)=>execFile(process.execPath,['-e',source],{env,timeout:2000},(error,out)=>error?reject(error):resolve(out)));
  expect(stdout).toBe('[]');
 }
});

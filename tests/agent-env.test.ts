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
it('B2/D41 Codex account env keeps AZURE_OPENAI_API_KEY and strips every other listed Codex variable; key rows unchanged',()=>{
 const stripped=['OPENAI_API_KEY','CODEX_API_KEY','OPENAI_BASE_URL','OPENAI_ORG_ID','OPENAI_ORGANIZATION','OPENAI_PROJECT_ID','AITERM_FOUNDRY_KEY','CODEX_ACCESS_TOKEN','OPENAI_FEDERATION_RULE_ID','OPENAI_IDENTITY_TOKEN_FILE'];
 expect(CODEX_AUTH_VARS).toEqual(stripped);
 const all={...base,AZURE_OPENAI_API_KEY:'azure',...Object.fromEntries(stripped.map(key=>[key,'private']))};
 const account=buildSpawnEnv('codex',{kind:'account'},all);
 expect(account.AZURE_OPENAI_API_KEY).toBe('azure');for(const key of stripped)expect(account[key]).toBeUndefined();
 const foundry=buildSpawnEnv('codex',{kind:'key',secret:canary},all);
 expect(foundry.AITERM_FOUNDRY_KEY).toBe(canary);expect(foundry.AZURE_OPENAI_API_KEY).toBeUndefined();for(const key of stripped)if(key!=='AITERM_FOUNDRY_KEY')expect(foundry[key]).toBeUndefined();
 expect(buildSpawnEnv('claude-code',{kind:'account'},all).AZURE_OPENAI_API_KEY).toBe('azure');
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
  const daemon=engine==='codex'?['--no-daemon','-c','check_for_update_on_startup=false']:[];
  const ask=engine==='claude-code'?['--permission-mode=default']:['--ask-for-approval=on-request','--sandbox=workspace-write'];
  const dontAsk=engine==='claude-code'?['--permission-mode=bypassPermissions']:['--ask-for-approval=never','--sandbox=workspace-write'];
  expect(buildArgs({engine,model:null,permission:'ask'})).toEqual([...daemon,...ask]);
  expect(buildArgs({engine,model:'test-model',permission:'ask',firstMessage:'$(touch nope) "hello"'})).toEqual([...daemon,'--model=test-model',...ask,'--','$(touch nope) "hello"']);
  expect(buildArgs({engine,model:null,permission:'dontAsk'})).toEqual([...daemon,...dontAsk]);
  expect(buildArgs({engine,model:'test-model',permission:'dontAsk',firstMessage:'reply with ok'})).toEqual([...daemon,'--model=test-model',...dontAsk,'--','reply with ok']);
  for(const model of ['-x','a b','"x"'])expect(()=>buildArgs({engine,model,permission:'ask'})).toThrow();
 }
});
it('B3/D40 Ask passes explicit ask flags on every path, and no permission choice ever passes a bypass flag',()=>{
 const forbidden=['--dangerously-skip-permissions','--yolo','--dangerously-bypass-approvals-and-sandbox','--full-auto','danger-full-access','--approve-for-me','--permission-mode=dontAsk'];
 const foundryEndpoint='https://example.openai.azure.com/openai/v1';
 for(const engine of ['claude-code','codex'] as const)for(const permission of ['ask','dontAsk'] as const)for(const foundry of [false,true]){
  if(foundry&&engine!=='codex')continue;
  const args=buildArgs({engine,model:'deployment',permission,...foundry?{foundryEndpoint}:{}});
  expect(args.filter(arg=>forbidden.some(flag=>arg.includes(flag)))).toEqual([]);
  if(permission==='ask')expect(args.slice(-(engine==='claude-code'?1:2))).toEqual(engine==='claude-code'?['--permission-mode=default']:['--ask-for-approval=on-request','--sandbox=workspace-write']);
 }
});
it('B2/D41 every Codex argv starts with exactly one --no-daemon, which Codex rejects twice; Claude never gets it',()=>{
 const foundryEndpoint='https://example.openai.azure.com/openai/v1';
 for(const permission of ['ask','dontAsk'] as const)for(const model of [null,'deployment'])for(const firstMessage of [undefined,'reply with ok'])for(const foundry of [false,true]){
  if(foundry&&model===null)continue;
  const request={model,permission,...firstMessage===undefined?{}:{firstMessage},...foundry?{foundryEndpoint}:{}};
  const codex=buildArgs({engine:'codex',...request});
  expect(codex[0]).toBe('--no-daemon');expect(codex.filter(arg=>arg==='--no-daemon')).toHaveLength(1);
  if(!foundry)expect(buildArgs({engine:'claude-code',...request})).not.toContain('--no-daemon');
 }
});
it('B5 every Codex argv skips the startup update check, whose menu takes Enter as "Update now"; Claude never gets it',()=>{
 const foundryEndpoint='https://example.openai.azure.com/openai/v1';
 for(const permission of ['ask','dontAsk'] as const)for(const model of [null,'deployment'])for(const firstMessage of [undefined,'reply with ok'])for(const foundry of [false,true]){
  if(foundry&&model===null)continue;
  const request={model,permission,...firstMessage===undefined?{}:{firstMessage},...foundry?{foundryEndpoint}:{}};
  const codex=buildArgs({engine:'codex',...request});
  expect(codex.slice(0,3)).toEqual(['--no-daemon','-c','check_for_update_on_startup=false']);expect(codex.filter(arg=>arg.includes('check_for_update_on_startup'))).toHaveLength(1);
  if(!foundry)expect(buildArgs({engine:'claude-code',...request}).join(' ')).not.toContain('check_for_update_on_startup');
 }
});
it('Foundry args carry validated endpoint and env variable name, never secret, and use no-daemon',()=>{
 const args=buildArgs({engine:'codex',model:'deployment',permission:'ask',foundryEndpoint:'https://example.openai.azure.com/openai/v1'});
 expect(args).toContain('--no-daemon');expect(args).toContain('model_providers.aiterm_foundry.env_key="AITERM_FOUNDRY_KEY"');expect(args.join(' ')).not.toContain(canary);
 expect(args).toContain('model_providers.aiterm_foundry.wire_api="responses"');
 for(const endpoint of ['http://example.com','https://bad.com/"','https://bad.com/ space'])expect(()=>buildArgs({engine:'codex',model:'deployment',permission:'ask',foundryEndpoint:endpoint})).toThrow();
});
it('S6 recipe in a real stub child exposes no own-provider auth variables and keeps AZURE_OPENAI_API_KEY (D41)',async()=>{
 const {execFile}=await import('node:child_process');
 for(const [engine,vars] of [['claude-code',CLAUDE_AUTH_VARS],['codex',CODEX_AUTH_VARS]] as const){
  const base={AZURE_OPENAI_API_KEY:canary,...Object.fromEntries(vars.map(v=>[v.replace('*','TEST'),canary]))};
  const env=buildSpawnEnv(engine,{kind:'account'},base);
  const source='const names='+JSON.stringify(vars)+';process.stdout.write(JSON.stringify([names.filter(p=>Object.keys(process.env).some(k=>p.endsWith("*")?k.startsWith(p.slice(0,-1)):k===p)),"AZURE_OPENAI_API_KEY" in process.env]));';
  const stdout=await new Promise<string>((resolve,reject)=>execFile(process.execPath,['-e',source],{env,timeout:2000},(error,out)=>error?reject(error):resolve(out)));
  expect(stdout).toBe('[[],true]');
 }
});
it('OpenAI key sessions strip Codex routing credentials and use the OpenAI env key, never argv',()=>{
 const env=buildSpawnEnv('codex',{kind:'key',secret:canary,provider:'openai'},{AZURE_OPENAI_API_KEY:'azure',AITERM_FOUNDRY_KEY:'foundry',OPENAI_BASE_URL:'https://other',OPENAI_API_KEY:'old'});
 expect(env.OPENAI_API_KEY).toBe(canary);expect(env.AITERM_FOUNDRY_KEY).toBeUndefined();expect(env.AZURE_OPENAI_API_KEY).toBeUndefined();expect(env.OPENAI_BASE_URL).toBeUndefined();const args=buildArgs({engine:'codex',model:'gpt-6.1-sol',permission:'ask',openaiKey:true});expect(args).toContain('model_provider="openai"');expect(args.join(' ')).not.toContain(canary);
});

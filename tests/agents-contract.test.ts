import { afterEach, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validateRequest, validateSession, validateSuccess } from '../src/shared/validate.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { Logger } from '../src/daemon/log.js';
const roots:string[]=[];afterEach(async()=>{for(const p of roots.splice(0))await rm(p,{recursive:true,force:true});});
async function root(){const p=await mkdtemp('/tmp/ai-contract-');roots.push(p);return p;}
it('validates account agent requests, default/custom models and every new field',async()=>{
 const cwd=await root(),base={id:randomUUID(),kind:'sessions.create',engine:'claude-code',model:null,auth:{kind:'account'},cwd,permission:'ask',firstMessage:'reply with ok'};
 expect(await validateRequest(base)).toEqual(base);
 expect(await validateRequest({...base,engine:'codex',model:'gpt-6.1-sol',permission:'dontAsk'})).toMatchObject({model:'gpt-6.1-sol'});
 for(const patch of [{engine:'bad'},{model:'-x'},{model:'bad id'},{model:'"bad"'},{model:3},{auth:{kind:'key',keyId:'bad'}},{permission:'bad'},{firstMessage:3},{firstMessage:'x'.repeat(16385)},{firstMessage:'\0'},{cwd:join(cwd,'missing')},{cwd:join(cwd,'file')},{extra:true}])await expect(validateRequest({...base,...patch})).rejects.toThrow();
 await writeFile(join(cwd,'file'),'file');await expect(validateRequest({...base,cwd:join(cwd,'file')})).rejects.toThrow();
 expect(await validateRequest({...base,title:'\x1b[31m title\x1b[0m'})).toMatchObject({title:'title'});
 expect(await validateRequest({id:randomUUID(),kind:'engines.status'})).toMatchObject({kind:'engines.status'});
});
it('loads current shell state and new finished agent state without losing records',async()=>{
 const cwd=await root(),p=getPaths(cwd);await preparePaths(p);const now=new Date().toISOString();
 const shell={id:randomUUID(),title:'shell',engine:'shell',model:'shell',auth:{kind:'account'},cwd,permission:'ask',status:'exited',statusDetail:'exit 0',statusSince:now,createdAt:now,exitCode:0,lastOutputAt:null,ctxPercent:null};
 const agent={...shell,id:randomUUID(),title:'agent',engine:'codex',model:null,permission:'dontAsk',authMethod:'api-key',status:'error',exitCode:3};
 expect(validateSession(agent)).toMatchObject({model:null,permission:'dontAsk'});
 await writeFile(p.state,JSON.stringify({sessions:[{...shell,pid:null,recipe:{engine:'shell',model:'shell',auth:{kind:'account'},cwd,permission:'ask'}},agent]}));
 const m=new SessionManager(p,new Logger(p.log));try{await m.load();expect(m.list()).toHaveLength(2);expect(m.list()[0]).toMatchObject(shell);expect(m.list()[1]).toMatchObject(agent);}finally{await m.shutdown();}
});
it('merges settings patches, preserving unknown keys and rejecting a dontAsk default',async()=>{
 const p=await root(),store=new SettingsStore(p);await writeFile(join(p,'settings.json'),JSON.stringify({theme:'slate',future:{keep:true},defaultEngine:'codex',defaultModel:null}));
 expect(await store.set({theme:'ink'})).toMatchObject({theme:'ink',future:{keep:true},defaultEngine:'codex'});
 expect(JSON.parse(await readFile(join(p,'settings.json'),'utf8'))).toMatchObject({future:{keep:true}});
 expect(()=>store.set({permission:'dontAsk'} as unknown as import('../src/shared/protocol.js').SettingsPatch)).toThrow();
 expect(await validateRequest({id:randomUUID(),kind:'settings.set',patch:{defaultEngine:'claude-code',defaultModel:'sonnet'}})).toMatchObject({patch:{defaultModel:'sonnet'}});
 expect(()=>validateSuccess({id:randomUUID(),ok:true,engines:{claudeCode:{installed:true,path:'/bin/claude',version:'2.1.295',loggedIn:true,authMethod:'subscription'},codex:{installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'}}})).not.toThrow();
});
it('rejects private auth and engine fields at response boundaries',()=>{
 const now=new Date().toISOString();
 const session={id:randomUUID(),title:'agent',engine:'codex',model:null,auth:{kind:'account',secret:'sk-ant-' + 'AITERMCANARY0000'},cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};
 expect(()=>validateSession(session)).toThrow();
 expect(()=>validateSuccess({id:randomUUID(),ok:true,engines:{claudeCode:{installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown',email:'PRIVATE'},codex:{installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'}}})).toThrow();
});
it('settings patches cannot smuggle secret fields while preserving unknown stored settings',async()=>{
 for(const patch of [{secret:'sk-ant-' + 'AITERMCANARY0000'},{defaultPermission:'dontAsk'},{future:'sk-ant-AITERMCANARY0000'}])await expect(validateRequest({id:randomUUID(),kind:'settings.set',patch})).rejects.toThrow();
});

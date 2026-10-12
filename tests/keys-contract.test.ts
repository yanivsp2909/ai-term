import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { validateRequest, validateSuccess, validateSession } from '../src/shared/validate.js';
const id=randomUUID(), keyId=randomUUID(), secret='sk-ant-'+'AITERMCANARY0000';
it('defines all keys requests and key-auth sessions without a secret response',async()=>{
 for(const request of [
  {id,kind:'keys.list'}, {id,kind:'keys.add',provider:'anthropic',label:'personal',secret},
  {id,kind:'keys.add',provider:'foundry',label:'Azure',secret,endpoint:'https://example.openai.azure.com/openai/v1',deployments:['gpt-6.1-sol']},
  {id,kind:'keys.remove',keyId},{id,kind:'keys.test',keyId},{id,kind:'keys.scanEnvFile',path:'/tmp/ai-test.env'},{id,kind:'keys.importEnv',path:'/tmp/ai-test.env',names:['ANTHROPIC_API_KEY']},
  {id,kind:'sessions.create',engine:'codex',model:'gpt-6.1-sol',auth:{kind:'key',keyId},cwd:'/tmp',permission:'ask'},
  {id,kind:'sessions.create',engine:'codex',model:null,auth:{kind:'account'},cwd:'/tmp',permission:'ask',login:true},
 ]) expect(await validateRequest(request)).toMatchObject({kind:request.kind});
 const key={id:keyId,provider:'anthropic',label:'personal',last4:'0000'};
 expect(()=>validateSuccess({id,ok:true,keys:[key]})).not.toThrow();
 expect(()=>validateSuccess({id,ok:true,key:{...key,secret}})).toThrow();
 const now=new Date().toISOString();expect(()=>validateSession({id,title:'key agent',engine:'claude-code',model:'sonnet',auth:{kind:'key',keyId,provider:'anthropic',keyLabel:'personal',last4:'0000'},permission:'ask',cwd:'/tmp',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null})).not.toThrow();
});
it('rejects malformed secrets providers endpoints deployments and import selectors with fixed messages',async()=>{
 for(const patch of [{secret:''},{secret:'a b'},{secret:'x'.repeat(513)},{provider:'bad'},{endpoint:'http://host'},{endpoint:'https://host/"'},{endpoint:'https://host/ space'},{deployments:['-bad']},{label:'\x1b[31m'}])await expect(validateRequest({id,kind:'keys.add',provider:'foundry',label:'test',secret,endpoint:'https://example.com',deployments:['gpt-6.1-sol'],...patch})).rejects.toThrow();
 await expect(validateRequest({id,kind:'keys.importEnv',path:'/tmp/f',names:['PASSWORD']})).rejects.toThrow();
 await expect(validateRequest({id,kind:'keys.remove',keyId:'bad'})).rejects.toThrow();
});
it('key metadata in settings is validated and private fields never pass to clients',()=>{
 const key={id:keyId,provider:'anthropic',label:'test',last4:'0000',secret};expect(()=>validateSuccess({id,ok:true,settings:{theme:'graphite',keys:[key]}})).toThrow();
});
it('login sessions are account-only and model-less and Foundry metadata always has routing details',async()=>{
 await expect(validateRequest({id,kind:'sessions.create',engine:'codex',model:'test',auth:{kind:'account'},cwd:'/tmp',permission:'ask',login:true})).rejects.toThrow();
 expect(()=>validateSuccess({id,ok:true,key:{id:keyId,provider:'foundry',label:'Azure',last4:'0000'}})).toThrow();
});

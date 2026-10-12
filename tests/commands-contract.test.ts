import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {validateRequest,validateSession,validateSettings} from '../src/shared/validate.js';
const id=randomUUID();
it('accepts engine-specific effort and auto mode but keeps saved permission Ask only',async()=>{
 const cwd=await mkdtemp('/tmp/ai-command-contract-');try{
 for(const [engine,effort]of [['claude-code','max'],['codex','ultra']]as const)expect(await validateRequest({id,kind:'sessions.create',engine,effort,model:null,auth:{kind:'account'},cwd,permission:'ask'})).toMatchObject({effort});
 expect(await validateRequest({id,kind:'sessions.create',engine:'claude-code',effort:null,model:null,auth:{kind:'account'},cwd,permission:'auto'})).toMatchObject({permission:'auto'});
 for(const [engine,effort,permission]of [['claude-code','none','ask'],['codex','high','auto'],['codex','high"','ask'],['codex','-high','ask']])await expect(validateRequest({id,kind:'sessions.create',engine,effort,model:null,auth:{kind:'account'},cwd,permission})).rejects.toThrow();
 expect(await validateRequest({id,kind:'sessions.resume',sessionId:randomUUID()})).toMatchObject({kind:'sessions.resume'});await expect(validateRequest({id,kind:'sessions.resume',sessionId:'--bad'})).rejects.toThrow();
 expect(validateSettings({theme:'graphite',defaultEngine:'codex',defaultEffort:'ultra',permission:'ask'})).toMatchObject({defaultEffort:'ultra'});for(const permission of ['auto','dontAsk'])expect(()=>validateSettings({theme:'graphite',permission})).toThrow();
 }finally{await rm(cwd,{recursive:true,force:true});}
});
it('conversation UUID and effort validate in records while old records remain readable',()=>{
 const now=new Date().toISOString(),old={id,title:'old',engine:'claude-code',model:null,auth:{kind:'account'},cwd:'/tmp',permission:'ask',status:'exited',statusDetail:'exit 0',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:0,ctxPercent:null};
 expect(validateSession(old)).toEqual(old);expect(validateSession({...old,conversationId:randomUUID(),effort:'high',permission:'auto'})).toMatchObject({effort:'high'});for(const patch of [{conversationId:'--bad'},{effort:'none'},{engine:'codex',permission:'auto'},{engine:'shell',conversationId:randomUUID()}])expect(()=>validateSession({...old,...patch})).toThrow();
});
it('new effort and UUID fields reject malformed socket values and session records',async()=>{const cwd=await mkdtemp('/tmp/ai-command-invalid-');try{for(const engine of ['claude-code','codex']as const)for(const effort of [3,{},'high;touch /tmp/no','high\u001b'])await expect(validateRequest({id,kind:'sessions.create',engine,model:null,auth:{kind:'account'},cwd,permission:'ask',effort})).rejects.toThrow();await expect(validateRequest({id,kind:'sessions.create',engine:'claude-code',model:null,auth:{kind:'account'},cwd,permission:'ask',conversationId:randomUUID()})).rejects.toThrow();}finally{await rm(cwd,{recursive:true,force:true});}});

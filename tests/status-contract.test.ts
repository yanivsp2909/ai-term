import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {validateSession,validateSuccess,validateRequest,validateSessionText} from '../src/shared/validate.js';
const id=randomUUID(),now=new Date().toISOString();
const session={id,title:'Claude',engine:'claude-code',model:null,auth:{kind:'account'},cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};
it('status contract accepts context and activity on both response paths while legacy records stay valid',()=>{
 expect(validateSession(session)).toEqual(session);
 for(const status of ['starting','running','waiting','done','exited','error']){
  const info={...session,status,statusDetail:status==='waiting'?'permission':status,ctxPercent:45.5,lastActivity:{tool:'Bash',at:now}};
  expect(validateSession(info)).toEqual(info);expect(()=>validateSuccess({id,ok:true,sessions:[info]})).not.toThrow();
 }
 for(const patch of [{status:'idle'},{ctxPercent:-1},{ctxPercent:101},{ctxPercent:'4'},{ctxPercent:NaN},{lastActivity:{tool:'Bash',at:'bad'}},{lastActivity:{tool:'Bash',at:now,raw:'AITERMCANARY'}},{lastActivity:{tool:'x\x1b',at:now}}])expect(()=>validateSession({...session,...patch})).toThrow();
});
it('explicit last-reply copy requests and source are validated',async()=>{
 expect(await validateRequest({id,kind:'sessions.text',sessionId:id,lastReply:true})).toMatchObject({lastReply:true});
 await expect(validateRequest({id,kind:'sessions.text',sessionId:id,lastReply:'yes'})).rejects.toThrow();
 expect(validateSessionText({sessionId:id,text:'reply',truncated:false,source:'last-reply'})).toMatchObject({source:'last-reply'});
 expect(()=>validateSessionText({sessionId:id,text:'reply',truncated:false,source:'raw'})).toThrow();
});

import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {validateRequest,validateSuccess} from '../src/shared/validate.js';
import {MAX_COPY_BYTES} from '../src/shared/protocol.js';
const id=randomUUID(),sessionId=randomUUID();
it('text export takes only a validated UUID and copy replies are bounded plain text',async()=>{
 expect(await validateRequest({id,kind:'sessions.text',sessionId})).toEqual({id,kind:'sessions.text',sessionId});
 for(const value of ['--bad',null,3])await expect(validateRequest({id,kind:'sessions.text',sessionId:value})).rejects.toThrow();await expect(validateRequest({id,kind:'sessions.text',sessionId,raw:true})).rejects.toThrow();
 expect(validateSuccess({id,ok:true,copy:{sessionId,text:'AITERMCANARY\nhello',truncated:false}})).toMatchObject({copy:{text:'AITERMCANARY\nhello'}});expect(MAX_COPY_BYTES).toBe(5*1024*1024);
 for(const copy of [{sessionId,text:'\x1b[31mred',truncated:false},{sessionId,text:'hello\0',truncated:false},{sessionId,text:'hello',truncated:'yes'},{sessionId:'bad',text:'hello',truncated:false},{sessionId,text:'x'.repeat(5*1024*1024+1),truncated:true},{sessionId,text:'x',truncated:false,more:'yes'}])expect(()=>validateSuccess({id,ok:true,copy})).toThrow();
});

import { expect, it } from 'vitest';
import { validateSuccess } from '../src/shared/validate.js';
import { randomUUID } from 'node:crypto';
it('rejects malformed success responses and hello protocol mismatches',()=>{
 const id=randomUUID();
 expect(()=>validateSuccess({id,ok:true,kind:'hello',protocol:1,version:'0.1.1',daemonPid:123})).not.toThrow();
 for(const value of [{id,ok:true,kind:'hello'},{id,ok:true,kind:'hello',protocol:999,version:'ok',daemonPid:123},{id,ok:true,snapshot:'text',cols:0,rows:999},{id,ok:true,sessions:[{}]}])expect(()=>validateSuccess(value)).toThrow();
});

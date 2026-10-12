import { expect, it } from 'vitest';
import { testFoundry, type ProviderRequest } from '../src/daemon/providers/foundry.js';
const secret='sk-ant-'+'AITERMCANARY0000';
it('returns ready, not a chat model and error using only the configured https host and api-key header',async()=>{
 const calls:ProviderRequest[]=[];const results=await testFoundry('https://example.com/openai/v1',['ready','chat','bad'],secret,async request=>{calls.push(request);return request.model==='ready'?{status:200,errorCode:null}:request.model==='chat'?{status:request.path.endsWith('/responses')?404:200,errorCode:null}:{status:401,errorCode:'Unauthorized'};});
 expect(results.map(r=>r.status)).toEqual(['ready','not a chat model','error']);expect(results[2]).toMatchObject({httpStatus:401,errorCode:'Unauthorized'});
 for(const call of calls){expect(call.url.origin).toBe('https://example.com');expect(call.headers).toEqual({'api-key':secret,'content-type':'application/json'});expect(call.timeout).toBe(15000);expect(JSON.stringify(call.body)).not.toContain(secret);}
 expect(JSON.stringify(results)).not.toContain('AITERMCANARY');
 await expect(testFoundry('http://example.com',['ready'],secret)).rejects.toThrow();
});
it('redacts provider error codes and rejects redirect/body content instead of exposing it',async()=>{
 const results=await testFoundry('https://example.com',['test'],secret,async()=>({status:302,errorCode:secret}));expect(results).toEqual([{model:'test',status:'error',httpStatus:302}]);
});

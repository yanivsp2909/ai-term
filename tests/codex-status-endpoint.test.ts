import {expect,it} from 'vitest';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {UsageReceiver} from '../src/daemon/usage-receiver.js';
function send(port:number,token:string,options:{path?:string;method?:string;body?:string;headers?:Record<string,string|undefined>;chunked?:boolean}={}){return new Promise<{status:number;body:string}>((resolve,reject)=>{const body=options.body??'{}',req=request({hostname:'127.0.0.1',port,path:options.path??'/v1/status/codex',method:options.method??'POST',headers:{'content-type':'application/json','x-ai-term-session':token,...(options.chunked?{'transfer-encoding':'chunked'}:{'content-length':String(Buffer.byteLength(body))}),...options.headers}},res=>{let text='';res.on('data',d=>{text+=String(d);});res.on('end',()=>resolve({status:res.statusCode??0,body:text}));});req.on('error',reject);req.end(body);});}
it('Codex status resolves identity from its own credential and engine path, always empty 204',async()=>{
 const updates:{id:string;engine:string;seq:number}[]=[],receiver=new UsageReceiver(async()=>{}, {error:()=>{}},async(id,_raw,seq,engine)=>{updates.push({id,engine,seq});});await receiver.listen();
 const codexId=randomUUID(),claudeId=randomUUID(),codex=receiver.registerStatus(codexId,'codex'),claude=receiver.registerStatus(claudeId,'claude-code');
 try{
  expect(await send(receiver.port(),codex,{body:JSON.stringify({type:'agent-turn-complete',sessionId:claudeId})})).toEqual({status:204,body:''});
  expect(updates).toEqual([{id:codexId,engine:'codex',seq:1}]);
  // A credential only reaches its own engine's path.
  expect(await send(receiver.port(),codex,{path:'/v1/status/claude'})).toEqual({status:204,body:''});
  expect(await send(receiver.port(),claude,{path:'/v1/status/codex'})).toEqual({status:204,body:''});
  expect(updates).toHaveLength(1);
  expect(receiver.nextStatusSeq(codexId)).toBe(2);expect(receiver.nextStatusSeq(randomUUID())).toBeNull();
  receiver.revoke(codexId);expect(await send(receiver.port(),codex)).toEqual({status:204,body:''});expect(updates).toHaveLength(1);expect(receiver.nextStatusSeq(codexId)).toBeNull();
 }finally{await receiver.close();}
});
it('every Codex status rejection is an empty 204 with no update and no canary in logs',async()=>{
 const updates:unknown[]=[],logs:string[]=[],receiver=new UsageReceiver(async()=>{}, {error:text=>logs.push(text)},async(id,raw)=>{updates.push({id,raw});});await receiver.listen();const token=receiver.registerStatus(randomUUID(),'codex');
 try{for(const options of [{headers:{host:'localhost'}},{headers:{origin:'null'}},{headers:{'content-type':'text/plain'}},{headers:{'x-ai-term-session':''}},{headers:{'x-ai-term-session':'f'.repeat(64)}},{body:'{AITERMCANARY'},{body:JSON.stringify({type:'agent-turn-complete','last-assistant-message':'AITERMCANARY'.repeat(200000)})},{body:'x'.repeat(2*1024*1024+1),chunked:true},{path:'/unknown'},{path:'/v1/status/codex/x'},{method:'GET'},{method:'PUT'}] satisfies NonNullable<Parameters<typeof send>[2]>[])expect(await send(receiver.port(),token,options)).toEqual({status:204,body:''});expect(updates).toEqual([]);expect(logs.join('')).not.toContain('AITERMCANARY');
 }finally{await receiver.close();}
});
it('a Codex body carrying a full 256 KB reply fits under the Codex cap',async()=>{
 const updates:unknown[]=[],receiver=new UsageReceiver(async()=>{}, {error:()=>{}},async(_id,raw)=>{updates.push(raw);});await receiver.listen();const token=receiver.registerStatus(randomUUID(),'codex');
 // Worst-case JSON escaping: every byte of a 256 KiB reply becomes a six-byte \u00XX escape.
 const reply='\u0001'.repeat(256*1024);
 try{expect(await send(receiver.port(),token,{body:JSON.stringify({type:'agent-turn-complete','last-assistant-message':reply})})).toEqual({status:204,body:''});expect(updates).toHaveLength(1);}finally{await receiver.close();}
});

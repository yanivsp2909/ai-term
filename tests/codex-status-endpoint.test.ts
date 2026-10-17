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
  const signals:number[]=[];expect(receiver.enqueueStatus(codexId,seq=>signals.push(seq))).toBe(true);expect(receiver.enqueueStatus(randomUUID(),()=>{throw new Error('unknown');})).toBe(false);await expect.poll(()=>signals).toEqual([2]);
  receiver.revoke(codexId);expect(await send(receiver.port(),codex)).toEqual({status:204,body:''});expect(updates).toHaveLength(1);expect(receiver.enqueueStatus(codexId,()=>{throw new Error('revoked');})).toBe(false);
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
it('a terminal signal queues behind a status body that arrived first, and a failing signal never blocks later requests',async()=>{
 const order:string[]=[],logs:string[]=[],receiver=new UsageReceiver(async()=>{}, {error:text=>logs.push(text)},async(_id,_raw,seq)=>{order.push(`http ${seq}`);});await receiver.listen();const id=randomUUID(),token=receiver.registerStatus(id,'codex');
 try{
  let complete:()=>void=()=>{};
  const held=new Promise<number>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port:receiver.port(),path:'/v1/status/codex',method:'POST',headers:{'content-type':'application/json','x-ai-term-session':token,'transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));});req.on('error',reject);req.write('{');complete=()=>req.end('}');});
  // B31: the body is being read (sequence 1 taken) before the signal queues, not after a guessed 20 ms.
  await expect.poll(()=>receiver.statusSeq(id), { timeout: 10_000 }).toBe(1);receiver.enqueueStatus(id,seq=>{order.push(`signal ${seq}`);});await new Promise(r=>setTimeout(r,20));expect(order).toEqual([]);
  complete();expect(await held).toBe(204);await expect.poll(()=>order).toEqual(['http 1','signal 2']);
  receiver.enqueueStatus(id,()=>{throw new Error('AITERMCANARY');});expect(await send(receiver.port(),token)).toEqual({status:204,body:''});await expect.poll(()=>order).toEqual(['http 1','signal 2','http 4']);
  expect(logs).toEqual(['Status signal failed']);
 }finally{await receiver.close();}
});

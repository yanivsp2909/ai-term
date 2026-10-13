import {expect,it} from 'vitest';
import {request} from 'node:http';
import {randomUUID} from 'node:crypto';
import {UsageReceiver} from '../src/daemon/usage-receiver.js';
function send(port:number,token:string,options:{path?:string;method?:string;body?:string;headers?:Record<string,string>;chunked?:boolean}={}){return new Promise<{status:number;body:string}>((resolve,reject)=>{const body=options.body??'{}',req=request({hostname:'127.0.0.1',port,path:options.path??'/v1/status/claude',method:options.method??'POST',headers:{'content-type':'application/json','x-ai-term-session':token,...(options.chunked?{'transfer-encoding':'chunked'}:{'content-length':String(Buffer.byteLength(body))}),...options.headers}},res=>{let text='';res.on('data',d=>{text+=String(d);});res.on('end',()=>resolve({status:res.statusCode??0,body:text}));});req.on('error',reject);req.end(body);});}
it('status success resolves identity only from its separate credential and returns empty 204',async()=>{
 const updates:unknown[]=[],receiver=new UsageReceiver(async()=>{}, {error:()=>{}},async(id,raw)=>{updates.push({id,raw});});await receiver.listen();const id=randomUUID(),token=receiver.registerStatus(id);
 try{expect(await send(receiver.port(),token,{body:JSON.stringify({hook_event_name:'PermissionRequest',sessionId:randomUUID()})})).toEqual({status:204,body:''});expect(updates).toHaveLength(1);expect(updates[0]).toMatchObject({id});
 const usageToken=receiver.register({sessionId:randomUUID(),engine:'claude-code',provider:'anthropic',model:null});expect(await send(receiver.port(),usageToken)).toEqual({status:204,body:''});expect(updates).toHaveLength(1);
 receiver.revoke(id);expect(await send(receiver.port(),token)).toEqual({status:204,body:''});expect(updates).toHaveLength(1);
 }finally{await receiver.close();}
});
it('all status rejection paths are empty 204 and cannot affect sessions or expose canaries',async()=>{
 const updates:unknown[]=[],logs:string[]=[],receiver=new UsageReceiver(async()=>{}, {error:text=>logs.push(text)},async(id,raw)=>{updates.push({id,raw});});await receiver.listen();const token=receiver.registerStatus(randomUUID());
 try{for(const options of [{headers:{host:'localhost'}},{headers:{origin:'null'}},{headers:{'content-type':'text/plain'}},{headers:{'x-ai-term-session':''}},{headers:{'x-ai-term-session':'é'.repeat(64)}},{body:'{AITERMCANARY'},{body:'AITERMCANARY'.repeat(400000)},{body:'x'.repeat(4*1024*1024+1),chunked:true},{path:'/unknown'},{path:'/v1/status/unknown'},{method:'GET'},{method:'DELETE'}])expect(await send(receiver.port(),token,options)).toEqual({status:204,body:''});expect(updates).toEqual([]);expect(logs.join('')).not.toContain('AITERMCANARY');
 }finally{await receiver.close();}
});
it('large valid Claude bodies are accepted; consumer failure still returns empty 204 with fixed log',async()=>{
 let count=0;const logs:string[]=[],receiver=new UsageReceiver(async()=>{}, {error:text=>logs.push(text)},async()=>{count++;if(count===2)throw new Error('AITERMCANARY');});await receiver.listen();const token=receiver.registerStatus(randomUUID());
 try{for(let i=0;i<2;i++)expect(await send(receiver.port(),token,{body:JSON.stringify({hook_event_name:'PreToolUse',tool_input:'AITERMCANARY'.repeat(150000)})})).toEqual({status:204,body:''});expect(count).toBe(2);expect(logs).toEqual(['Status receiver request failed']);}finally{await receiver.close();}
});

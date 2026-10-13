import {expect,it} from 'vitest';
import {createServer,type IncomingHttpHeaders} from 'node:http';
import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {statusNotify} from '../src/cli/status-notify.js';
const TOKEN='b'.repeat(64);
async function receiver(answer=true){
 const calls:{url:string|undefined;method:string|undefined;headers:IncomingHttpHeaders;body:string}[]=[];
 const server=createServer((req,res)=>{let body='';req.on('data',d=>{body+=String(d);});req.on('end',()=>{calls.push({url:req.url,method:req.method,headers:req.headers,body});if(answer){res.writeHead(204);res.end();}});});
 await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');
 return {calls,port:address.port,close:()=>new Promise<void>(r=>{server.closeAllConnections();server.close(()=>r());})};
}
it('status-notify forwards only the event type and a capped last reply, never input messages or other fields',async()=>{
 const fake=await receiver();
 try{
  await statusNotify([JSON.stringify({type:'agent-turn-complete','thread-id':'AITERMCANARY-thread',cwd:'/AITERMCANARY',client:'codex-tui','input-messages':['AITERMCANARY secret prompt'],'last-assistant-message':'done ✓'})],{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(fake.port)});
  expect(fake.calls).toHaveLength(1);const call=fake.calls[0];if(!call)throw new Error('call');
  expect(call).toMatchObject({url:'/v1/status/codex',method:'POST'});expect(call.headers['x-ai-term-session']).toBe(TOKEN);expect(call.headers['content-type']).toBe('application/json');expect(call.headers.host).toBe(`127.0.0.1:${fake.port}`);
  expect(JSON.parse(call.body)).toEqual({type:'agent-turn-complete','last-assistant-message':'done ✓'});expect(call.body).not.toContain('AITERMCANARY');
  fake.calls.length=0;
  // A multibyte character straddling the 256 KiB cap is dropped whole.
  await statusNotify([JSON.stringify({type:'agent-turn-complete','last-assistant-message':'a'.repeat(256*1024-1)+'é'+'tail'})],{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(fake.port)});
  const capped=JSON.parse(fake.calls[0]?.body??'{}') as Record<string,unknown>;expect(capped['last-assistant-message']).toBe('a'.repeat(256*1024-1));
  fake.calls.length=0;
  await statusNotify([JSON.stringify({type:'agent-turn-complete','last-assistant-message':42})],{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(fake.port)});
  expect(JSON.parse(fake.calls[0]?.body??'{}')).toEqual({type:'agent-turn-complete'});
 }finally{await fake.close();}
});
it('status-notify sends nothing for unknown events, bad JSON, missing or bad credentials and wrong argument counts',async()=>{
 const fake=await receiver(),env={AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(fake.port)};
 try{
  for(const args of [[JSON.stringify({type:'approval-requested'})],['{AITERMCANARY'],[JSON.stringify(['agent-turn-complete'])],[],['{}','{}'],['x'.repeat(4*1024*1024+1)]])await statusNotify(args,env);
  for(const bad of [{},{AITERM_STATUS_PORT:String(fake.port)},{AITERM_STATUS_TOKEN:'short',AITERM_STATUS_PORT:String(fake.port)},{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:'70000'},{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:'1.5'}])await statusNotify([JSON.stringify({type:'agent-turn-complete'})],bad);
  expect(fake.calls).toEqual([]);
 }finally{await fake.close();}
});
it('status-notify gives up within its bound when the daemon never answers or is gone',async()=>{
 const silent=await receiver(false);
 try{const start=Date.now();await statusNotify([JSON.stringify({type:'agent-turn-complete'})],{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(silent.port)});expect(Date.now()-start).toBeLessThan(1900);expect(silent.calls).toHaveLength(1);}finally{await silent.close();}
 const gone=await receiver();const port=gone.port;await gone.close();
 await expect(statusNotify([JSON.stringify({type:'agent-turn-complete'})],{AITERM_STATUS_TOKEN:TOKEN,AITERM_STATUS_PORT:String(port)})).resolves.toBeUndefined();
});
it('ai status-notify exits 0 with no output on any input, so Codex never breaks on it',async()=>{
 const loader=createRequire(import.meta.url).resolve('tsx'),entry=resolve('src/cli/index.ts');
 for(const args of [['status-notify','{AITERMCANARY'],['status-notify'],['status-notify',JSON.stringify({type:'agent-turn-complete','input-messages':['AITERMCANARY']})]]){
  const result=await new Promise<{code:number|null;stdout:string;stderr:string}>(done=>{execFile(process.execPath,['--import',loader,entry,...args],{env:{PATH:process.env.PATH??'',AI_TERM_HOME:'/nonexistent-ai-term-home'},timeout:10000},(error,stdout,stderr)=>{done({code:error?(typeof error.code==='number'?error.code:-1):0,stdout,stderr});});});
  expect(result).toEqual({code:0,stdout:'',stderr:''});
 }
},30000);

import {expect,it} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {UsageService} from '../src/daemon/usage-service.js';
it('ingests authorized usage with price table, discards private attributes, revokes and reports safe diagnostics',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-runtime-'),logs:string[]=[],service=new UsageService(root,{error:text=>{logs.push(text);}});const sessionId=randomUUID();
 try{await service.start();const telemetry=service.register({sessionId,engine:'codex',provider:'openai',model:'unknown-model'});expect(telemetry.credential).toMatch(/^[0-9a-f]{64}$/);
 const record={resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'100',attributes:[{key:'event.name',value:{stringValue:'codex.sse_event'}},{key:'event.kind',value:{stringValue:'response.completed'}},{key:'input_token_count',value:{stringValue:'1000'}},{key:'output_token_count',value:{intValue:'100'}},{key:'cached_token_count',value:{intValue:'200'}},{key:'user.email',value:{stringValue:'fake@example.com AITERMCANARY'}}],body:{stringValue:'AITERMCANARY'}},{attributes:[{key:'event.name',value:{stringValue:'codex.tool_output'}},{key:'code',value:{stringValue:'AITERMCANARY'}}]}]}]}]};
 const response=await fetch(`http://127.0.0.1:${telemetry.port}/v1/logs`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':telemetry.credential},body:JSON.stringify(record)});expect(response.status).toBe(200);expect(service.summary().today).toMatchObject({tokens:1100,unknownPrice:true});const diagnostics=service.diagnostics();expect(diagnostics.sessions[0]?.values).toContainEqual({name:'input_token_count',value:1000});
 service.revoke(sessionId);expect((await fetch(`http://127.0.0.1:${telemetry.port}/v1/logs`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':telemetry.credential},body:'{}'})).status).toBe(401);
 const text=await readFile(join(root,'usage',new Date().toISOString().slice(0,7)+'.jsonl'),'utf8');expect(text+JSON.stringify(diagnostics)+JSON.stringify(service.summary())+logs.join('')).not.toMatch(/AITERMCANARY|fake@example/);expect(text+JSON.stringify(diagnostics)).not.toContain(telemetry.credential);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});
it('concurrent repeated cumulative exports are counted once and candidates remain numeric-only',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-concurrent-'),service=new UsageService(root,{error:()=>{}});
 try{await service.start();const t=service.register({sessionId:randomUUID(),engine:'claude-code',provider:'anthropic',model:'sonnet'});const body={resourceMetrics:[{scopeMetrics:[{metrics:[{name:'claude_code.token.usage',sum:{aggregationTemporality:2,dataPoints:[{startTimeUnixNano:'1',timeUnixNano:'2',asInt:'100',attributes:[{key:'type',value:{stringValue:'input'}},{key:'model',value:{stringValue:'sonnet'}},{key:'user.email',value:{stringValue:'AITERMCANARY fake@example.com'}}]}]}}]}]}]};
 const send=()=>fetch('http://127.0.0.1:'+t.port+'/v1/metrics',{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':t.credential},body:JSON.stringify(body)});
 const results=await Promise.all([send(),send()]);expect(results.map(r=>r.status)).toEqual([200,200]);expect(service.summary().today.tokens).toBe(100);expect(JSON.stringify(service.diagnostics())).not.toMatch(/AITERMCANARY|fake@example/);
 }finally{await service.close();await rm(root,{recursive:true,force:true});}
});

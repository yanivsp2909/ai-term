import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {Logger} from '../src/daemon/log.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
import {debugUsage} from '../src/cli/debug-usage.js';
import {randomUUID} from 'node:crypto';
import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
it('summary subscription and diagnostics round-trip with updates sent only to subscribers',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-server-'),p=getPaths(root);await preparePaths(p);const log=new Logger(p.log),usage=new UsageService(root,log),m=new SessionManager(p,log),server=new DaemonServer(p,m,log,undefined,undefined,usage);let a:Connection|undefined,b:Connection|undefined;
 try{await usage.start();await m.load();await server.listen();a=await Connection.connect(p,{entry:'/unused',autoStart:false});b=await Connection.connect(p,{entry:'/unused',autoStart:false});const mine:unknown[]=[],other:unknown[]=[];a.on('event',e=>mine.push(e));b.on('event',e=>other.push(e));expect((await a.request({kind:'usage.summary'})).usage?.today.tokens).toBe(0);await a.request({kind:'usage.subscribe',on:true});usage.emit('updated',usage.summary());await expect.poll(()=>mine.some(e=>JSON.stringify(e).includes('usage.updated'))).toBe(true);expect(other.some(e=>JSON.stringify(e).includes('usage.updated'))).toBe(false);expect((await a.request({kind:'usage.diagnostics'})).usageDiagnostics?.port).toBeGreaterThan(0);await a.request({kind:'usage.subscribe',on:false});
 }finally{a?.close();b?.close();await server.close();await m.shutdown();await usage.close();await rm(root,{recursive:true,force:true});}
});
it('dropped canaries and credentials never enter any usage response event diagnostic or file',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-safe-'),p=getPaths(root);await preparePaths(p);const log=new Logger(p.log),usage=new UsageService(root,log),m=new SessionManager(p,log),server=new DaemonServer(p,m,log,undefined,undefined,usage);let client:Connection|undefined;
 try{await usage.start();await m.load();await server.listen();client=await Connection.connect(p,{entry:'/unused',autoStart:false});const events:unknown[]=[],replies:unknown[]=[],output:string[]=[],credentials:string[]=[];client.on('event',event=>events.push(event));await client.request({kind:'usage.subscribe',on:true});
 for(const engine of ['claude-code','codex']as const){const t=usage.register({sessionId:randomUUID(),engine,provider:engine==='codex'?'openai':'anthropic',model:'sonnet'});credentials.push(t.credential);const privateAttr={key:'user.email',value:{stringValue:'AITERMCANARY fake@example.com'}};const body=engine==='codex'?{resourceLogs:[{scopeLogs:[{logRecords:[{timeUnixNano:'1',attributes:[{key:'event.name',value:{stringValue:'codex.sse_event'}},{key:'event.kind',value:{stringValue:'response.completed'}},{key:'input_token_count',value:{intValue:'10'}},{key:'output_token_count',value:{intValue:'1'}},privateAttr],body:{stringValue:'AITERMCANARY'}},{attributes:[{key:'event.name',value:{stringValue:'codex.tool_output'}}],body:{stringValue:'AITERMCANARY'}}]}]}]}:{resourceMetrics:[{scopeMetrics:[{metrics:[{name:'claude_code.token.usage',sum:{aggregationTemporality:1,dataPoints:[{timeUnixNano:'2',asInt:'10',attributes:[{key:'type',value:{stringValue:'input'}},privateAttr]}]}}]}]}]};
 expect((await fetch(`http://127.0.0.1:${t.port}/v1/${engine==='codex'?'logs':'metrics'}`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':t.credential},body:JSON.stringify(body)})).status).toBe(200);}
 for(const request of [{kind:'usage.summary'},{kind:'usage.diagnostics'},{kind:'usage.subscribe',on:false}]as const)replies.push(await client.request(request));await debugUsage(client,text=>{output.push(text);});await expect.poll(()=>events.length).toBeGreaterThan(0);
 const contents=[await readFile(p.state,'utf8'),await readFile(p.log,'utf8').catch(()=>''),...await Promise.all((await readdir(join(root,'usage'))).map(name=>readFile(join(root,'usage',name),'utf8')))];const all=JSON.stringify([...replies,...events])+output.join('')+contents.join('');expect(all).not.toMatch(/AITERMCANARY|fake@example/);for(const credential of credentials)expect(all).not.toContain(credential);
 }finally{client?.close();await server.close();await m.shutdown();await usage.close();await rm(root,{recursive:true,force:true});}
});

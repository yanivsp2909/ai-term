import {expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createRequire} from 'node:module';
import pty from 'node-pty';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {Logger} from '../src/daemon/log.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
import * as engines from '../src/daemon/engines.js';
// Atomic state writes rename a temp file that readdir may still list; its contents reappear under the final name.
// Queued status work (signals wait behind in-flight requests) finishes before a negative assertion.
const settle=()=>new Promise(r=>setTimeout(r,30));
// queued: the session's status sequence; the body is being read once it moves past its value before the request (B31).
async function holdNotify(port:number,token:string,body:unknown,queued:()=>number){
 const before=queued();
 const {request}=await import('node:http');let finish=()=>{};const text=JSON.stringify(body);
 const status=new Promise<number>((resolve,reject)=>{const req=request({hostname:'127.0.0.1',port,path:'/v1/status/codex',method:'POST',headers:{'content-type':'application/json','x-ai-term-session':token,'transfer-encoding':'chunked'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode??0));});req.on('error',reject);req.write(text.slice(0,5));finish=()=>req.end(text.slice(5));});
 await expect.poll(queued).toBeGreaterThan(before);return {status,finish:()=>finish()};
}
async function files(folder:string):Promise<string[]>{const text:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const path=join(folder,e.name);if(e.isDirectory())text.push(...await files(path));else if(e.isFile())try{text.push(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return text;}
it.each(['subscription','api-key'] as const)('Codex %s sessions get notify argv, env-only credential, mirror signals, Enter, done and explicit last reply',async(authMethod)=>{
 const root=await mkdtemp('/tmp/ai-codex-runtime-'),paths=getPaths(root);await preparePaths(paths);
 const entry=resolve('src/cli/index.ts'),log=new Logger(paths.log),usage=new UsageService(root,log),m=new SessionManager(paths,log,undefined,undefined,undefined,undefined,usage,entry),server=new DaemonServer(paths,m,log,undefined,undefined,usage);
 let client:Connection|undefined,argv:string[]=[],env:NodeJS.ProcessEnv={},output:((text:string)=>void)|undefined;
 const exits:((e:{exitCode:number})=>void)[]=[],written:string[]=[];
 vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/stub/codex',version:'0.160.1',loggedIn:true,authMethod});
 vi.spyOn(pty,'spawn').mockImplementation((_file,args,options)=>{argv=[...args];env={...options?.env};return {pid:900002,onData:(cb:(text:string)=>void)=>{output=cb;return {dispose(){}};},onExit:(cb:(e:{exitCode:number})=>void)=>{exits.push(cb);return {dispose(){}};},write(data:string){written.push(String(data));},resize(){},pause(){},resume(){}} as unknown as pty.IPty;});
 vi.spyOn(process,'kill').mockImplementation(()=>{for(const exit of exits)exit({exitCode:0});return true;});
 const emit=async(id:string,text:string)=>{output?.(text);await m.snapshot(id);};
 try{
  await usage.start();await m.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});
  const session=await m.create({engine:'codex',model:null,auth:{kind:'account'},cwd:root,permission:'ask'}),id=session.id;
  const token=env.AITERM_STATUS_TOKEN;if(!token)throw new Error('Missing status token');expect(token).toMatch(/^[a-f0-9]{64}$/);expect(env.AITERM_STATUS_PORT).toMatch(/^\d+$/);
  const loader=createRequire(import.meta.url).resolve('tsx');
  expect(argv).toContain(`notify=["/usr/bin/env","TSX_TSCONFIG_PATH=${resolve(entry,'..','..','..','tsconfig.json')}","${process.execPath}","--import","${loader}","${entry}","status-notify"]`);
  expect(argv).toContain('tui.notification_method="osc9"');expect(argv.filter(a=>a==='--no-daemon')).toHaveLength(1);expect(argv.join('\n')).not.toContain(token);
  const send=(body:unknown)=>fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/codex`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':token},body:JSON.stringify(body)});
  // Signals inside the very first output and the starting→running promotion settle on one running record.
  await emit(id,'\x1b]0;Working | Context 80% left\x07ready');await expect.poll(()=>m.get(id)).toMatchObject({status:'running',ctxPercent:20});
  expect((await send({type:'agent-turn-complete','last-assistant-message':'AITERMCANARY reply','input-messages':['AITERMCANARY prompt']})).status).toBe(204);
  await expect.poll(()=>m.get(id).status).toBe('done');
  // A spinner repeating the same Working title after the turn ended is not a new turn.
  await emit(id,'\x1b]0;Working | Context 80% left\x07\x1b]0;Ready | Context 78% left\x07');await expect.poll(()=>m.get(id)).toMatchObject({status:'done',ctxPercent:22});
  // Keys typed while nobody is attached never reach the agent and never change status.
  m.input(id,Buffer.from('\r'));await settle();expect(m.get(id).status).toBe('done');
  await m.attach(id,80,24,()=>undefined);
  // Plain keys, a pasted newline and a stray bell after the turn ended are not a new turn.
  m.input(id,Buffer.from('x'));m.input(id,Buffer.from('\x1b[200~line one\rline two\x1b[201~'));
  // A long paste arrives in several chunks; only the first carries the start marker.
  m.input(id,Buffer.from('\x1b[200~first'));m.input(id,Buffer.from('\rmiddle\r'));m.input(id,Buffer.from('last\r\x1b[201~'));await emit(id,'stray\x07');await settle();expect(m.get(id).status).toBe('done');
  m.input(id,Buffer.from('\r'));await expect.poll(()=>m.get(id).status).toBe('running');
  await emit(id,'\x1b]9;Approval requested: curl https://example.com AITERMCANARY\x07');await expect.poll(()=>m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission'});
  m.input(id,Buffer.from('\r'));await expect.poll(()=>m.get(id).status).toBe('running');
  await emit(id,'\x1b]0;[ ! ] Action Required AITERMCANARY | Context 70% left\x07');await expect.poll(()=>m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission',ctxPercent:30});
  m.input(id,Buffer.from('\x1b[13u'));await expect.poll(()=>m.get(id).status).toBe('running');
  await emit(id,'bell\x07');await expect.poll(()=>m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission'});
  await emit(id,'\x1b]0;Working | Context 69% left\x07');await expect.poll(()=>m.get(id)).toMatchObject({status:'running',ctxPercent:31});
  // A notify whose body is still arriving is applied before a signal that came after it, so done is not lost.
  const held=await holdNotify(Number(env.AITERM_STATUS_PORT),token,{type:'agent-turn-complete','last-assistant-message':'AITERMCANARY final reply'},()=>usage.statusSeq(id));
  await emit(id,'\x1b]0;Ready | Context 60% left\x07');held.finish();expect(await held.status).toBe(204);await expect.poll(()=>m.get(id)).toMatchObject({status:'done',ctxPercent:40});
  expect(m.activeCount()).toBe(1);expect(m.sessionRoots()).toHaveLength(1);
  expect(JSON.stringify((await client.request({kind:'sessions.list'})).sessions)).not.toContain('AITERMCANARY');
  expect((await client.request({kind:'sessions.text',sessionId:id,lastReply:true})).copy).toMatchObject({text:'AITERMCANARY final reply',source:'last-reply'});
  const disk=(await files(root)).join('');expect(disk).not.toContain('AITERMCANARY');expect(disk).not.toContain(token);
  await m.stop(id);expect(m.get(id).status).toBe('exited');
  await send({type:'agent-turn-complete'});await emit(id,'\x1b]9;Approval requested: x\x07\x07');m.input(id,Buffer.from('\r'));await settle();expect(m.get(id).status).toBe('exited');
  expect(written.join('')).not.toContain('AITERMCANARY');
 }finally{client?.close();await server.close();await m.shutdown();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

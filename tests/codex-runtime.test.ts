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
async function files(folder:string):Promise<string[]>{const text:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const path=join(folder,e.name);if(e.isDirectory())text.push(...await files(path));else if(e.isFile())text.push(await readFile(path,'utf8'));}return text;}
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
  expect(argv).toContain(`notify=["${process.execPath}","--import","${loader}","${entry}","status-notify"]`);
  expect(argv).toContain('tui.notification_method="osc9"');expect(argv.filter(a=>a==='--no-daemon')).toHaveLength(1);expect(argv.join('\n')).not.toContain(token);
  const send=(body:unknown)=>fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/codex`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':token},body:JSON.stringify(body)});
  await emit(id,'\x1b]0;Starting\x07ready');expect(m.get(id)).toMatchObject({status:'running',ctxPercent:null});
  await emit(id,'\x1b]0;Working | Context 80% left\x07');expect(m.get(id)).toMatchObject({status:'running',ctxPercent:20});
  expect((await send({type:'agent-turn-complete','last-assistant-message':'AITERMCANARY reply','input-messages':['AITERMCANARY prompt']})).status).toBe(204);
  await expect.poll(()=>m.get(id).status).toBe('done');
  // A spinner repeating the same Working title after the turn ended is not a new turn.
  await emit(id,'\x1b]0;Working | Context 80% left\x07\x1b]0;Ready | Context 78% left\x07');expect(m.get(id)).toMatchObject({status:'done',ctxPercent:22});
  // Keys typed while nobody is attached never reach the agent and never change status.
  m.input(id,Buffer.from('\r'));expect(m.get(id).status).toBe('done');
  await m.attach(id,80,24,()=>undefined);
  m.input(id,Buffer.from('x'));expect(m.get(id).status).toBe('done');
  m.input(id,Buffer.from('\r'));expect(m.get(id).status).toBe('running');
  await emit(id,'\x1b]9;Approval requested: curl https://example.com AITERMCANARY\x07');expect(m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission'});
  m.input(id,Buffer.from('\r'));expect(m.get(id).status).toBe('running');
  await emit(id,'\x1b]0;[ ! ] Action Required | Context 70% left AITERMCANARY\x07');expect(m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission',ctxPercent:30});
  m.input(id,Buffer.from('\x1b[13u'));expect(m.get(id).status).toBe('running');
  await emit(id,'bell\x07');expect(m.get(id)).toMatchObject({status:'waiting',statusDetail:'permission'});
  await emit(id,'\x1b]0;Working | Context 69% left\x07');expect(m.get(id)).toMatchObject({status:'running',ctxPercent:31});
  await send({type:'agent-turn-complete','last-assistant-message':'AITERMCANARY final reply'});await expect.poll(()=>m.get(id).status).toBe('done');
  expect(m.activeCount()).toBe(1);expect(m.sessionRoots()).toHaveLength(1);
  expect(JSON.stringify((await client.request({kind:'sessions.list'})).sessions)).not.toContain('AITERMCANARY');
  expect((await client.request({kind:'sessions.text',sessionId:id,lastReply:true})).copy).toMatchObject({text:'AITERMCANARY final reply',source:'last-reply'});
  const disk=(await files(root)).join('');expect(disk).not.toContain('AITERMCANARY');expect(disk).not.toContain(token);
  await m.stop(id);expect(m.get(id).status).toBe('exited');
  await send({type:'agent-turn-complete'});await emit(id,'\x1b]9;Approval requested: x\x07\x07');m.input(id,Buffer.from('\r'));expect(m.get(id).status).toBe('exited');
  expect(written.join('')).not.toContain('AITERMCANARY');
 }finally{client?.close();await server.close();await m.shutdown();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

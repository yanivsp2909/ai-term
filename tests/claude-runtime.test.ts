import {expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile,readdir,stat} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import pty from 'node-pty';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {Logger} from '../src/daemon/log.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
import * as engines from '../src/daemon/engines.js';
it.each([false,true])('subscription Claude earlyContext=%s sessions get private hooks, live status/context/activity, explicit replies and revocation',async(earlyContext)=>{
 const root=await mkdtemp('/tmp/ai-claude-runtime-'),paths=getPaths(root);await preparePaths(paths);
 const log=new Logger(paths.log),usage=new UsageService(root,log),m=new SessionManager(paths,log,undefined,undefined,undefined,undefined,usage,resolve('src/cli/index.ts')),server=new DaemonServer(paths,m,log,undefined,undefined,usage);
 let client:Connection|undefined,argv:string[]=[],env:NodeJS.ProcessEnv={},output:((text:string)=>void)|undefined;
 const exits:((e:{exitCode:number})=>void)[]=[];
 vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'});
 vi.spyOn(pty,'spawn').mockImplementation((_file,args,options)=>{argv=[...args];env={...options?.env};return {pid:900001,onData:(cb:(text:string)=>void)=>{output=cb;return {dispose(){}};},onExit:(cb:(e:{exitCode:number})=>void)=>{exits.push(cb);return {dispose(){}};},write(){},resize(){},pause(){},resume(){}} as unknown as pty.IPty;});
 vi.spyOn(process,'kill').mockImplementation(()=>{for(const exit of exits)exit({exitCode:0});return true;});
 try{
  await usage.start();await m.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});
  const session=await m.create({engine:'claude-code',model:'sonnet',auth:{kind:'account'},cwd:root,permission:'ask'});
  if(!earlyContext){output?.('ready');await m.snapshot(session.id);}
  const token=env.AITERM_STATUS_TOKEN;if(!token)throw new Error('Missing status token');expect(token).toMatch(/^[a-f0-9]{64}$/);expect(argv.join('')).not.toContain(token);// v0.6.1: a subscription reports usage for its own task total only (tokens), never to Usage.
  expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe('1');
  const file=argv.find(a=>a.startsWith('--settings='))?.slice('--settings='.length);if(!file)throw new Error('Missing settings');expect(await readFile(file,'utf8')).not.toContain(token);expect((await stat(file)).mode&0o777).toBe(0o600);expect(await readFile(file,'utf8')).toContain('status-line');
  const send=(body:unknown)=>fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/claude`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':token},body:JSON.stringify(body)});
  if(earlyContext){await send({hook_event_name:'AITermContext',used_percentage:1});output?.('ready');await m.snapshot(session.id);}
  await send({hook_event_name:'AITermContext',used_percentage:5});expect(m.get(session.id).status).toBe('running');
  for(const [body,status,detail]of [[{hook_event_name:'PreToolUse',tool_name:'Bash',tool_input:'AITERMCANARY'},'running','running'],[{hook_event_name:'PermissionRequest',sessionId:'forged'},'waiting','permission'],[{hook_event_name:'PostToolUse',tool_name:'Bash'},'running','running'],[{hook_event_name:'Stop',last_assistant_message:'AITERMCANARY last reply'},'done','done']]as const){expect((await send(body)).status).toBe(204);await expect.poll(()=>m.get(session.id)).toMatchObject({status,statusDetail:detail});}
  await send({hook_event_name:'PermissionRequest'});expect(m.activeCount()).toBe(1);await send({hook_event_name:'Stop'});
  expect(m.activeCount()).toBe(1);expect(m.sessionRoots()).toHaveLength(1);expect(m.get(session.id).lastActivity?.tool).toBe('Bash');
  await send({hook_event_name:'AITermContext',used_percentage:30});await expect.poll(()=>m.get(session.id).ctxPercent).toBe(30);
  expect(JSON.stringify((await client.request({kind:'sessions.list'})).sessions)).not.toContain('AITERMCANARY');
  expect((await client.request({kind:'sessions.text',sessionId:session.id})).copy?.text).not.toContain('AITERMCANARY');
  expect((await client.request({kind:'sessions.text',sessionId:session.id,lastReply:true})).copy).toMatchObject({text:'AITERMCANARY last reply',source:'last-reply'});
  // Atomic state writes rename a temp file that readdir may still list; its contents reappear under the final name.
  async function files(folder:string):Promise<string[]>{const text:string[]=[];for(const e of await readdir(folder,{withFileTypes:true})){const path=join(folder,e.name);if(e.isDirectory())text.push(...await files(path));else if(e.isFile())try{text.push(await readFile(path,'utf8'));}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return text;}
  expect((await files(root)).join('')).not.toMatch(/AITERMCANARY/);expect((await files(root)).join('')).not.toContain(token);
  await m.stop(session.id);expect(m.get(session.id).status).toBe('exited');await send({hook_event_name:'PermissionRequest'});expect(m.get(session.id).status).toBe('exited');
  expect((await client.request({kind:'sessions.text',sessionId:session.id,lastReply:true})).copy?.text).toBe('AITERMCANARY last reply');
  await m.remove(session.id);await expect(stat(file)).rejects.toMatchObject({code:'ENOENT'});
 }finally{client?.close();await server.close();await m.shutdown();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

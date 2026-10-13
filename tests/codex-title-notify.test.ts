import {expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import pty from 'node-pty';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {Logger} from '../src/daemon/log.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
import {notifyBody,statusNotify} from '../src/cli/status-notify.js';
import {parseCodexStatus} from '../src/daemon/codex-status.js';
import * as engines from '../src/daemon/engines.js';
// The TUI names a new thread through a temporary structured thread whose notify looks like this (seen live in v0.2.4a).
const titleTurn=(title:string)=>({type:'agent-turn-complete','thread-id':'019a0000-0000-7000-8000-00000000title','turn-id':'title-turn',cwd:'/AITERMCANARY',client:'codex-tui','input-messages':['Generate a concise, single-line task title of at most 36 characters'],'last-assistant-message':JSON.stringify({title})});
const realTurn=(reply:string)=>({type:'agent-turn-complete','thread-id':'019a0000-0000-7000-8000-000000000main','turn-id':'main-turn',cwd:'/AITERMCANARY',client:'codex-tui','input-messages':['hii'],'last-assistant-message':reply});
it('notify drops a title-generation turn whole and forwards real replies, even ones that look like JSON',()=>{
 expect(notifyBody(JSON.stringify(titleTurn('Respond to greeting')))).toBeNull();
 expect(notifyBody(JSON.stringify({...titleTurn('x'),'last-assistant-message':' {"title":"Fix login"}\n'}))).toBeNull();
 for(const reply of ['Hi Yaniv 👋','{"title":"Fix login","body":"more"}','{"title":3}','["title"]','{"title":"unterminated','title'])expect(JSON.parse(notifyBody(JSON.stringify(realTurn(reply)))??'{}')).toEqual({type:'agent-turn-complete','last-assistant-message':reply});
 expect(parseCodexStatus({type:'agent-turn-complete','last-assistant-message':'{"title":"Respond to greeting"}'},1,'2026-10-13T12:00:00.000Z')).toBeNull();
 expect(parseCodexStatus({type:'agent-turn-complete','last-assistant-message':'Hi'},1,'2026-10-13T12:00:00.000Z')).toMatchObject({reply:'Hi',event:{kind:'done'}});
});
it('c copies the turn\'s real reply whether the title turn finishes before or after it, and a title turn never ends a running turn',async()=>{
 const root=await mkdtemp('/tmp/ai-codex-title-'),paths=getPaths(root);await preparePaths(paths);
 const entry=resolve('src/cli/index.ts'),log=new Logger(paths.log),usage=new UsageService(root,log),m=new SessionManager(paths,log,undefined,undefined,undefined,undefined,usage,entry),server=new DaemonServer(paths,m,log,undefined,undefined,usage);
 let client:Connection|undefined,env:NodeJS.ProcessEnv={},output:((text:string)=>void)|undefined;const exits:((e:{exitCode:number})=>void)[]=[];
 vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/stub/codex',version:'0.160.1',loggedIn:true,authMethod:'api-key'});
 vi.spyOn(pty,'spawn').mockImplementation((_file,_args,options)=>{env={...options?.env};return {pid:900003,onData:(cb:(text:string)=>void)=>{output=cb;return {dispose(){}};},onExit:(cb:(e:{exitCode:number})=>void)=>{exits.push(cb);return {dispose(){}};},write(){},resize(){},pause(){},resume(){}} as unknown as pty.IPty;});
 vi.spyOn(process,'kill').mockImplementation(()=>{for(const exit of exits)exit({exitCode:0});return true;});
 try{
  await usage.start();await m.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});
  const id=(await m.create({engine:'codex',model:null,auth:{kind:'account'},cwd:root,permission:'ask'})).id,emit=async(text:string)=>{output?.(text);await m.snapshot(id);};
  const notify=(body:unknown)=>statusNotify([JSON.stringify(body)],{AITERM_STATUS_TOKEN:env.AITERM_STATUS_TOKEN,AITERM_STATUS_PORT:env.AITERM_STATUS_PORT});
  const copied=async()=>(await client?.request({kind:'sessions.text',sessionId:id,lastReply:true}))?.copy;
  // Title first: the user's turn is still running, so it must neither end the turn nor become the reply.
  await emit('\x1b]0;Working | Context 90% left\x07');await expect.poll(()=>m.get(id).status).toBe('running');
  await notify(titleTurn('Respond to greeting'));await new Promise(r=>setTimeout(r,50));expect(m.get(id).status).toBe('running');
  await notify(realTurn('Hi Yaniv 👋'));await expect.poll(()=>m.get(id).status).toBe('done');
  expect(await copied()).toMatchObject({text:'Hi Yaniv 👋',source:'last-reply'});
  // Title after: the real reply stays.
  await emit('\x1b]0;Ready | Context 89% left\x07\x1b]0;Working | Context 88% left\x07');await expect.poll(()=>m.get(id).status).toBe('running');
  await notify(realTurn('Second answer'));await expect.poll(()=>m.get(id).status).toBe('done');
  await notify(titleTurn('Answer again'));await new Promise(r=>setTimeout(r,50));
  expect(await copied()).toMatchObject({text:'Second answer',source:'last-reply'});expect(m.get(id).status).toBe('done');
 }finally{client?.close();await m.shutdown();await server.close();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

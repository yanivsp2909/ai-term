import {expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {resolve} from 'node:path';
import pty from 'node-pty';
import {Notifier,type Launcher} from '../src/daemon/notifier.js';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {Logger} from '../src/daemon/log.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
import {validateSuccess} from '../src/shared/validate.js';
import * as engines from '../src/daemon/engines.js';
import type {SessionInfo} from '../src/shared/protocol.js';
const APP='/Users/test/ai-term/build/notifier/AI Term.app',now='2026-10-13T12:00:00.000Z';
function agent(over:Partial<SessionInfo>={}):SessionInfo{return {id:randomUUID(),title:'fix-login',engine:'codex',model:'AITERMCANARY-model',auth:{kind:'key',keyId:randomUUID(),provider:'openai',keyLabel:'AITERM' + 'CANARY label',last4:'AB12'},authMethod:'api-key',cwd:'/Users/test/AITERMCANARY',permission:'ask',status:'waiting',statusDetail:'turn failed: AITERMCANARY sk-secret',statusSince:now,createdAt:now,lastOutputAt:now,exitCode:null,ctxPercent:40,lastActivity:{tool:'Bash',at:now},...over};}
const running={status:'running' as const,statusDetail:'running'},waiting={status:'waiting' as const,statusDetail:'permission'},done={status:'done' as const,statusDetail:'done'};
function fixture(options:{enabled?:()=>Promise<boolean>;exists?:boolean;app?:string|null}={}){
 const calls:{file:string;args:string[];done:(error:Error|null)=>void}[]=[],logs:string[]=[];
 const launch:Launcher=(file,args,finished)=>{calls.push({file,args:[...args],done:finished});};
 const notifier=new Notifier(options.app===undefined?APP:options.app,{error:text=>logs.push(text)},options.enabled??(async()=>true),launch,()=>options.exists??true);
 return {notifier,calls,logs};
}
it('launches the helper through open with an argv array: fixed title, the name and the change only',async()=>{
 const f=fixture(),session=agent();
 f.notifier.transition(session,running,waiting,false);
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 expect(f.calls[0]).toMatchObject({file:'/usr/bin/open',args:['-n','-g','-a',APP,'--args','--session',session.id,'--title','AI Term','--body','fix-login · waiting: permission']});
 // A second agent: one agent gets at most one notification per 5 s.
 f.notifier.transition(agent(),waiting,done,false);
 await vi.waitFor(()=>expect(f.calls).toHaveLength(2));expect(f.calls[1]?.args.at(-1)).toBe('fix-login · done');
});
it('never puts prompts, replies, failure text, paths, models, key labels or secrets in argv',async()=>{
 const f=fixture(),session=agent({title:'fix-login'});
 f.notifier.transition(session,running,{status:'waiting',statusDetail:session.statusDetail},false);
 await vi.waitFor(()=>expect(f.calls).toHaveLength(1));
 const argv=f.calls[0]?.args.join('\n')??'';
 expect(argv).not.toContain('AITERMCANARY');expect(argv).not.toContain('sk-');expect(argv).not.toContain('/Users/test/AITERMCANARY');expect(argv.at(-1)).toBeDefined();
 expect(f.calls[0]?.args.at(-1)).toBe('fix-login · waiting: turn failed');
});
it('never waits on the helper: a launch that never finishes does not hold back the next notification',async()=>{
 const f=fixture(),first=agent(),second=agent();
 expect(f.notifier.transition(first,running,waiting,false)).toBeUndefined();
 f.notifier.transition(second,running,waiting,false);
 await vi.waitFor(()=>expect(f.calls.map(c=>c.args[6])).toEqual([first.id,second.id]));
});
it('a failed launch is logged once per daemon run with fixed text and shows in the notifier state',async()=>{
 const f=fixture();expect(f.notifier.state()).toBe('ready');
 for(let i=0;i<3;i++){f.notifier.transition(agent(),running,waiting,false);await vi.waitFor(()=>expect(f.calls).toHaveLength(i+1));f.calls[i]?.done(new Error('AITERMCANARY open failed /Users/test'));}
 expect(f.logs).toEqual(['Notifier helper failed to launch']);expect(f.notifier.state()).toBe('launch failed');
 // A launcher that throws is a failed launch too, never an exception into the status path.
 const thrown=new Notifier(APP,{error:text=>f.logs.push(text)},async()=>true,()=>{throw new Error('AITERMCANARY');},()=>true);
 expect(()=>thrown.transition(agent(),running,waiting,false)).not.toThrow();
 await vi.waitFor(()=>expect(thrown.state()).toBe('launch failed'));expect(f.logs.join('')).not.toContain('AITERMCANARY');
});
it('a missing helper is never launched; it is logged once and shows as not built',async()=>{
 for(const options of [{exists:false},{app:null}]){
  const f=fixture(options);expect(f.notifier.state()).toBe('not built');
  f.notifier.transition(agent(),running,waiting,false);f.notifier.transition(agent(),running,waiting,false);
  await vi.waitFor(()=>expect(f.logs).toEqual(['Notifier helper not built']));expect(f.calls).toEqual([]);
 }
});
it('the setting off, done while attached, a repeat or an unreadable setting send nothing',async()=>{
 const off=fixture({enabled:async()=>false});off.notifier.transition(agent(),running,waiting,false);
 const on=fixture();on.notifier.transition(agent(),running,done,true);on.notifier.transition(agent(),waiting,waiting,false);on.notifier.transition(agent(),running,{status:'exited',statusDetail:'exit 0'},false);
 const broken=fixture({enabled:async()=>{throw new Error('AITERMCANARY');}});broken.notifier.transition(agent(),running,waiting,false);broken.notifier.transition(agent(),running,waiting,false);
 await vi.waitFor(()=>expect(broken.logs).toEqual(['Notification settings unreadable']));
 await new Promise(r=>setTimeout(r,20));expect([...off.calls,...on.calls,...broken.calls]).toEqual([]);
});
it('the session manager reports each status change with whether a client is attached, and the server reports the notifier state',async()=>{
 const root=await mkdtemp('/tmp/ai-notifier-'),paths=getPaths(root);await preparePaths(paths);
 const entry=resolve('src/cli/index.ts'),log=new Logger(paths.log),usage=new UsageService(root,log),m=new SessionManager(paths,log,undefined,undefined,undefined,undefined,usage,entry);
 const server=new DaemonServer(paths,m,log,undefined,undefined,usage,{state:()=>'not built'});
 let client:Connection|undefined,env:NodeJS.ProcessEnv={},output:((text:string)=>void)|undefined;const exits:((e:{exitCode:number})=>void)[]=[];
 vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/stub/codex',version:'0.160.1',loggedIn:true,authMethod:'subscription'});
 vi.spyOn(pty,'spawn').mockImplementation((_file,_args,options)=>{env={...options?.env};return {pid:900004,onData:(cb:(text:string)=>void)=>{output=cb;return {dispose(){}};},onExit:(cb:(e:{exitCode:number})=>void)=>{exits.push(cb);return {dispose(){}};},write(){},resize(){},pause(){},resume(){}} as unknown as pty.IPty;});
 vi.spyOn(process,'kill').mockImplementation(()=>{for(const exit of exits)exit({exitCode:0});return true;});
 const changes:{status:string;previous:string;attached:boolean}[]=[];
 m.on('statusChanged',(session:SessionInfo,previous:{status:string},next:{status:string},attached:boolean)=>{changes.push({status:next.status,previous:previous.status,attached});expect(session.status).toBe(next.status);});
 try{
  await usage.start();await m.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});
  const id=(await m.create({engine:'codex',model:null,auth:{kind:'account'},cwd:root,permission:'ask'})).id;
  output?.('\x1b]0;Working | Context 90% left\x07');await m.snapshot(id);await expect.poll(()=>m.get(id).status).toBe('running');
  await fetch(`http://127.0.0.1:${env.AITERM_STATUS_PORT}/v1/status/codex`,{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':env.AITERM_STATUS_TOKEN??''},body:JSON.stringify({type:'agent-turn-complete'})});
  await expect.poll(()=>changes.at(-1)).toEqual({status:'done',previous:'running',attached:false});
  const response=validateSuccess(await client.request({kind:'engines.status'}));expect(response.notifier).toBe('not built');
 }finally{client?.close();await server.close();await m.shutdown();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});
it('agent output flipping a card between running and waiting cannot launch helpers without bound',async()=>{
 let clock=0;const calls:string[][]=[],logs:string[]=[];
 const notifier=new Notifier(APP,{error:text=>logs.push(text)},async()=>true,(_file,args,done)=>{calls.push([...args]);done(null);},()=>true,()=>clock);
 const session=agent(),other=agent();
 // One agent: at most one notification per 5 s.
 for(let i=0;i<20;i++){notifier.transition(session,running,waiting,false);clock+=100;}
 await vi.waitFor(()=>expect(calls).toHaveLength(1));
 clock+=5000;notifier.transition(session,running,waiting,false);await vi.waitFor(()=>expect(calls).toHaveLength(2));
 // All agents together: at most 10 a minute.
 for(let i=0;i<30;i++){notifier.transition(agent(),running,waiting,false);clock+=10;}
 await vi.waitFor(()=>expect(calls).toHaveLength(10),{timeout:10_000});
 expect(logs).toEqual(['Notifications rate limited']);
 clock+=60000;notifier.transition(other,running,waiting,false);await vi.waitFor(()=>expect(calls).toHaveLength(11));
});
it('a later successful launch clears the launch failed state',async()=>{
 const f=fixture();
 f.notifier.transition(agent(),running,waiting,false);await vi.waitFor(()=>expect(f.calls).toHaveLength(1));f.calls[0]?.done(new Error('x'));expect(f.notifier.state()).toBe('launch failed');
 f.notifier.transition(agent(),running,waiting,false);await vi.waitFor(()=>expect(f.calls).toHaveLength(2));f.calls[1]?.done(null);expect(f.notifier.state()).toBe('ready');
});
it('the daemon reads the setting through a store that tolerates a malformed key entry',async()=>{
 const {notificationsSetting}=await import('../src/daemon/notifier.js'),{writeFile}=await import('node:fs/promises');
 const root=await mkdtemp('/tmp/ai-notify-read-');
 try{
  const enabled=notificationsSetting(root);expect(await enabled()).toBe(true);
  await writeFile(`${root}/settings.json`,JSON.stringify({theme:'graphite',keys:[{id:'AITERMCANARY'}]}),{mode:0o600});expect(await enabled()).toBe(true);
  await writeFile(`${root}/settings.json`,JSON.stringify({theme:'graphite',notifications:false,keys:[{id:'AITERMCANARY'}]}),{mode:0o600});expect(await enabled()).toBe(false);
 }finally{await rm(root,{recursive:true,force:true});}
});

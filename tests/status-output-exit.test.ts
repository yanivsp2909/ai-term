import {expect,it,vi} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import pty from 'node-pty';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {Logger} from '../src/daemon/log.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import * as engines from '../src/daemon/engines.js';
it('queued first output never publishes a running state after synchronous process exit',async()=>{
 const root=await mkdtemp('/tmp/ai-status-exit-'),paths=getPaths(root);await preparePaths(paths);const log=new Logger(paths.log),usage=new UsageService(root,log),manager=new SessionManager(paths,log,undefined,undefined,undefined,undefined,usage);
 let output=(_text:string)=>{},exit=(_event:{exitCode:number})=>{};const events:unknown[]=[];manager.on('event',e=>events.push(e));
 vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'});
 vi.spyOn(pty,'spawn').mockImplementation(()=>({pid:900001,onData:(cb:typeof output)=>{output=cb;return {dispose(){}};},onExit:(cb:typeof exit)=>{const old=exit;exit=e=>{old(e);cb(e);};return {dispose(){}};},write(){},resize(){},pause(){},resume(){}} as unknown as pty.IPty));
 try{await usage.start();await manager.load();const s=await manager.create({engine:'claude-code',model:null,auth:{kind:'account'},cwd:root,permission:'ask'});events.length=0;output('ready');exit({exitCode:0});await manager.snapshot(s.id);expect(events.filter(e=>(e as {kind:string}).kind==='session.updated').map(e=>(e as {session:{status:string}}).session.status)).toEqual(['exited']);}finally{await manager.shutdown();await usage.close();vi.restoreAllMocks();await rm(root,{recursive:true,force:true});}
});

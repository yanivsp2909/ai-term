import { expect,it,vi } from 'vitest';
import { NotificationPermission } from '../src/daemon/notification-permission.js';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import { Notifier } from '../src/daemon/notifier.js';
import type { NotificationAuthorization,SessionInfo } from '../src/shared/protocol.js';
import { randomUUID } from 'node:crypto';
const results:NotificationAuthorization[]=['allowed','denied','not-asked','unknown'];
const texts=['on · allowed','on · blocked: turn on AI Term in System Settings → Notifications',"on · not asked yet: you'll be asked at the first notification",'on · permission unknown'];
it.each(results)('settings displays %s from the cached stub helper without color alone',async permission=>{
 const panel=new CredentialsPanel('settings',{request:async()=>({id:randomUUID(),ok:true,settings:{theme:'graphite'},notificationPermission:permission}),changed(){},close(){},login:async()=>{},defaults(){},theme:async()=>{}});
 await panel.load();expect(panel.lines().join('\n')).toContain(texts[results.indexOf(permission)]);
});
it('permission uses execFile argv and three-second timeout, caches for one minute and coalesces callers',async()=>{
 let now=0;const calls:unknown[][]=[];const cache=new NotificationPermission('/tmp/AI Term.app',()=>{},(file,args,options,done)=>{calls.push([file,args,options]);queueMicrotask(()=>done(null,'denied\n'));},()=>now,true);
 expect(await Promise.all([cache.refresh(),cache.refresh()])).toEqual(['denied','denied']);expect(calls).toHaveLength(1);
 expect(calls[0]).toMatchObject(['/tmp/AI Term.app/Contents/MacOS/AITermNotifier',['--status'],{timeout:3000}]);
 await cache.refresh();expect(calls).toHaveLength(1);now=60_000;await cache.refresh();expect(calls).toHaveLength(2);
});
it.each(['allowed','denied','not-asked','unknown','garbage','allowed\ndenied'])('maps exact helper word %s and retains unknown without verified direct identity',async word=>{
 const run:ConstructorParameters<typeof NotificationPermission>[2]=(_file,_args,_options,done)=>done(null,word+'\n');
 expect(await new NotificationPermission('/tmp/app',()=>{},run,()=>0,true).refresh()).toBe(results.includes(word as NotificationAuthorization)?word:'unknown');
 expect(await new NotificationPermission('/tmp/app',()=>{},run,()=>0,false).refresh()).toBe('unknown');
});
it('denied permission never launches a notification and logs the suppression once',async()=>{
 const launch=vi.fn(),log={error:vi.fn()},permission=new NotificationPermission('/tmp/app',()=>{},(_f,_a,_o,done)=>done(null,'denied'),()=>0,true);await permission.refresh();
 const notifier=new Notifier('/tmp/app',log,async()=>true,launch,()=>true,()=>0,permission);
 const session={id:randomUUID(),title:'task'} as SessionInfo;
 for(let i=0;i<2;i++)notifier.transition(session,{status:'running',statusDetail:'running'},{status:'waiting',statusDetail:'permission'},true);
 await new Promise(r=>setTimeout(r,0));expect(launch).not.toHaveBeenCalled();expect(log.error).toHaveBeenCalledTimes(1);
});
it('daemon-start checks and minute refreshes are nonblocking and stop on close',async()=>{
 vi.useFakeTimers();const run=vi.fn<NonNullable<ConstructorParameters<typeof NotificationPermission>[2]>>((_f,_a,_o,done)=>done(null,'allowed'));
 const cache=new NotificationPermission('/tmp/app',()=>{},run,Date.now,true);
 try{cache.start();expect(run).toHaveBeenCalledTimes(1);await vi.advanceTimersByTimeAsync(60_000);expect(run).toHaveBeenCalledTimes(2);cache.close();await vi.advanceTimersByTimeAsync(60_000);expect(run).toHaveBeenCalledTimes(2);}finally{cache.close();vi.useRealTimers();}
});
it('failed helper reads cache unknown and log only a fixed operation message',async()=>{
 const log=vi.fn(),cache=new NotificationPermission('/tmp/app',log,(_f,_a,_o,done)=>done(new Error('private argv'),'allowed'),()=>0,true);
 expect(await cache.refresh()).toBe('unknown');expect(await cache.refresh()).toBe('unknown');expect(log).toHaveBeenCalledExactlyOnceWith('Notification permission check failed');
});
it('permission words and bar action remain reachable in a short narrow settings overlay',async()=>{
 const {Grid,plainText}=await import('../src/client/tui/grid.js'),{createTheme}=await import('../src/client/tui/theme.js'),theme=createTheme('graphite');
 const panel=new CredentialsPanel('settings',{request:async()=>({id:randomUUID(),ok:true,settings:{theme:'graphite'},notificationPermission:'denied'}),changed(){},close(){},login:async()=>{},defaults(){},theme:async()=>{}});await panel.load();
 for(let i=0;i<8;i++)await panel.key('down');expect(plainText(panel.draw(new Grid(70,14,theme).cells,theme))).toContain('Notifications');
 await panel.key('down');expect(plainText(panel.draw(new Grid(70,14,theme).cells,theme))).toContain('bar: off');
});
it('ordinary settings reads in attach never wait for permission, while settings overlay explicitly refreshes',async()=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{getPaths,preparePaths}=await import('../src/shared/paths.js'),{Logger}=await import('../src/daemon/log.js'),{SessionManager}=await import('../src/daemon/session-manager.js'),{DaemonServer}=await import('../src/daemon/server.js'),{Connection}=await import('../src/client/connection.js');
 const root=await mkdtemp('/tmp/ai-permission-path-'),paths=getPaths(root);await preparePaths(paths);const log=new Logger(paths.log),manager=new SessionManager(paths,log),refresh=vi.fn(async()=> 'denied' as const),server=new DaemonServer(paths,manager,log,undefined,undefined,undefined,{state:()=> 'ready',permission:()=> 'allowed',refreshPermission:refresh});let connection:InstanceType<typeof Connection>|undefined;
 try{await manager.load();await server.listen();connection=await Connection.connect(paths,{entry:'/unused',autoStart:false});expect((await connection.request({kind:'settings.get'})).notificationPermission).toBe('allowed');expect(refresh).not.toHaveBeenCalled();expect((await connection.request({kind:'settings.get',refreshNotifications:true})).notificationPermission).toBe('denied');expect(refresh).toHaveBeenCalledOnce();}finally{connection?.close();await server.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
});

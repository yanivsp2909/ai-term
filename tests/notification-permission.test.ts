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
 for(let i=0;i<2;i++)notifier.transition(session,{status:'running',statusDetail:null},{status:'waiting',statusDetail:{reason:'permission'}},true);
 await new Promise(r=>setTimeout(r,0));expect(launch).not.toHaveBeenCalled();expect(log.error).toHaveBeenCalledTimes(1);
});

import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, lstat, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer, socketAnswers } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Mirror } from '../src/daemon/mirror.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { encodeControl, FrameDecoder, decodeControl } from '../src/shared/protocol.js';
const roots:string[]=[];
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0))await close();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function setup(args=['-c','printf stable; exit 0']) {
 const root=await mkdtemp(join(tmpdir(),'ai-term-server-'));roots.push(root);
 const paths=getPaths(root);await preparePaths(paths);
 const manager=new SessionManager(paths,new Logger(paths.log),{executable:'/bin/sh',args,env:{PATH:'/usr/bin:/bin'}});await manager.load();
 const server=new DaemonServer(paths,manager,new Logger(paths.log));await server.listen();
 cleanup.push(async()=>{await server.close();await manager.shutdown();});
 return {paths,manager,server};
}
it('broadcasts lifecycle events, renders snapshots first and refreshes a slow preview without pausing its PTY',async()=>{
 const {paths,manager}=await setup();
 const entry=resolve('src/cli/index.ts');
 const client=await Connection.connect(paths,{entry,autoStart:false});const observer=await Connection.connect(paths,{entry,autoStart:false});
 cleanup.unshift(async()=>{client.close();observer.close();});
 const events:unknown[]=[];observer.on('event',e=>events.push(e));
 const session=(await client.request({kind:'sessions.create',engine:'shell',cwd:paths.root})).session;
 if(!session)throw new Error('Missing session');
 await expect.poll(()=>manager.get(session.id).exitCode).toBe(0);
 expect(events).toContainEqual(expect.objectContaining({kind:'session.updated'}));
 const snapshot=await client.request({kind:'sessions.preview',sessionId:session.id});expect(snapshot.snapshot).toContain('stable');expect(snapshot.cols).toBe(85);
 const pause=vi.spyOn(PtyHost.prototype,'pause');
 const snapshots:unknown[]=[];client.on('event',e=>snapshots.push(e));client.socket.pause();
 for(let i=0;i<160;i++)manager.emit('output',session.id,Buffer.alloc(64*1024,120));
 client.socket.resume();
 await expect.poll(()=>snapshots.some(e=>typeof e==='object'&&e!==null&&'snapshot' in e&&String(e.snapshot).includes('stable')),{timeout:3000}).toBe(true);
 expect(pause).not.toHaveBeenCalled();
 expect((await client.request({kind:'sessions.list'})).sessions).toHaveLength(1);
 await client.request({kind:'layout.previewSize',cols:40,rows:12});
 expect((await client.request({kind:'sessions.preview',sessionId:session.id})).cols).toBe(40);
 await client.request({kind:'sessions.preview',sessionId:null});
 expect((await client.request({kind:'sessions.rename',sessionId:session.id,title:'renamed'})).session?.title).toBe('renamed');
 await client.request({kind:'sessions.stop',sessionId:session.id});
 await client.request({kind:'sessions.remove',sessionId:session.id});
 await expect.poll(()=>events.some(e=>typeof e==='object'&&e!==null&&'kind' in e&&e.kind==='session.removed')).toBe(true);
 await expect(client.request({kind:'sessions.stop',sessionId:randomUUID()})).rejects.toThrow('Session operation failed');
},10000);
it('requires hello and refuses unsafe socket modes; probes do not unlink a live socket',async()=>{
 const {paths}=await setup();expect(await socketAnswers(paths.socket)).toBe(true);
 const socket=createConnection(paths.socket);cleanup.unshift(async()=>{socket.destroy();});
 const decoder=new FrameDecoder();const reply=new Promise<unknown>(r=>socket.on('data',data=>{for(const f of decoder.push(data))r(decodeControl(f));}));
 socket.write(encodeControl({id:randomUUID(),kind:'sessions.list'}));expect(await reply).toMatchObject({ok:false,error:{code:'HELLO_REQUIRED'}});
 await chmod(paths.socket,0o666);await expect(Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false})).rejects.toThrow('Unsafe daemon socket');await chmod(paths.socket,0o600);
 expect((await lstat(paths.socket)).mode&0o777).toBe(0o600);
});
it('suppresses mirror replies while attached and restores replies on detach',async()=>{
 const reply=vi.fn();const mirror=new Mirror(40,12,reply);
 try{mirror.setAttached(true);await mirror.write('\x1b[6n');expect(reply).not.toHaveBeenCalled();mirror.setAttached(false);await mirror.write('\x1b[6n');expect(reply).toHaveBeenCalledWith('\x1b[1;1R');}finally{mirror.dispose();}
});
it('stops a live PTY, resizes it, and supports pause/resume',async()=>{
 const {paths,manager}=await setup(['-c','printf ready; read answer']);
 const session=await manager.create({cwd:paths.root});await expect.poll(()=>manager.get(session.id).status).toBe('running');
 await expect(manager.remove(session.id)).rejects.toThrow('Only exited');
 await manager.previewSize(20,5);await manager.stop(session.id);
 expect(['exited','error']).toContain(manager.get(session.id).status);
 const host=new PtyHost({executable:'/bin/sh',args:['-c','read answer'],env:{PATH:'/usr/bin:/bin'}},paths.root,20,5);
 try{host.pause();host.resume();host.write('done\n');await host.stop();}finally{await host.stop();}
});
it('rejects queued request bytes while an earlier operation is blocked and keeps other clients alive',async()=>{
 const {paths,manager}=await setup();
 const socket=createConnection(paths.socket);cleanup.unshift(async()=>{socket.destroy();});
 const decoder=new FrameDecoder();const messages:unknown[]=[];socket.on('data',data=>{for(const frame of decoder.push(data))messages.push(decodeControl(frame));});
 socket.write(encodeControl({id:randomUUID(),kind:'hello',protocol:1,version:'test'}));await expect.poll(()=>messages.length).toBeGreaterThan(0);
 let unblock:()=>void=()=>{};const gate=new Promise<void>(r=>{unblock=r;});const resize=manager.previewSize.bind(manager);
 vi.spyOn(manager,'previewSize').mockImplementation(async(cols,rows)=>{await gate;await resize(cols,rows);});
 socket.write(encodeControl({id:randomUUID(),kind:'layout.previewSize',cols:20,rows:5}));
 const body={id:randomUUID(),kind:'sessions.list',padding:'x'.repeat(3*1024*1024)};
 try{for(let i=0;i<4;i++)socket.write(encodeControl(body));await expect.poll(()=>messages.some(e=>typeof e==='object'&&e!==null&&'error' in e&&JSON.stringify(e).includes('TOO_MANY_REQUESTS')),{timeout:3000}).toBe(true);}finally{unblock();socket.destroy();}
 const other=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false});try{expect((await other.request({kind:'sessions.list'})).sessions).toEqual([]);}finally{other.close();}
});

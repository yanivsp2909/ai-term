import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Connection } from '../src/client/connection.js';
import { encodeData } from '../src/shared/protocol.js';
import { PtyHost } from '../src/daemon/pty-host.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const close of cleanup.splice(0))await close();});
async function setup(script='stty -echo; while read line; do eval "$line"; done') {
 const root=await mkdtemp(join(tmpdir(),'ai-term-attach-'));const paths=getPaths(root);await preparePaths(paths);
 const manager=new SessionManager(paths,new Logger(paths.log),{executable:'/bin/sh',args:['-c',script],env:{PATH:'/usr/bin:/bin'}});await manager.load();
 const server=new DaemonServer(paths,manager,new Logger(paths.log));await server.listen();
 const a=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false}),b=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false});
 cleanup.push(async()=>{a.close();b.close();await server.close();await manager.shutdown();await rm(root,{recursive:true,force:true});});
 const s=await manager.create({cwd:root});return {paths,manager,server,a,b,id:s.id};
}
it('only attached input reaches the PTY; takeover notifies previous owner and stale detach cannot steal it',async()=>{
 const {a,b,id,manager,paths}=await setup();const events:unknown[]=[];a.on('event',e=>events.push(e));
 await a.request({kind:'sessions.attach',sessionId:id,cols:70,rows:20});
 b.socket.write(encodeData(3,id,Buffer.from('printf UNAUTHORIZED\n')));
 a.socket.write(encodeData(3,id,Buffer.from('printf AUTHORIZED\n')));
 await expect.poll(()=>manager.snapshot(id)).toContain('AUTHORIZED');expect(await manager.snapshot(id)).not.toContain('UNAUTHORIZED');
 await b.request({kind:'sessions.attach',sessionId:id,cols:60,rows:18});
 await expect.poll(()=>events).toContainEqual({kind:'session.detached',sessionId:id,reason:'attached elsewhere'});
 await a.request({kind:'sessions.detach',sessionId:id});
 a.socket.write(encodeData(3,id,Buffer.from('printf STALE_OWNER\n')));b.socket.write(encodeData(3,id,Buffer.from('printf NEW_OWNER\n')));
 await expect.poll(()=>manager.snapshot(id)).toContain('NEW_OWNER');expect(await manager.snapshot(id)).not.toContain('STALE_OWNER');
 expect(await readFile(paths.log,'utf8')).toContain('Dropped input from non-attached client');expect(await readFile(paths.log,'utf8')).not.toContain('UNAUTHORIZED');
});
it('real PTY stty size follows attach and restores preview on detach or disconnect',async()=>{
 const {a,b,id,manager}=await setup();await b.request({kind:'layout.previewSize',cols:40,rows:12});
 const attached=await a.request({kind:'sessions.attach',sessionId:id,cols:73,rows:21});expect(attached).toMatchObject({cols:73,rows:21});
 a.socket.write(encodeData(3,id,Buffer.from('stty size\n')));await expect.poll(()=>manager.snapshot(id)).toContain('21 73');
 await a.request({kind:'sessions.detach',sessionId:id});
 expect((await b.request({kind:'sessions.preview',sessionId:id}))).toMatchObject({cols:40,rows:12});
 await a.request({kind:'sessions.attach',sessionId:id,cols:91,rows:25});a.close();
 await expect.poll(async()=>{const p=await b.request({kind:'sessions.preview',sessionId:id});return [p.cols,p.rows];}).toEqual([40,12]);
 await b.request({kind:'sessions.attach',sessionId:id,cols:40,rows:12});b.socket.write(encodeData(3,id,Buffer.from('stty size\n')));await expect.poll(()=>manager.snapshot(id)).toContain('12 40');
});
it('attached backpressure pauses and drains without overriding mirror backpressure',async()=>{
 const {a,id,manager}=await setup('printf ready; read answer');const pause=vi.spyOn(PtyHost.prototype,'pause'),resume=vi.spyOn(PtyHost.prototype,'resume');
 await a.request({kind:'sessions.attach',sessionId:id,cols:40,rows:12});a.socket.pause();
 for(let i=0;i<100;i++)manager.emit('output',id,Buffer.alloc(65536,120));
 expect(pause).toHaveBeenCalled();a.socket.resume();await expect.poll(()=>resume.mock.calls.length).toBeGreaterThan(0);
});

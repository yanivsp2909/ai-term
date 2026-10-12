import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runDaemon } from '../src/daemon/main.js';
import { Connection } from '../src/client/connection.js';
import { getPaths, isFsError } from '../src/shared/paths.js';
const roots:string[]=[];
afterEach(async()=>{vi.useRealTimers();vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function root(){const path=await mkdtemp(join(tmpdir(),'ai-term-main-'));roots.push(path);return path;}
async function exists(path:string){try{await lstat(path);return true;}catch(e){if(isFsError(e,'ENOENT'))return false;throw e;}}
it('automatically starts its own detached daemon and shuts that process down cleanly',async()=>{
 const paths=getPaths(await root());vi.stubEnv('SHELL','/bin/sh');
 const client=await Connection.connect(paths,{entry:resolve('src/cli/index.ts')});const pid=(await client.hello).daemonPid;if(!pid)throw new Error('No daemon PID');
 try{expect((await client.request({kind:'sessions.list'})).sessions).toEqual([]);}finally{client.close();process.kill(pid,'SIGTERM');await expect.poll(()=>exists(paths.pid),{timeout:5000}).toBe(false);}
},10000);
it('idles out after ten minutes with no live sessions or clients',async()=>{
 const paths=getPaths(await root());vi.stubEnv('AI_TERM_HOME',paths.root);vi.stubEnv('SHELL','/bin/sh');
 const mask=process.umask();vi.useFakeTimers({toFake:['Date','setInterval','clearInterval']});
 const running=runDaemon();
 try{await expect.poll(()=>exists(paths.socket),{timeout:10000}).toBe(true);await vi.advanceTimersByTimeAsync(601000);await running;expect(await exists(paths.pid)).toBe(false);expect(await exists(paths.socket)).toBe(false);}finally{vi.useRealTimers();process.umask(mask);}
},20000);
it('still stops live sessions when socket cleanup fails',async()=>{
 const {DaemonServer}=await import('../src/daemon/server.js');const {SessionManager}=await import('../src/daemon/session-manager.js');
 const paths=getPaths(await root());vi.stubEnv('AI_TERM_HOME',paths.root);vi.stubEnv('SHELL','/bin/sh');const mask=process.umask(),oldExit=process.exitCode;
 const realClose=DaemonServer.prototype.close;
 vi.spyOn(DaemonServer.prototype,'close').mockImplementation(async function(this:InstanceType<typeof DaemonServer>){await realClose.call(this);throw new Error('forced cleanup failure');});
 const stopped=vi.spyOn(SessionManager.prototype,'shutdown');const running=runDaemon();
 await expect.poll(()=>exists(paths.socket)).toBe(true);const client=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false});
 await client.request({kind:'sessions.create',engine:'shell',cwd:paths.root});client.close();process.emit('SIGTERM');await running;
 expect(stopped).toHaveBeenCalled();expect(await exists(paths.pid)).toBe(false);expect(process.exitCode).toBe(1);
 process.exitCode=oldExit;process.umask(mask);vi.restoreAllMocks();
});

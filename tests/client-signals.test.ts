import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { openSync, closeSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import * as pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Connection } from '../src/client/connection.js';

// B34: the homepage opens /login when no engine is logged in and no key is saved, which depends on this machine's claude
// and codex and lands at a moment of its own. The daemon here says both are logged in, so it never opens.
vi.mock('../src/daemon/engines.js', async importOriginal => {
  const status = { installed: true, path: '/bin/sh', version: '1.0.0', loggedIn: true, authMethod: 'subscription' as const };
  return { ...await importOriginal<typeof import('../src/daemon/engines.js')>(), enginesStatus: async () => ({ claudeCode: status, codex: status }) };
});

it.each(['SIGTERM','SIGHUP'] as const)('spawned client quits on %s from homepage and attach, leaving sessions running',async signal=>{
 const root=await mkdtemp('/tmp/ai-sig-'),paths=getPaths(root);await preparePaths(paths);
 const log=new Logger(paths.log),manager=new SessionManager(paths,log,{executable:'/bin/sh',args:['-c','printf SESSION_READY; read answer'],env:{PATH:'/usr/bin:/bin'}});
 const server=new DaemonServer(paths,manager,log);let client:Connection|undefined;
 try{
  const events:unknown[]=[];manager.on('event',event=>events.push(event));
  await manager.load();await server.listen();const session=await manager.create({cwd:root});await expect.poll(()=>manager.get(session.id).status,{timeout:10000}).toBe('running');
  client=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false});
  for(const attached of [false,true]){
   const child=pty.spawn(process.execPath,['--import','tsx',resolve('src/cli/index.ts')],{cwd:resolve('.'),cols:130,rows:45,env:{PATH:'/usr/bin:/bin',HOME:root,AI_TERM_HOME:root,TERM:'xterm-256color',COLORTERM:'truecolor'}});
   // Linux drops unread PTY output when the child side hangs up (3 in 60 under load); holding the slave open avoids the hang-up.
   const slave=openSync((child as unknown as {ptsName:string}).ptsName,constants.O_RDWR|constants.O_NOCTTY);
   let output='',finished=false;child.onData(data=>{output+=data;});const exited=new Promise<number>(r=>child.onExit(event=>{finished=true;r(event.exitCode);}));
   try{
    // B10: a spawned client process; under full-suite load it can take over the default 1 s to draw.
    await expect.poll(()=>output,{timeout:10000}).toContain('AI Term'); if(output.includes('Connect a provider')){child.write('\x1b');await new Promise(r=>setTimeout(r,100));}
    // SESSION_READY can come from the homepage preview too; the daemon resizes to the client's 130x45 only once attached.
    // B34: the attach is a spawned client's too, so it gets the same 10 s.
    if(attached){child.write('\r');await expect.poll(()=>events,{timeout:10000}).toContainEqual({kind:'session.previewResized',sessionId:session.id,cols:130,rows:45});}
    output='';child.kill(signal);expect(await exited).toBe(signal==='SIGTERM'?143:129);
    // node-pty can deliver the last bytes after the exit event.
    await expect.poll(()=>output).toContain('\x1b[?1049l');expect(output).toContain('\x1b[?2004l');
    expect(manager.get(session.id).status).toBe('running');expect((await client.request({kind:'sessions.list'})).sessions).toHaveLength(1);
   }finally{if(!finished){child.kill();await exited;}closeSync(slave);}
  }
 }finally{client?.close();await server.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
},15000);

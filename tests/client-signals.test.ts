import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import * as pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Connection } from '../src/client/connection.js';

it.each(['SIGTERM','SIGHUP'] as const)('spawned client quits on %s from homepage and attach, leaving sessions running',async signal=>{
 const root=await mkdtemp('/tmp/ai-sig-'),paths=getPaths(root);await preparePaths(paths);
 const log=new Logger(paths.log),manager=new SessionManager(paths,log,{executable:'/bin/sh',args:['-c','printf SESSION_READY; read answer'],env:{PATH:'/usr/bin:/bin'}});
 const server=new DaemonServer(paths,manager,log);let client:Connection|undefined;
 try{
  await manager.load();await server.listen();const session=await manager.create({cwd:root});await expect.poll(()=>manager.get(session.id).status).toBe('running');
  client=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false});
  for(const attached of [false,true]){
   const child=pty.spawn(process.execPath,['--import','tsx',resolve('src/cli/index.ts')],{cwd:root,cols:130,rows:45,env:{PATH:'/usr/bin:/bin',HOME:root,AI_TERM_HOME:root,TERM:'xterm-256color',COLORTERM:'truecolor'}});
   let output='',finished=false;child.onData(data=>{output+=data;});const exited=new Promise<number>(r=>child.onExit(event=>{finished=true;r(event.exitCode);}));
   try{
    await expect.poll(()=>output).toContain('AI Term');
    if(attached){output='';child.write('\r');await expect.poll(()=>output).toContain('SESSION_READY');}
    child.kill(signal);expect(await exited).toBe(signal==='SIGTERM'?143:129);
    expect(output).toContain('\x1b[?1049l');expect(output).toContain('\x1b[?2004l');
    expect(manager.get(session.id).status).toBe('running');expect((await client.request({kind:'sessions.list'})).sessions).toHaveLength(1);
   }finally{if(!finished){child.kill();await exited;}}
  }
 }finally{client?.close();await server.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
},15000);

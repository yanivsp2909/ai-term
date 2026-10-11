import { expect,it } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { lstatSync } from 'node:fs';
import { Server } from 'node:net';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getPaths,preparePaths } from '../src/shared/paths.js';
import { DaemonServer } from '../src/daemon/server.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';

it('creates the private daemon socket as 0600 before any startup client can observe it',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-socket-startup-')),paths=getPaths(root);await preparePaths(paths);
 const manager=new SessionManager(paths,new Logger(paths.log)),server=new DaemonServer(paths,manager,new Logger(paths.log));
 const mask=process.umask(0o077),listen=Server.prototype.listen;let initialMode:number|undefined;
 Server.prototype.listen=function(this:Server,...args:unknown[]){const result=Reflect.apply(listen,this,args) as Server;initialMode=lstatSync(paths.socket).mode&0o777;return result;};
 try{await server.listen();expect(initialMode).toBe(0o600);expect(process.umask()).toBe(0o077);}
 finally{Server.prototype.listen=listen;process.umask(mask);await server.close();await manager.shutdown();await rm(root,{recursive:true,force:true});}
});

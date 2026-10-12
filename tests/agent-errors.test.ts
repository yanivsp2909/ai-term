import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Connection } from '../src/client/connection.js';
it('missing CLI has an actionable error and never creates a misleading live record',async()=>{
 const root=await mkdtemp('/tmp/ai-errors-'),paths=getPaths(root);await preparePaths(paths);const old=process.env.PATH;process.env.PATH=root;
 const log=new Logger(paths.log),manager=new SessionManager(paths,log),server=new DaemonServer(paths,manager,log);let client:Connection|undefined;
 try{await manager.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});await expect(client.request({kind:'sessions.create',engine:'claude-code',model:null,auth:{kind:'account'},cwd:root,permission:'ask'})).rejects.toThrow('claude not found in PATH');expect(manager.list()).toEqual([]);}
 finally{client?.close();await server.close();await manager.shutdown();if(old===undefined)delete process.env.PATH;else process.env.PATH=old;await rm(root,{recursive:true,force:true});}
});

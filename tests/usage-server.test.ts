import {expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {Logger} from '../src/daemon/log.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {DaemonServer} from '../src/daemon/server.js';
import {Connection} from '../src/client/connection.js';
it('summary subscription and diagnostics round-trip with updates sent only to subscribers',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-server-'),p=getPaths(root);await preparePaths(p);const log=new Logger(p.log),usage=new UsageService(root,log),m=new SessionManager(p,log),server=new DaemonServer(p,m,log,undefined,undefined,usage);let a:Connection|undefined,b:Connection|undefined;
 try{await usage.start();await m.load();await server.listen();a=await Connection.connect(p,{entry:'/unused',autoStart:false});b=await Connection.connect(p,{entry:'/unused',autoStart:false});const mine:unknown[]=[],other:unknown[]=[];a.on('event',e=>mine.push(e));b.on('event',e=>other.push(e));expect((await a.request({kind:'usage.summary'})).usage?.today.tokens).toBe(0);await a.request({kind:'usage.subscribe',on:true});usage.emit('updated',usage.summary());await expect.poll(()=>mine.some(e=>JSON.stringify(e).includes('usage.updated'))).toBe(true);expect(other.some(e=>JSON.stringify(e).includes('usage.updated'))).toBe(false);expect((await a.request({kind:'usage.diagnostics'})).usageDiagnostics?.port).toBeGreaterThan(0);await a.request({kind:'usage.subscribe',on:false});
 }finally{a?.close();b?.close();await server.close();await m.shutdown();await usage.close();await rm(root,{recursive:true,force:true});}
});

import { expect,it,vi } from 'vitest';
import { mkdtemp,rm,readFile,writeFile,stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths,preparePaths } from '../src/shared/paths.js';
import { KeyStore } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Connection } from '../src/client/connection.js';
import * as engines from '../src/daemon/engines.js';
import pty from 'node-pty';
const secret='sk-ant-'+'AITERMCANARY0000';
it('all key handlers are secret-free and keyed spawn puts secret only in child env',async()=>{
 const root=await mkdtemp('/tmp/ai-key-handler-'),p=getPaths(root);await preparePaths(p);const values=new Map<string,string>();
 const keys=new KeyStore(root,{vault:{read:async a=>values.get(a)??null,write:async(a,s)=>{values.set(a,s);},remove:async a=>{values.delete(a);}}});
 const log=new Logger(p.log),m=new SessionManager(p,log,undefined,undefined,undefined,keys),server=new DaemonServer(p,m,log,undefined,keys);let client:Connection|undefined;
 const status=vi.spyOn(engines,'checkEngine').mockResolvedValue({installed:true,path:'/bin/sh',version:'1',loggedIn:false,authMethod:'unknown'});
 const real=pty.spawn;let argv:string[]=[];let env:NodeJS.ProcessEnv={};const spawn=vi.spyOn(pty,'spawn').mockImplementation((_exe,args,opts)=>{argv=Array.isArray(args)?args:[];env=opts?.env??{};return real('/bin/sh',['-c','printf ready; read done'],{...opts,env:{PATH:'/usr/bin:/bin'}});});
 try{await m.load();await server.listen();client=await Connection.connect(p,{entry:'/unused',autoStart:false});const events:unknown[]=[];client.on('event',e=>events.push(e));const replies:unknown[]=[];
 const added=await client.request({kind:'keys.add',provider:'anthropic',label:'test',secret});replies.push(added);const id=added.key?.id;if(!id)throw new Error('Missing key');replies.push(await client.request({kind:'keys.list'}));
 const session=await client.request({kind:'sessions.create',engine:'claude-code',model:'sonnet',auth:{kind:'key',keyId:id},cwd:root,permission:'ask'});replies.push(session);expect(env.ANTHROPIC_API_KEY).toBe(secret);expect(argv.join(' ')).not.toContain(secret);expect(session.session?.auth).toMatchObject({kind:'key',last4:'0000'});
 if(!session.session)throw new Error('Missing session');await expect.poll(()=>m.get(session.session?.id??'').status).toBe('running');replies.push(await client.request({kind:'sessions.attach',sessionId:session.session.id,cols:80,rows:24}));replies.push(await client.request({kind:'sessions.detach',sessionId:session.session.id}));replies.push(await client.request({kind:'sessions.list'}));
 await client.request({kind:'keys.remove',keyId:id});expect(values.size).toBe(0);expect(m.get(session.session.id).status).toBe('running');await client.request({kind:'sessions.stop',sessionId:session.session.id});
 const path=join(root,'input.env');await writeFile(path,'ANTHROPIC_API_KEY='+secret+'\n',{mode:0o600});const before=await stat(path);replies.push(await client.request({kind:'keys.scanEnvFile',path}));const imported=await client.request({kind:'keys.importEnv',path,names:['ANTHROPIC_API_KEY']});replies.push(imported);expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);for(const key of imported.keys??[])await client.request({kind:'keys.remove',keyId:key.id});await rm(path);
 replies.push(await client.request({kind:'settings.get'}));expect(JSON.stringify([...replies,...events])).not.toContain('AITERMCANARY');for(const file of [p.state,join(root,'settings.json'),p.log]){const text=await readFile(file,'utf8').catch(()=> '');expect(text).not.toContain('AITERMCANARY');}
 }finally{client?.close();await server.close();await m.shutdown();status.mockRestore();spawn.mockRestore();await rm(root,{recursive:true,force:true});}
});

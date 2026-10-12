// v0.1.9 release gate: properties that held on review, pinned so a later change can't quietly break them.
import {expect,it} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,readdir,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {SettingsStore} from '../src/daemon/settings.js';
import {Logger} from '../src/daemon/log.js';
import {validateRequest} from '../src/shared/validate.js';
import {randomUUID} from 'node:crypto';
it('x and /clean remove records only: project files stay, running agents are refused and keep running',async()=>{
 const root=await mkdtemp('/tmp/ai-gate-remove-'),paths=getPaths(join(root,'home'));await preparePaths(paths);const project=join(root,'project');
 const {mkdir}=await import('node:fs/promises');await mkdir(project);await writeFile(join(project,'work.txt'),'keep me');
 const manager=new SessionManager(paths,new Logger(paths.log),{executable:'/bin/sh',args:['-c','echo ready; read line; exit 0'],env:{PATH:'/usr/bin:/bin'}});
 try{await manager.load();const done=await manager.create({cwd:project}),live=await manager.create({cwd:project});
  await expect.poll(()=>manager.get(live.id).status,{timeout:10000}).toBe('running');
  manager.input(done.id,Buffer.from('\n'));await manager.stop(done.id);await expect.poll(()=>manager.get(done.id).status,{timeout:10000}).toMatch(/exited|error/);
  await expect(manager.remove(live.id)).rejects.toThrow('Only exited sessions can be removed');expect(manager.get(live.id).status).toBe('running');
  await manager.remove(done.id);
  expect(manager.list().map(s=>s.id)).toEqual([live.id]);expect(await readFile(join(project,'work.txt'),'utf8')).toBe('keep me');expect(await readdir(project)).toEqual(['work.txt']);
 }finally{await manager.shutdown();await rm(root,{recursive:true,force:true});}
},20000);
it('neither auto nor Don\'t ask can become a saved default, by patch or by hand-editing settings.json',async()=>{
 for(const permission of ['auto','dontAsk'])await expect(validateRequest({id:randomUUID(),kind:'settings.set',patch:{permission}})).rejects.toThrow('permission default must be ask');
 const root=await mkdtemp('/tmp/ai-gate-settings-'),paths=getPaths(root);await preparePaths(paths);
 try{for(const permission of ['auto','dontAsk']){await writeFile(join(root,'settings.json'),JSON.stringify({theme:'graphite',permission}),{mode:0o600});await chmod(join(root,'settings.json'),0o600);
  // Fails closed: a tampered default is an error, never a silently honoured bypass.
  await expect(new SettingsStore(root).get()).rejects.toThrow();}
 }finally{await rm(root,{recursive:true,force:true});}
});

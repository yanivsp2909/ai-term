import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, readdir, lstat, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger, redact } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Mirror } from '../src/daemon/mirror.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { MAX_FRAME_BYTES } from '../src/shared/protocol.js';
import { atomicWrite } from '../src/daemon/store.js';
import { warningText } from '../src/shared/validate.js';
it('warning text strips ESC, C0 and C1 and caps at 200 characters',()=>{
 const text=warningText('\x1b[31mred\x1b[0m\x00\x07\x9b'+ 'x'.repeat(300));
 expect(text).not.toMatch(/[\p{C}]/u);expect([...text]).toHaveLength(200);expect(text).toMatch(/^redx/);
});
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function paths(){const root=await mkdtemp(join(tmpdir(),'ai-term-failures-'));roots.push(root);const paths=getPaths(root);await preparePaths(paths);return paths;}
it('redacts quoted JSON credential fields in every retained log',async()=>{
 const p=await paths();const log=new Logger(p.log,80);
 for(let i=0;i<6;i++)log.info('{"OPENAI_API_KEY":"CANARY_VALUE", "accessToken":"TOKEN_VALUE", "password":"PASSWORD_VALUE"}');
 expect(redact('{"secret": "SECRET_VALUE"}')).not.toContain('SECRET_VALUE');
 for(const path of [p.log,p.log+'.1',p.log+'.2'])expect(await readFile(path,'utf8')).not.toMatch(/CANARY_VALUE|TOKEN_VALUE|PASSWORD_VALUE/);
});
it('pauses a PTY for a stalled mirror queue and resumes when its own queue drains',async()=>{
 const p=await paths();const pause=vi.spyOn(PtyHost.prototype,'pause');const resume=vi.spyOn(PtyHost.prototype,'resume');
 let release:()=>void=()=>{};const gate=new Promise<void>(r=>{release=r;});const real=Mirror.prototype.write;
 vi.spyOn(Mirror.prototype,'write').mockImplementation(async function(this:Mirror,data){await gate;await real.call(this,data);});
 const manager=new SessionManager(p,new Logger(p.log),{executable:'/bin/sh',args:['-c','i=0; while [ "$i" -lt 2500 ]; do printf "%01000d" 1; i=$((i+1)); done; read answer'],env:{PATH:'/usr/bin:/bin'}});await manager.load();
 await manager.create({cwd:p.root});
 try{await expect.poll(()=>pause.mock.calls.length,{timeout:3000}).toBeGreaterThan(0);release();await expect.poll(()=>resume.mock.calls.length,{timeout:5000}).toBeGreaterThan(0);}finally{release();await manager.shutdown();}
},10000);
it('bounds serialized snapshots by trimming scrollback',async()=>{
 const mirror=new Mirror(1000,500,()=>{});
 try{await mirror.write(('x'.repeat(1000)+'\r\n').repeat(5500));expect(Buffer.byteLength(mirror.snapshot())).toBeLessThan(MAX_FRAME_BYTES-2048);}finally{mirror.dispose();}
},10000);
it('moves a corrupted state file aside, and moves a symlinked state aside without following it (B24)',async()=>{
 const p=await paths();await writeFile(p.state,'{bad');const manager=new SessionManager(p,new Logger(p.log));await manager.load();expect(manager.list()).toEqual([]);
 const moved=async()=>(await readdir(p.root)).filter(name=>name.startsWith('state.json.corrupt-'));expect(await moved()).toHaveLength(1);
 await rm(p.state);for(const name of await moved())await rm(join(p.root,name));
 const target=join(p.root,'target');await writeFile(target,'{"sessions":[]}');await symlink(target,p.state);
 const next=new SessionManager(p,new Logger(p.log));await next.load();
 // The link itself moved; its target is untouched, and the new state.json is a regular file, not written through the link.
 const [link]=await moved();expect((await lstat(join(p.root,link??''))).isSymbolicLink()).toBe(true);
 expect(await readFile(target,'utf8')).toBe('{"sessions":[]}');expect((await lstat(p.state)).isFile()).toBe(true);
 await next.shutdown();await manager.shutdown();
});
it('keeps a running session through ENOSPC and retries state on the next change',async()=>{
 const p=await paths();let fail=false;
 const writer=vi.fn(async(path:string,value:unknown)=>{if(fail)throw Object.assign(new Error('ENOSPC SECRET=PRIVATE'),{code:'ENOSPC'});await atomicWrite(path,value);});
 const manager=new SessionManager(p,new Logger(p.log),{executable:'/bin/sh',args:['-c','printf up; read answer'],env:{PATH:'/usr/bin:/bin'}},undefined,writer);
 const events:unknown[]=[];const fatal=vi.fn();manager.on('event',event=>events.push(event));manager.on('fatal',fatal);
 try{
  await manager.load();const session=await manager.create({cwd:p.root});await expect.poll(()=>manager.get(session.id).status).toBe('running');
  fail=true;await manager.rename(session.id,'new title');expect(manager.get(session.id).status).toBe('running');expect(fatal).not.toHaveBeenCalled();
  expect(events).toContainEqual({kind:'daemon.warning',text:expect.any(String)});expect(JSON.stringify(events)).not.toContain('PRIVATE');
  fail=false;await manager.rename(session.id,'saved title');expect(events).toContainEqual({kind:'daemon.warningCleared'});
  expect(await readFile(p.state,'utf8')).toContain('saved title');expect(manager.get(session.id).status).toBe('running');
 }finally{fail=false;await manager.shutdown();}
});
it('log write failures do not throw or stop sessions and clear only after recovery',async()=>{
 const p=await paths();const log=new Logger(p.log);const manager=new SessionManager(p,log,{executable:'/bin/sh',args:['-c','printf up; read answer'],env:{PATH:'/usr/bin:/bin'}});
 const events:unknown[]=[];manager.on('event',event=>events.push(event));
 try{
  await manager.load();const session=await manager.create({cwd:p.root});await expect.poll(()=>manager.get(session.id).status).toBe('running');
  await rm(p.log,{force:true});await symlink(p.state,p.log);
  expect(()=>log.error('SECRET=PRIVATE')).not.toThrow();expect(manager.get(session.id).status).toBe('running');
  expect(events).toContainEqual({kind:'daemon.warning',text:expect.any(String)});
  await rm(p.log);log.info('recovered');expect(events).toContainEqual({kind:'daemon.warningCleared'});
  expect(JSON.stringify(events)).not.toContain('PRIVATE');
 }finally{await rm(p.log,{force:true});await manager.shutdown();}
});

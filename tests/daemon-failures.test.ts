import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger, redact } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Mirror } from '../src/daemon/mirror.js';
import { PtyHost } from '../src/daemon/pty-host.js';
import { MAX_FRAME_BYTES } from '../src/shared/protocol.js';
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
it('fails safely on a corrupted state file and refuses a symlinked state',async()=>{
 const p=await paths();await writeFile(p.state,'{bad');const manager=new SessionManager(p,new Logger(p.log));await expect(manager.load()).rejects.toThrow();
 await rm(p.state);const target=join(p.root,'target');await writeFile(target,'{"sessions":[]}');await symlink(target,p.state);await expect(manager.load()).rejects.toThrow();
});

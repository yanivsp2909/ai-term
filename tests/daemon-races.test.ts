import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import * as validate from '../src/shared/validate.js';
it('does not spawn a session whose cwd validation finishes after shutdown',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-race-'));const paths=getPaths(root);await preparePaths(paths);
 const manager=new SessionManager(paths,new Logger(paths.log),{executable:'/bin/sh',args:['-c','printf late; exit 0'],env:{PATH:'/usr/bin:/bin'}});await manager.load();
 let release:(ok:boolean)=>void=()=>{};const gate=new Promise<boolean>(r=>{release=r;});const check=vi.spyOn(validate,'validCwd').mockImplementation(()=>gate);
 const creating=manager.create({cwd:root});
 try{await manager.shutdown();release(true);await expect(creating).rejects.toThrow('Invalid session request');expect(manager.list()).toEqual([]);}finally{release(true);await manager.shutdown();check.mockRestore();await rm(root,{recursive:true,force:true});}
});

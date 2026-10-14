import {expect,it} from 'vitest';
import {mkdtemp,rm,mkdir,symlink,readlink,writeFile,lstat} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {commandPlan,installCommand,uninstallCommand} from '../app/main/command-install.js';
const target='/Applications/AI Term.app/Contents/MacOS/ai';
async function withHome(run:(home:string)=>Promise<void>):Promise<void>{const home=await mkdtemp(join(tmpdir(),'ai-install-'));try{await run(home);}finally{await rm(home,{recursive:true,force:true});}}
it('creates only the proposed symlink and treats our existing link as installed',()=>withHome(async home=>{
 const plan=commandPlan(home,target);expect(plan.link).toBe(join(home,'.local/bin/ai'));await installCommand(plan);expect(await readlink(plan.link)).toBe(target);await installCommand(plan);await uninstallCommand(plan);await expect(lstat(plan.link)).rejects.toMatchObject({code:'ENOENT'});
}));
it.each(['file','link'])('refuses a foreign %s and leaves it untouched on uninstall',kind=>withHome(async home=>{
 const plan=commandPlan(home,target);await mkdir(join(home,'.local/bin'),{recursive:true});if(kind==='file')await writeFile(plan.link,'foreign');else await symlink('/foreign/ai',plan.link);
 await expect(installCommand(plan)).rejects.toThrow('already exists');await expect(uninstallCommand(plan)).rejects.toThrow('not this app');expect((await lstat(plan.link)).isSymbolicLink()).toBe(kind==='link');
}));
it.each(['.local','.local/bin'])('never follows a symlinked %s out of home',component=>withHome(async home=>{
 const outside=await mkdtemp(join(tmpdir(),'ai-outside-'));try{if(component.includes('/'))await mkdir(join(home,'.local'));await symlink(outside,join(home,component));
 await expect(installCommand(commandPlan(home,target))).rejects.toThrow('real directory');await expect(uninstallCommand(commandPlan(home,target))).rejects.toThrow('real directory');await expect(lstat(join(outside,'ai'))).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(outside,{recursive:true,force:true});}
}));
it('does not create directories during uninstall and rejects relative paths',()=>withHome(async home=>{
 await uninstallCommand(commandPlan(home,target));await expect(lstat(join(home,'.local'))).rejects.toMatchObject({code:'ENOENT'});expect(()=>commandPlan(home,'relative')).toThrow();
}));

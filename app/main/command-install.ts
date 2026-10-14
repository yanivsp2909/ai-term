import {isAbsolute,join} from 'node:path';
import {lstat,mkdir,readlink,symlink,unlink} from 'node:fs/promises';
import {isFsError} from '../../src/shared/paths.js';
export interface CommandPlan {home:string;link:string;target:string}
export function commandPlan(home:string,target:string):CommandPlan {
 if(!isAbsolute(home)||!isAbsolute(target)||/[\p{C}\p{Zl}\p{Zp}]/u.test(home+target)||!target.endsWith('/Contents/MacOS/ai'))throw new Error('Invalid command installation path');
 return {home,link:join(home,'.local/bin/ai'),target};
}
async function directory(path:string,create:boolean):Promise<boolean> {
 if(create){try{await mkdir(path,{mode:0o755});}catch(error){if(!isFsError(error,'EEXIST'))throw error;}}
 try{const stat=await lstat(path);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid?.())throw new Error('Command folder must be a real directory owned by you');return true;}
 catch(error){if(!create&&isFsError(error,'ENOENT'))return false;throw error;}
}
async function folders(plan:CommandPlan,create:boolean):Promise<boolean>{
 return await directory(plan.home,false)&&await directory(join(plan.home,'.local'),create)&&await directory(join(plan.home,'.local/bin'),create);
}
async function existing(plan:CommandPlan):Promise<'ours'|'foreign'|'absent'> {
 try{const stat=await lstat(plan.link);return stat.isSymbolicLink()&&await readlink(plan.link)===plan.target?'ours':'foreign';}
 catch(error){if(isFsError(error,'ENOENT'))return 'absent';throw error;}
}
export async function installCommand(plan:CommandPlan):Promise<void> {
 if(!await folders(plan,true))throw new Error('Home is unavailable');
 const state=await existing(plan);if(state==='ours')return;
 if(state==='foreign'){const stat=await lstat(plan.link);const description=stat.isSymbolicLink()?`symlink to ${await readlink(plan.link)}`:stat.isDirectory()?'directory':'file';throw new Error(`ai already exists at ${plan.link}: ${description}`);}
 // symlink creates exclusively; a racing foreign entry is never overwritten.
 await symlink(plan.target,plan.link);
}
export async function uninstallCommand(plan:CommandPlan):Promise<void> {
 if(!await folders(plan,false))return;const state=await existing(plan);
 if(state==='foreign')throw new Error(`ai at ${plan.link} is not this app's symlink`);
 if(state==='ours')await unlink(plan.link);
}

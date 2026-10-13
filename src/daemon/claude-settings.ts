import {createRequire} from 'node:module';
import {join} from 'node:path';
import {unlink,lstat} from 'node:fs/promises';
import {privateDirectory,isFsError} from '../shared/paths.js';
import {isUUID,isStatusCommandPath} from '../shared/validate.js';
import {atomicWrite} from './store.js';
export function buildClaudeSettings(port:number,node:string,entry:string,loader?:string){
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid status port');
 const hook={type:'http',url:`http://127.0.0.1:${port}/v1/status/claude`,headers:{'x-ai-term-session':'$AITERM_STATUS_TOKEN'},allowedEnvVars:['AITERM_STATUS_TOKEN'],timeout:2};
 const hooks=Object.fromEntries(['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','Notification','Stop','StopFailure','SessionEnd'].map(name=>[name,[{hooks:[hook]}]]));
 const source=entry.endsWith('.ts');
 return {hooks,...(isStatusCommandPath(node)&&isStatusCommandPath(entry)&&(!source||isStatusCommandPath(loader))?{statusLine:{type:'command',command:`${node} ${source?'--import '+loader+' ':''}${entry} status-line`}}:{})};
}
export async function writeClaudeSettings(root:string,id:string,port:number,node:string,entry:string):Promise<string>{
 if(!isUUID(id))throw new Error('Invalid session UUID');const sessions=join(root,'sessions'),directory=join(sessions,id);await privateDirectory(sessions);await privateDirectory(directory);
 const file=join(directory,'claude-settings.json');const loader=entry.endsWith('.ts')?createRequire(import.meta.url).resolve('tsx'):undefined;await atomicWrite(file,buildClaudeSettings(port,node,entry,loader));return file;
}
export async function removeClaudeSettings(root:string,id:string):Promise<void>{
 if(!isUUID(id))throw new Error('Invalid session UUID');
 for(const folder of [join(root,'sessions'),join(root,'sessions',id)]){
  let info;try{info=await lstat(folder);}catch(error){if(isFsError(error,'ENOENT'))return;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==process.getuid?.())throw new Error('Unsafe session settings directory');
 }
 try{await unlink(join(root,'sessions',id,'claude-settings.json'));}catch(error){if(!isFsError(error,'ENOENT'))throw error;}
}

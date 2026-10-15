import {createRequire} from 'node:module';
import {join} from 'node:path';
import {unlink,lstat} from 'node:fs/promises';
import {privateDirectory,isFsError} from '../shared/paths.js';
import {isUUID,isStatusCommandPath} from '../shared/validate.js';
import {atomicWrite} from './store.js';
import {sourceTsconfig,TSX_PIN} from './env.js';
import { ownedByMe } from '../shared/owner.js';
export function buildClaudeSettings(port:number,node:string,entry:string,loader?:string){
 if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid status port');
 const hook={type:'http',url:`http://127.0.0.1:${port}/v1/status/claude`,headers:{'x-ai-term-session':'$AITERM_STATUS_TOKEN'},allowedEnvVars:['AITERM_STATUS_TOKEN'],timeout:2};
 const hooks=Object.fromEntries(['UserPromptSubmit','PreToolUse','PostToolUse','PostToolUseFailure','PermissionRequest','Notification','Stop','StopFailure','SessionEnd'].map(name=>[name,[{hooks:[hook]}]]));
 const command=statusLineCommand(node,entry,loader);
 return {hooks,...(command?{statusLine:{type:'command',command}}:{})};
}
// The status line is a command string Claude runs through a shell, so only the strict path alphabet may enter it.
function statusLineCommand(node:string,entry:string,loader?:string):string|null{
 const source=entry.endsWith('.ts');
 const tsconfig=sourceTsconfig(entry);
 if(!isStatusCommandPath(node)||!isStatusCommandPath(entry)||source&&(!isStatusCommandPath(loader)||!isStatusCommandPath(tsconfig)))return null;
 // Source mode pins AI Term's tsconfig: Claude runs this in the project folder, whose tsconfig tsx would read otherwise.
 // The approved app name contains spaces. The validated alphabet excludes
 // quotes/metacharacters; quote whole arguments rather than splitting that name.
 const quote=(value:string):string=>value.includes(' ')?`'${value}'`:value;
 return `${source?`${TSX_PIN} ${quote('TSX_TSCONFIG_PATH='+tsconfig)} `:''}${quote(node)} ${source?'--import '+quote(loader??'')+' ':''}${quote(entry)} status-line`;
}
const tsxLoader=(entry:string)=>entry.endsWith('.ts')?createRequire(import.meta.url).resolve('tsx'):undefined;
// False when writeClaudeSettings leaves the status line (context %) off for this node and ai path.
export function claudeStatusLine(node:string,entry:string):boolean{return statusLineCommand(node,entry,tsxLoader(entry))!==null;}
export async function writeClaudeSettings(root:string,id:string,port:number,node:string,entry:string):Promise<string>{
 if(!isUUID(id))throw new Error('Invalid session UUID');const sessions=join(root,'sessions'),directory=join(sessions,id);await privateDirectory(sessions);await privateDirectory(directory);
 const file=join(directory,'claude-settings.json');await atomicWrite(file,buildClaudeSettings(port,node,entry,tsxLoader(entry)));return file;
}
export async function removeClaudeSettings(root:string,id:string):Promise<void>{
 if(!isUUID(id))throw new Error('Invalid session UUID');
 for(const folder of [join(root,'sessions'),join(root,'sessions',id)]){
  let info;try{info=await lstat(folder);}catch(error){if(isFsError(error,'ENOENT'))return;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||!ownedByMe(info))throw new Error('Unsafe session settings directory');
 }
 try{await unlink(join(root,'sessions',id,'claude-settings.json'));}catch(error){if(!isFsError(error,'ENOENT'))throw error;}
}

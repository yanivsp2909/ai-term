import { readdir } from 'node:fs/promises';
import { dirname, basename, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
export function folderPath(text:string,cwd:string):string {return resolve(cwd,text==='~'?homedir():text.startsWith('~/')?homedir()+text.slice(1):text||cwd);}
export async function completeFolder(text:string,cwd:string):Promise<string[]> {
 const path=folderPath(text,cwd),folder=text.endsWith(sep)?path:dirname(path),prefix=text.endsWith(sep)?'':basename(path);
 try{return (await readdir(folder,{withFileTypes:true})).filter(item=>item.isDirectory()&&item.name.startsWith(prefix)).map(item=>resolve(folder,item.name)+sep).sort();}
 catch(error){if(error instanceof Error&&'code' in error&&['ENOENT','ENOTDIR'].includes(String(error.code)))return [];throw error;}
}

import {createRequire} from 'node:module';
import {isAbsolute} from 'node:path';
export function electronLaunch(main:string,packaged?:string):{executablePath:string;args:string[]} {
 const binary:unknown=packaged??createRequire(import.meta.url)('electron');
 if(typeof binary!=='string'||!isAbsolute(binary))throw new Error('Electron executable must be absolute');
 // Playwright's implicit dev loader replaces app.whenReady. Use the normal
 // executable startup for both dev and packaged, including paired measurements.
 return{executablePath:binary,args:packaged?[]:[main]};
}

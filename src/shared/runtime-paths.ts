import {dirname,isAbsolute,join,resolve} from 'node:path';
export interface RuntimePaths {root:string;entry:string;node:string;command:string}
export function runtimePaths(main:string,packaged:boolean):RuntimePaths {
 if(!isAbsolute(main)||main.includes('\0'))throw new Error('Runtime module path must be absolute');
 const root=resolve(dirname(main),'../../..');
 if(packaged&&!root.endsWith('/Contents/Resources/app'))throw new Error('Invalid packaged runtime layout');
 const macos=resolve(root,'../../MacOS');
 return {root,entry:join(root,'dist/cli/index.js'),node:join(macos,'ai-node'),command:join(macos,'ai')};
}
export function configureCliRuntime(entry:string,processLike:{execPath:string}=process):void {
 // Every existing daemon/status/agent spawn uses execPath. This launcher sets
 // Electron Node mode again even when the agent's env allowlist strips it.
 if(entry.endsWith('/Contents/Resources/app/dist/cli/index.js'))processLike.execPath=resolve(dirname(entry),'../../../../MacOS/ai-node');
}
export function runtimeEnv(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 const env:NodeJS.ProcessEnv={...base,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_NO_ASAR;delete env.NAPI_RS_NATIVE_LIBRARY_PATH;return env;
}

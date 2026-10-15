import {dirname,isAbsolute,join,resolve} from 'node:path';
export interface RuntimePaths {root:string;entry:string;node:string;command:string}
// Linux and Windows (v0.8): electron-builder puts the app in resources/app; there is no ai-node launcher, so AI Term's own
// processes run on the Electron binary itself in Node mode (runtimeEnv sets ELECTRON_RUN_AS_NODE), and no ai command
// is installed from the app (command is empty).
export function runtimePaths(main:string,packaged:boolean,platform:NodeJS.Platform=process.platform,execPath:string=process.execPath):RuntimePaths {
 if(!isAbsolute(main)||main.includes('\0'))throw new Error('Runtime module path must be absolute');
 const root=resolve(dirname(main),'../../..');
 if(platform!=='darwin'){
  if(packaged&&!/[\\/]resources[\\/]app$/.test(root))throw new Error('Invalid packaged runtime layout');
  return {root,entry:join(root,'dist','cli','index.js'),node:execPath,command:''};
 }
 if(packaged&&!root.endsWith('/Contents/Resources/app'))throw new Error('Invalid packaged runtime layout');
 const macos=resolve(root,'../../MacOS');
 return {root,entry:join(root,'dist/cli/index.js'),node:join(macos,'ai-node'),command:join(macos,'ai')};
}
export function configureCliRuntime(entry:string,processLike:{execPath:string}=process):void {
 // Every existing daemon/status/agent spawn uses execPath. This launcher sets
 // Electron Node mode again even when the agent's env allowlist strips it.
 if(entry.endsWith('/Contents/Resources/app/dist/cli/index.js'))processLike.execPath=resolve(dirname(entry),'../../../../MacOS/ai-node');
}
// The launcher sets ELECTRON_RUN_AS_NODE for AI Term's own processes only. Children must not inherit it: any Electron app
// an agent starts (code, a project's electron .) would run as plain Node. Only a daemon that is itself the plain Electron
// binary (the dev app; the bundle pins ai-node, which sets the flag again) needs it for the status commands its agents run.
export function electronNodeNeeded(execPath:string,electronVersion:string|undefined):boolean {
 return electronVersion!==undefined&&!execPath.endsWith('/ai-node');
}
export function runtimeEnv(base:NodeJS.ProcessEnv):NodeJS.ProcessEnv {
 const env:NodeJS.ProcessEnv={...base,ELECTRON_RUN_AS_NODE:'1'};delete env.NODE_OPTIONS;delete env.NODE_PATH;delete env.ELECTRON_NO_ASAR;delete env.NAPI_RS_NATIVE_LIBRARY_PATH;return env;
}

import {expect,it} from 'vitest';
import {runtimePaths,configureCliRuntime,runtimeEnv} from '../src/shared/runtime-paths.js';
import {notifierAppPath} from '../src/daemon/notifier.js';
import {terminalCommandFile} from '../src/daemon/terminal-launch.js';
it('resolves development resources from the main module, never cwd or PATH',()=>{
 const paths=runtimePaths('/repo/app/out/main/index.js',false);
 expect(paths.root).toBe('/repo');expect(paths.entry).toBe('/repo/dist/cli/index.js');
 expect(()=>runtimePaths('app/out/main/index.js',false)).toThrow();
});
it('resolves packaged CLI, runtime and notifier inside the bundle',()=>{
 const paths=runtimePaths('/Applications/AI Term.app/Contents/Resources/app/app/out/main/index.js',true);
 expect(paths.entry).toBe('/Applications/AI Term.app/Contents/Resources/app/dist/cli/index.js');
 expect(paths.node).toBe('/Applications/AI Term.app/Contents/MacOS/ai-node');
 expect(paths.command).toBe('/Applications/AI Term.app/Contents/MacOS/ai');
 expect(notifierAppPath(paths.entry)).toBe(paths.root+'/build/notifier/AI Term.app');
 const processLike={execPath:'/system/node'};configureCliRuntime(paths.entry,processLike);expect(processLike.execPath).toBe(paths.node);
 configureCliRuntime('/repo/dist/cli/index.js',processLike);expect(processLike.execPath).toBe(paths.node);
});
it('internal Node env refuses caller loader injection and enables Electron Node mode',()=>{
 expect(runtimeEnv({HOME:'/temp',NODE_OPTIONS:'--import=/bad',NODE_PATH:'/bad',ELECTRON_NO_ASAR:'1'})).toEqual({HOME:'/temp',ELECTRON_RUN_AS_NODE:'1'});
});
it('quoted internal launch paths support the actual app name without accepting shell syntax',()=>{
 const entry='/Applications/AI Term.app/Contents/Resources/app/dist/cli/index.js';
 expect(terminalCommandFile({node:'/Applications/AI Term.app/Contents/MacOS/ai-node',entry},'550e8400-e29b-41d4-a716-446655440000')).toContain("'"+entry+"'");
 expect(()=>terminalCommandFile({node:"/bad/'node",entry},'550e8400-e29b-41d4-a716-446655440000')).toThrow();
});

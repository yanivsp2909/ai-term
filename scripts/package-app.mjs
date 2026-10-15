// A separate staging tree prevents packaging/rebuild tools from mutating the
// system-Node CLI dependencies. Both pinned native bindings use stable N-API.
import {build} from 'electron-builder';
import {appBuilderConfig} from './app-config.mjs';
import {cpSync,mkdirSync,readFileSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
const root=join(dirname(fileURLToPath(import.meta.url)),'..'),out=join(root,'build/desktop'),stage=join(out,'stage');
const info=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
function run(file,args){const result=spawnSync(file,args,{stdio:'inherit'});if(result.error||result.status!==0)throw new Error(`Packaging command failed: ${file}`);}
rmSync(stage,{recursive:true,force:true});mkdirSync(stage,{recursive:true});
for(const folder of ['app/out','dist','data'])cpSync(join(root,folder),join(stage,folder),{recursive:true});
const dependencies=Object.fromEntries(Object.entries(info.dependencies).filter(([name])=>!['electron','react-dom','@playwright/test','@xterm/xterm','@xterm/addon-fit','@xterm/addon-search','@xterm/addon-web-links','@xterm/addon-webgl'].includes(name)));
writeFileSync(join(stage,'package.json'),JSON.stringify({name:info.name,version:info.version,type:'module',main:info.main,description:'AI Term desktop terminal',author:'AI Term',dependencies},null,2));
symlinkSync(join(root,'node_modules'),join(stage,'node_modules'));
mkdirSync(join(out,'home'),{recursive:true});
process.env.HOME=join(out,'home');process.env.ELECTRON_BUILDER_CACHE=join(out,'cache');process.env.CSC_IDENTITY_AUTO_DISCOVERY='false';
// A local ad-hoc build must not discover certificates or publish/notarize just
// because the caller also has release credentials in their environment.
for(const name of ['CSC_LINK','CSC_KEY_PASSWORD','CSC_KEYCHAIN','CSC_NAME','APPLE_ID','APPLE_APP_SPECIFIC_PASSWORD','APPLE_TEAM_ID'])delete process.env[name];
const mac=process.platform==='darwin';
const config=appBuilderConfig({platform:process.platform,root,out,version:info.dependencies.electron.replace(/^[^0-9]+/,''),arch:process.arch});
// The ai launchers and the notification helper are macOS's; Linux and Windows packages carry the app alone.
await build({publish:'never',projectDir:stage,config:{...config,...(mac?{afterPack:async context=>{
 const bundle=join(context.appOutDir,'AI Term.app'),contents=join(bundle,'Contents'),resources=join(contents,'Resources/app');
 mkdirSync(join(resources,'build/notifier'),{recursive:true});symlinkSync('../../../../Helpers/AI Term.app',join(resources,'build/notifier/AI Term.app'));
 for(const command of ['ai','ai-node'])run('/usr/bin/xcrun',['clang','-O2','-Wall','-Wextra','-Werror',...(command==='ai'?['-DAI_COMMAND']:[]),join(root,'native/desktop/launcher.c'),'-o',join(contents,'MacOS',command)]);
 },afterSign:async context=>{const bundle=join(context.appOutDir,'AI Term.app');run('/usr/bin/codesign',['--verify','--deep','--strict','--verbose=2',bundle]);run('/usr/bin/codesign',['--verify','--strict','--verbose=2',join(bundle,'Contents/Helpers/AI Term.app')]);}}:{})}});
process.stdout.write(`Packaged app: ${join(out,'dist')}\n`);

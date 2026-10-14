import {mkdtemp,mkdir,writeFile,symlink,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';import {appCapture,measure} from './measure-app-latency.js';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..'),folder=await mkdtemp(join(tmpdir(),'ai-packaged-ab-'));
function run(file:string,args:string[],cwd:string):void{const result=spawnSync(file,args,{cwd,stdio:'ignore'});if(result.error||result.status!==0)throw new Error('A/B baseline build failed',{cause:result.error});}
try{
 const archive=spawnSync('/usr/bin/git',['archive','11362d1','src','app','data','docs/design.md','docs/design/tokens.json','package.json','tsconfig.json','tsup.config.ts'],{cwd:root,maxBuffer:20*1024*1024});
 if(archive.error||archive.status!==0)throw new Error('A/B checkpoint archive failed',{cause:archive.error});
 const tar=join(folder,'baseline.tar');await writeFile(tar,archive.stdout);run('/usr/bin/tar',['-xf',tar,'-C',folder],root);await symlink(join(root,'node_modules'),join(folder,'node_modules'));
 run(process.execPath,[join(root,'node_modules/tsup/dist/cli-default.js')],folder);
 run(process.execPath,[join(root,'node_modules/electron-vite/bin/electron-vite.js'),'build','--config','app/electron.vite.config.ts'],folder);
 const dev=await appCapture({main:join(folder,'app/out/main/index.js')});const devResult=await measure(dev.records,dev.cols,dev.rows);
 const bundle=join(root,`build/desktop/dist/mac-${process.arch}/AI Term.app/Contents/MacOS/AI Term`);
 const packaged=await appCapture({executablePath:bundle});const packagedResult=await measure(packaged.records,packaged.cols,packaged.rows);
 const difference=Math.round((packagedResult.p95-devResult.p95)*100)/100;
 const result={date:new Date().toISOString(),baselineCommit:'11362d1',currentCommit:runCommit(),method:'Normal Electron executable startup for both; same capture-phase keydown to expected command-bar cell + cursor output arrival, Unicode 11 offline; 50 warmup + 300 keys, 15/20/25 ms gaps, Ctrl+U every 60; dev first then packaged, serial on same host',limits:'Output arrival, not physical paint or Terminal.app latency. Gate only on same-session packaged minus checkpoint dev p95.',node:process.version,platform:process.platform,arch:process.arch,cols:dev.cols,rows:dev.rows,webgl:{dev:dev.webgl,packaged:packaged.webgl},dev:devResult,packaged:packagedResult,differenceP95:difference,allowedDifferenceP95:0.3,p95Gate:difference<=0.3};
 await mkdir(join(root,'docs/testing'),{recursive:true});await writeFile(join(root,'docs/testing/v0.5-packaged-latency.json'),JSON.stringify(result,null,2)+'\n');process.stdout.write(JSON.stringify(result,null,2)+'\n');if(!result.p95Gate)process.exitCode=1;
}finally{await rm(folder,{recursive:true,force:true});}
function runCommit():string{const result=spawnSync('/usr/bin/git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});if(result.status!==0)throw new Error('Cannot record A/B commit');return result.stdout.trim();}

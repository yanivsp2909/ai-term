import {_electron as electron,expect,test} from '@playwright/test';
import {execFile,spawn} from 'node:child_process';import {promisify} from 'node:util';
import {mkdtemp,mkdir,rm,writeFile,readFile,realpath} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve,dirname} from 'node:path';
import {Connection} from '../../src/client/connection.js';import {getPaths} from '../../src/shared/paths.js';
import {commandPlan,installCommand} from '../../app/main/command-install.js';
import {electronLaunch} from '../../scripts/electron-launch.js';
const run=promisify(execFile),packaged=process.env.AI_TERM_TEST_APP;
test('runtime loads N-API bindings without a system Node and command symlinks preserve argv',async()=>{
 const home=await mkdtemp(join(tmpdir(),'ai-bundle-runtime-'));
 try{
 const env={HOME:home,AI_TERM_HOME:join(home,'.ai-term'),PATH:home};
 if(packaged){
  const command=join(dirname(packaged),'ai'),node=join(dirname(packaged),'ai-node');
  await installCommand(commandPlan(home,command));
  expect((await run(join(home,'.local/bin/ai'),['--version'],{env,cwd:home})).stdout.trim()).toBe((JSON.parse(await readFile(resolve('package.json'),'utf8')) as {version:string}).version);
  const packageFile=resolve(dirname(packaged),'../Resources/app/package.json');
  const code="const r=require('node:module').createRequire(process.argv[1]); const root=require('node:path').dirname(process.argv[1]); for(const name of ['node-pty','@napi-rs/keyring'])if(!require('node:fs').realpathSync(r.resolve(name)).startsWith(root+'/'))throw new Error('Binding resolved outside bundle'); console.log(typeof r('node-pty').spawn,typeof r('@napi-rs/keyring').Entry)";
  expect((await run(node,['-e',code,packageFile],{env:{...env,NAPI_RS_NATIVE_LIBRARY_PATH:join(home,'foreign-binding.node')},cwd:home})).stdout.trim()).toBe('function function');
 }else expect((await run(process.execPath,[resolve('dist/cli/index.js'),'--version'],{env,cwd:home})).stdout.trim()).toBe((JSON.parse(await readFile(resolve('package.json'),'utf8')) as {version:string}).version);
 }finally{await rm(home,{recursive:true,force:true});}
});
test('window uses an existing protocol-compatible dev daemon without stopping its agents',async()=>{
 const home=await mkdtemp(join(tmpdir(),'ai-bundle-handoff-')),state=join(home,'.ai-term'),paths=getPaths(state);
 await mkdir(state,{mode:0o700});await writeFile(join(state,'settings.json'),JSON.stringify({theme:'graphite',notifications:false}));
 const env={HOME:home,AI_TERM_HOME:state,AI_TERM_APP_DATA:join(home,'electron'),PATH:'/usr/bin:/bin',SHELL:'/bin/sh',LANG:'en_US.UTF-8',AI_TERM_BACKGROUND:'1'};
 const daemon=spawn(process.execPath,[resolve('dist/cli/index.js'),'daemon'],{env,stdio:['ignore','ignore','pipe']});let startup='';daemon.stderr?.on('data',(data:Buffer)=>{startup+=data.toString();});const exited=new Promise<void>(r=>daemon.once('exit',()=>r()));
 let client:Connection|undefined,application:Awaited<ReturnType<typeof electron.launch>>|undefined;
 try{
  const deadline=Date.now()+5000;
  while(!client){try{client=await Connection.connect(paths,{entry:resolve('dist/cli/index.js'),autoStart:false});}catch(error){if(Date.now()>deadline||daemon.exitCode!==null){const log=await readFile(paths.log,'utf8').catch((e:unknown)=>{if(e instanceof Error&&'code'in e&&e.code==='ENOENT')return '';throw e;});throw new Error('Disposable dev daemon failed: '+startup+log,{cause:error});}await new Promise(r=>setTimeout(r,30));}}
  const original=(await client.request({kind:'sessions.create',engine:'shell',cwd:home,title:'agent before app'})).session;
  application=await electron.launch({...electronLaunch(resolve('app/out/main/index.js'),packaged),env});
  await application.evaluate(async({app})=>{await app.whenReady();});
  const page=await application.firstWindow();
  // Nothing is logged in, so the login popup opens over the agent list first (v1.2.0 Mac check): Esc closes it.
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('Connect a provider');await page.locator('.xterm-helper-textarea').focus();await page.keyboard.press('Escape');
  await expect(page.locator('.xterm-accessibility-tree')).toContainText('agent before app');
  expect((await client.request({kind:'hello',protocol:1,version:'test'})).daemonPid).toBe(daemon.pid);
  if(packaged){
   const connected=client;
   await application.evaluate(({BrowserWindow})=>{const contents=BrowserWindow.getAllWindows()[0]?.webContents;contents?.sendInputEvent({type:'keyDown',keyCode:'e',modifiers:['meta']});contents?.sendInputEvent({type:'keyUp',keyCode:'e',modifiers:['meta']});});
   await expect(page.locator('.xterm-accessibility-tree')).not.toContainText('Connect a provider');
   await page.locator('.xterm-helper-textarea').focus();await page.keyboard.type('/shell');await expect(page.locator('.xterm-accessibility-tree')).toContainText('/shell');await page.keyboard.press('Enter');
   // macOS canonicalizes /var to /private/var when it records a session folder.
   await expect.poll(async()=>((await connected.request({kind:'sessions.list'})).sessions??[]).find(session=>session.id!==original?.id)?.cwd).toBe(await realpath(home));
  }
  const appProcess=application.process();await application.close();application=undefined;
  expect({code:appProcess.exitCode,signal:appProcess.signalCode}).toEqual({code:0,signal:null});
  expect((await client.request({kind:'sessions.list'})).sessions).toHaveLength(packaged?2:1);
 }finally{if(application)await application.close();client?.close();daemon.kill('SIGTERM');await exited;await rm(home,{recursive:true,force:true});}
});

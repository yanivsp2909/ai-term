import {expect,it,vi} from 'vitest';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,symlinkSync,writeFileSync} from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:net';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {notifierAppPath,NOTIFIER_EXECUTABLE} from '../src/daemon/notifier.js';
const app=notifierAppPath(resolve('src/cli/index.ts')),binary=resolve(app,NOTIFIER_EXECUTABLE),built=existsSync(binary);
const session=randomUUID(),base=['--session',session,'--title','AI Term','--body','fix-login · waiting: permission'];
const replace=(name:string,value:string)=>base.map((part,i)=>base[i-1]===name?value:part);
// --check validates argv and exits before any notification code runs, so these cases never post or prompt.
function run(args:string[]){return spawnSync(binary,args,{encoding:'utf8',timeout:5000});}
it('the helper lives at one fixed path inside the repo, so its notification permission survives rebuilds',()=>{
 expect(app).toBe(resolve('build/notifier/AI Term.app'));expect(notifierAppPath(resolve('dist/cli/index.js'))).toBe(app);
});
it.skipIf(!built)('the built helper is the signed AI Term bundle',()=>{
 const plist=readFileSync(resolve(app,'Contents/Info.plist'),'utf8');
 for(const text of ['<string>local.aiterm.notifier</string>','<key>CFBundleName</key><string>AI Term</string>','<key>LSUIElement</key><true/>'])expect(plist).toContain(text);
 expect(spawnSync('/usr/bin/codesign',['--verify','--strict',app]).status).toBe(0);
});
it.skipIf(!built)('the helper accepts only its three fields within their caps and refuses everything else with a fixed error',()=>{
 // Unassigned code points pass: macOS's Unicode tables can lag Node's, and the daemon already strips them.
 for(const args of [base,replace('--title','x'.repeat(80)),replace('--body','😀'.repeat(200)),replace('--body','a\u0378b')]){const result=run([...args,'--check']);expect(result.status).toBe(0);expect(result.stderr).toBe('');}
 const invalid=[
  replace('--session','AITERMCANARY'),replace('--session','-bad'),replace('--title','x'.repeat(81)),replace('--title','😀'.repeat(81)),
  replace('--body','x'.repeat(201)),replace('--title',''),replace('--body','AITERMCANARY\n'),replace('--title','\u202eAITERMCANARY'),replace('--body','AITERMCANARY\u0007'),
  // The same characters the daemon removes from names: separators, private use and unassigned code points.
  replace('--body','a\u2028b'),replace('--body','a\u2029b'),replace('--body','a\ue000b'),replace('--title','a\u{10FFFD}b'),
  [...base,'--unknown'],[...base,'--session',session],[...base,'--check'],[...base,'--body'],base.slice(0,4),
  // The spike's click and lifetime flags are gone from the product helper.
  [...base,'--socket','/tmp/click.sock'],[...base,'--temp-dir','/tmp'],[...base,'--lifetime','10'],[...base,'--probe-click'],[...base,'--exit-after-post'],
 ];
 for(const args of invalid){const result=run([...args,'--check']);expect(result.status).toBe(2);expect(result.stderr).toBe('Invalid notifier arguments\n');expect(result.stdout).toBe('');}
});
it.skipIf(!built)('a cold launch with no argv and no click (as when opened by hand) waits briefly for a click, then exits with the fixed error',()=>{
 const started=Date.now(),result=spawnSync(binary,[],{encoding:'utf8',timeout:10000});
 expect(result.status).toBe(2);expect(result.stderr).toBe('Invalid notifier arguments\n');
 // macOS delivers a cold click while the app finishes launching; three seconds is the bounded wait for it.
 expect(Date.now()-started).toBeGreaterThanOrEqual(2900);expect(Date.now()-started).toBeLessThan(6000);
},10000);
it.skipIf(process.platform!=='darwin')('macOS (the helper is macOS only; elsewhere the build says so and skips): without a Swift compiler the build prints a fixed message, builds nothing and leaves AI Term working',()=>{
 const result=spawnSync(process.execPath,['scripts/build-notifier.mjs'],{encoding:'utf8',timeout:10000,env:{PATH:'/usr/bin:/bin',HOME:process.env.HOME??'/tmp',DEVELOPER_DIR:'/nonexistent-ai-term-toolchain'}});
 expect(result.status).toBe(1);
 expect(result.stdout+result.stderr).toBe('Notifier not built: swiftc not found (install the Xcode Command Line Tools). AI Term works without notifications.\n');
});
it('a build assembles and signs the whole bundle aside, then swaps it in whole at the fixed path',()=>{
 const source=readFileSync(resolve('scripts/build-notifier.mjs'),'utf8');
 // Signing happens on the staged bundle, before anything replaces the working helper.
 expect(source.indexOf("'--verify'")).toBeLessThan(source.indexOf('renameSync(staged, app)'));
 expect(source).not.toContain('renameSync(fresh, binary)');
});
it.skipIf(!built)('--status prints one authorization word with exit zero and no permission prompt',()=>{
 const result=run(['--status']);expect(result.status).toBe(0);expect(result.stdout).toMatch(/^(allowed|denied|not-asked|unknown)\n$/);expect(result.stderr).toBe('');
});
// Click route: the helper sends {"clicked":"<uuid>"} to <AI_TERM_HOME>/run/click.sock. --click runs the same code the
// notification delegate runs on a click, so these cases need no banner. A temp home stands in for ~/.ai-term.
interface ClickHome {root:string;run:string;socket:string;received:()=>string;close:()=>Promise<void>}
async function clickHome(listen=true):Promise<ClickHome>{
 const base=realpathSync(mkdtempSync(join(tmpdir(),'ai-click-'))),root=join(base,'home'),run=join(root,'run'),socket=join(run,'click.sock');
 mkdirSync(run,{recursive:true,mode:0o700});chmodSync(root,0o700);chmodSync(run,0o700);
 let data='';const server=createServer(connection=>{connection.setEncoding('utf8');connection.on('data',(chunk:string)=>{data+=chunk;});});
 if(listen){await new Promise<void>(done=>server.listen(socket,done));chmodSync(socket,0o600);}
 return {root,run,socket,received:()=>data,close:async()=>{if(listen)await new Promise<void>(done=>server.close(()=>done()));rmSync(base,{recursive:true,force:true});}};
}
// Asynchronous, so the in-process listener can accept while the helper runs.
function click(args:string[],home:string):Promise<{status:number|null;stderr:string;stdout:string}>{
 return new Promise(done=>{const child=spawn(binary,args,{env:{PATH:'/usr/bin:/bin',AI_TERM_HOME:home}});let stderr='',stdout='';child.stderr.on('data',(c:Buffer)=>{stderr+=c.toString();});child.stdout.on('data',(c:Buffer)=>{stdout+=c.toString();});
  const timer=setTimeout(()=>child.kill('SIGKILL'),8000);child.on('close',status=>{clearTimeout(timer);done({status,stderr,stdout});});});
}
it.skipIf(!built)('a click sends only {"clicked":"<uuid>"} and a newline to the fixed private socket',async()=>{
 const home=await clickHome(),id=randomUUID();
 try{
  const result=await click(['--click',id.toUpperCase()],home.root);
  expect(result).toEqual({status:0,stderr:'',stdout:''});
  await vi.waitFor(()=>expect(home.received()).toBe(`{"clicked":"${id}"}\n`));
 }finally{await home.close();}
});
it.skipIf(!built)('a click with a bad UUID or extra arguments is refused before any socket is touched',async()=>{
 const home=await clickHome();
 try{
  for(const args of [['--click','AITERMCANARY'],['--click',randomUUID()+'0'],['--click'],['--click',randomUUID(),'--check'],['--click',randomUUID(),'--click',randomUUID()],[...base,'--click',randomUUID()]]){
   const result=await click(args,home.root);expect(result.status).toBe(2);expect(result.stderr).toBe('Invalid notifier arguments\n');
  }
  expect(home.received()).toBe('');
 }finally{await home.close();}
});
it.skipIf(!built)('the click is refused with fixed text when the private directory or socket is not private',async()=>{
 const cases:[string,(home:ClickHome)=>string][]=[
  ['symlinked home',home=>{const link=home.root+'-link';symlinkSync(home.root,link);return link;}],
  ['symlinked run directory',home=>{renameSync(home.run,home.run+'-real');symlinkSync(home.run+'-real',home.run);return home.root;}],
  ['shared home',home=>{chmodSync(home.root,0o755);return home.root;}],
  ['shared run directory',home=>{chmodSync(home.run,0o750);return home.root;}],
  ['shared socket',home=>{chmodSync(home.socket,0o666);return home.root;}],
  ['socket replaced by a file',home=>{rmSync(home.socket);writeFileSync(home.socket,'',{mode:0o600});return home.root;}],
  ['relative home',()=>'relative/home'],
 ];
 for(const [name,prepare] of cases){
  const home=await clickHome();
  try{const result=await click(['--click',randomUUID()],prepare(home));expect({name,status:result.status,stderr:result.stderr}).toEqual({name,status:1,stderr:'Click socket unsafe\n'});expect(home.received()).toBe('');}
  finally{await home.close();}
 }
});
it.skipIf(!built)('a missing or dead socket fails fast with fixed text',async()=>{
 const missing=await clickHome(false);
 try{const started=Date.now(),result=await click(['--click',randomUUID()],missing.root);expect(result.status).toBe(1);expect(result.stderr).toBe('Click socket unavailable\n');expect(Date.now()-started).toBeLessThan(3000);}
 finally{await missing.close();}
 const dead=await clickHome(false);
 try{
  // A stale socket file nobody listens on: connect is refused. libuv unlinks a closing server's path, so the file is
  // moved aside while the server closes and then put back.
  const stale=createServer(),path=dead.socket;await new Promise<void>(done=>stale.listen(path,done));chmodSync(path,0o600);
  renameSync(path,path+'.keep');await new Promise<void>(done=>stale.close(()=>done()));renameSync(path+'.keep',path);
  const result=await click(['--click',randomUUID()],dead.root);expect(result.status).toBe(1);expect(result.stderr).toBe('Click socket unavailable\n');
 }finally{await dead.close();}
});
it.skipIf(!built)('the notification carries the session id for the click, and the delegate is set before launch finishes',()=>{
 const source=readFileSync(resolve('native/notifier/Notifier.swift'),'utf8');
 expect(source).toContain('content.userInfo = ["session": arguments.sessionID]');
 // The delegate must be in place before app.run(): a cold click is delivered while the app finishes launching.
 expect(source.indexOf('UNUserNotificationCenter.current().delegate = delegate')).toBeLessThan(source.indexOf('withExtendedLifetime(delegate) { app.run() }'));
 expect(source).toContain('UNNotificationDefaultActionIdentifier');
});

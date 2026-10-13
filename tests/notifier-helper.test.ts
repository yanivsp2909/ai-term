import {expect,it} from 'vitest';
import {existsSync,readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {resolve} from 'node:path';
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
it.skipIf(!built)('a cold launch with no argv (as macOS does after a click) exits at once with the fixed error',()=>{
 const started=Date.now(),result=run([]);
 expect(result.status).toBe(2);expect(result.stderr).toBe('Invalid notifier arguments\n');expect(Date.now()-started).toBeLessThan(3000);
});
it('without a Swift compiler the build prints a fixed message, builds nothing and leaves AI Term working',()=>{
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

// Product-path counterpart to the spike: disposable daemon, Unix socket, attach client and outer PTY.
import { spawn } from 'node:child_process';
import { mkdtemp,writeFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve,join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { getPaths,preparePaths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { useUnicode11 } from '../src/shared/unicode-width.js';
const root=resolve('.'),entry=resolve('src/cli/index.ts'),self=resolve('scripts/measure-bar.ts');
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const env=(home:string)=>({PATH:'/usr/bin:/bin',HOME:home,SHELL:'/bin/sh',AI_TERM_HOME:home,TERM:'xterm-256color',LANG:'en_US.UTF-8'});
if(process.argv[2]==='daemon'){
 const home=process.argv[3]??'',program=process.argv[4],bar=process.argv[5]==='on'?'on':'off';const paths=getPaths(home);await preparePaths(paths);
 await new SettingsStore(home).set({bar});const file=join(home,'latency.txt');await writeFile(file,'latency\n');
 const recipe=program==='echo'?{executable:process.execPath,args:[resolve('tests/fixtures/latency-echo.mjs')],env:env(home)}:{executable:'/usr/bin/vim',args:['-Nu','NONE','-i','NONE','-n','-c','set ruler',file],env:env(home)};
 const log=new Logger(paths.log),manager=new SessionManager(paths,log,recipe),server=new DaemonServer(paths,manager,log);
 await manager.load();const session=await manager.create({engine:'shell',cwd:home,title:'latency test'});await server.listen();process.stdout.write(JSON.stringify({id:session.id})+'\n');
 process.once('SIGTERM',()=>{void (async()=>{await server.close();await manager.shutdown();process.exit(0);})();});
}else{
 const keys=Number(process.argv[2]??500),results:Record<string,unknown>[]=[];
 for(const round of [1,2])for(const program of ['echo','vim'])for(const bar of round===1?['off','on']:['on','off']){
  const home=await mkdtemp(join(tmpdir(),'ai-bar-latency-'));let child:pty.IPty|undefined,connection:Connection|undefined;let stopped=false;
  const daemon=spawn(process.execPath,['--import','tsx',self,'daemon',home,program,bar],{cwd:root,env:env(home),stdio:['ignore','pipe','pipe']});const daemonExit=new Promise(r=>daemon.once('exit',r));let errors='';daemon.stderr.on('data',d=>{errors+=String(d);});
  const terminal=new headless.Terminal({cols:120,rows:40,scrollback:0,allowProposedApi:true});useUnicode11(terminal);let raw='',parse=Promise.resolve(),probe=false;
  try{
   const id=await new Promise<string>((ok,fail)=>{const timeout=setTimeout(()=>fail(new Error('Daemon startup timeout '+errors)),5000);let text='';daemon.stdout.on('data',d=>{text+=String(d);if(text.includes('\n')){clearTimeout(timeout);ok((JSON.parse(text.trim()) as {id:string}).id);}});});
   connection=await Connection.connect(getPaths(home),{entry,autoStart:false});
   child=pty.spawn(process.execPath,['--import','tsx',entry,'debug','attach',id],{cols:120,rows:40,name:'xterm-256color',cwd:root,env:env(home)});child.onExit(()=>{stopped=true;});
   terminal.onData(data=>{if(data.includes('c'))probe=true;if(!stopped)child?.write(data);});
   let pending:{row:number;col:number;key:string;start:number;resolve:(value:number)=>void}|undefined;
   child.onData(data=>{const arrived=performance.now();raw+=data;parse=parse.then(()=>new Promise<void>(done=>terminal.write(data,()=>{
    const expected=pending;
    if(expected){const buffer=terminal.buffer.active,cell=buffer.getLine(buffer.viewportY+expected.row)?.getCell(expected.col);
     if(cell?.getChars()===expected.key&&buffer.cursorX===expected.col+1&&buffer.cursorY===expected.row){pending=undefined;expected.resolve(arrived-expected.start);}}
    done();
   })));});
   const deadline=performance.now()+5000;
   const visible=()=>Array.from({length:40},(_,y)=>terminal.buffer.active.getLine(terminal.buffer.active.viewportY+y)?.translateToString(true)??'').join('\n');
   while(!visible().includes(program==='echo'?'ECHO_READY':'latency')){if(stopped||performance.now()>deadline)throw new Error('Agent readiness failed '+errors+' '+raw.slice(-500));await sleep(20);}
   await sleep(350);await parse;
   const snapshot=await connection.request({kind:'sessions.preview',sessionId:id});
   if(snapshot.cols!==120||snapshot.rows!==(bar==='on'?39:40)||bar==='on'&&!probe)throw new Error('Redraw gate silently fell back or size wrong');
   if(program==='vim'){child.write('i');await sleep(350);await parse;}
   const alphabet='bdfgjkqwxyz',samples:number[]=[];let measured=0;
   for(let i=0;i<keys+50;i++){
    if(i>0&&i%70===0){child.write('\r\n'.slice(0,program==='vim'?1:2));await sleep(100);await parse;}
    await parse;const buffer=terminal.buffer.active,key=alphabet[i%alphabet.length]??'x';
    const value=await new Promise<number>((ok,fail)=>{
     const timeout=setTimeout(()=>{pending=undefined;fail(new Error('Echo timeout '+program+' '+bar+' '+i));},1000);
     pending={row:buffer.cursorY,col:buffer.cursorX,key,start:performance.now(),resolve:value=>{clearTimeout(timeout);ok(value);}};child?.write(key);
    });
    if(i>=50){samples.push(value);measured++;}await sleep(15+(i%3)*5);
   }
   samples.sort((a,b)=>a-b);const p=(n:number)=>Math.round((samples[Math.floor(samples.length*n)]??0)*100)/100;
   const result={round,program,bar,measured,timeouts:0,cols:120,rows:snapshot.rows,p50:p(.5),p95:p(.95),p99:p(.99),max:samples.at(-1)};results.push(result);process.stdout.write(JSON.stringify(result)+'\n');
   child.write('\x05');await sleep(100);
  }finally{connection?.close();if(child&&!stopped)child.kill();terminal.dispose();daemon.kill('SIGTERM');await daemonExit;await rm(home,{recursive:true,force:true});}
 }
 await writeFile(resolve('docs/testing/v0.2.6-bar-latency.json'),JSON.stringify({method:`outer PTY write to arrival of chunk establishing expected body cell and cursor, actual daemon/socket/configured attach; 50 warmup, ${keys} keys, 15/20/25 ms gaps`,results},null,2)+'\n');
}

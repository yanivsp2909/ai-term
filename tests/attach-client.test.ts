import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Logger } from '../src/daemon/log.js';
import { attach, type AttachTTY } from '../src/client/attach.js';
import { enterModes, RESET_MODES } from '../src/client/terminal-modes.js';
import { Mirror } from '../src/daemon/mirror.js';
import { DaemonRequestError, type RequestBody } from '../src/client/connection.js';
const id=randomUUID();
class FakeTTY extends EventEmitter implements AttachTTY {
 isTTY=true;columns=80;rows=24;isRaw=false;output='';setRawMode(raw:boolean){this.isRaw=raw;}resume(){}pause(){}write(data:string|Buffer){this.output+=data.toString();return true;}
}
class FakeConnection extends EventEmitter {
 inputBytes:Buffer[]=[];requests:RequestBody[]=[];
 async request(body:RequestBody){this.requests.push(body);return {id:randomUUID(),ok:true as const,snapshot:'SNAPSHOT',cols:80,rows:24,modes:{applicationCursorKeys:true,applicationKeypad:false,bracketedPaste:true,mouseTracking:'drag' as const,mouseEncoding:'sgr' as const,focusEvents:true,cursorVisible:false}};}
 input(_id:string,data:Buffer){this.inputBytes.push(data);}
}
function fixture(){const tty=new FakeTTY(),connection=new FakeConnection(),signals=new EventEmitter();return {tty,connection,signals,options:{stdin:tty,stdout:tty,signals}};}
it('restores modes from a mirror and resets every session input mode on leaving',async()=>{
 const mirror=new Mirror(80,24,()=>{});try{
 await mirror.write('\x1b[?1h\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?25l');
 const modes=enterModes(mirror.modes());for(const seq of ['\x1b[?1h','\x1b[?2004h','\x1b[?1002h','\x1b[?1006h','\x1b[?1004h','\x1b[?25l'])expect(modes).toContain(seq);
 for(const code of [1000,1002,1003,1006,1015,2004,1004,1])expect(RESET_MODES).toContain(`\x1b[?${code}l`);expect(RESET_MODES).toContain('\x1b[<u');expect(RESET_MODES).toContain('\x1b[?25h');
 }finally{mirror.dispose();}
});
it('mode restore round trips every mouse tracking and encoding combination',async()=>{
 for(const mouseTracking of ['none','x10','vt200','drag','any'] as const)for(const mouseEncoding of ['default','utf8','sgr','urxvt'] as const){
  const modes={applicationCursorKeys:true,applicationKeypad:true,bracketedPaste:true,mouseTracking,mouseEncoding,focusEvents:true,cursorVisible:false};
  const mirror=new Mirror(80,24,()=>{});try{await mirror.write(enterModes(modes));expect(mirror.modes()).toEqual(modes);}finally{mirror.dispose();}
 }
});
it('writes snapshot first, streams only target output, sends input, and never forwards Ctrl+E',async()=>{
 const {tty,connection,options}=fixture();const done=attach(connection,id,options);await Promise.resolve();await Promise.resolve();
 connection.emit('output',randomUUID(),Buffer.from('OTHER_SESSION'));connection.emit('output',id,Buffer.from('live'));tty.emit('data',Buffer.from('echo hi\r'));tty.emit('data',Buffer.from([5]));connection.emit('output',id,Buffer.from('AFTER_HOME'));
 await done;expect(tty.output).toContain('SNAPSHOT');expect(tty.output.indexOf('SNAPSHOT')).toBeLessThan(tty.output.indexOf('live'));expect(tty.output).not.toContain('OTHER_SESSION');expect(tty.output).not.toContain('AFTER_HOME');expect(Buffer.concat(connection.inputBytes)).toEqual(Buffer.from('echo hi\r'));expect(connection.requests).toContainEqual({kind:'sessions.detach',sessionId:id});expect(tty.isRaw).toBe(false);expect(tty.output).toContain('\x1b[?1049l');
});
it('ignores terminal startup noise and live lifecycle events until a real home key',async()=>{
 const {tty,connection,options}=fixture();let returned=false;
 const done=attach(connection,id,options).then(reason=>{returned=true;return reason;});
 const noise=Buffer.from('\x1b[?1;2c\x1b[>0;276;0c\x1b[1;1R\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?0u\x1b[I\x1b[O\x1b[?2004h\x1b=');
 tty.emit('data',noise.subarray(0,18));await Promise.resolve();await Promise.resolve();tty.emit('data',noise.subarray(18));
 connection.emit('event',{kind:'session.updated',session:{id,status:'running',exitCode:null}});
 connection.emit('output',id,Buffer.from('\x1b[0m\x1b[?25h'));
 await new Promise(r=>setTimeout(r,40));expect(returned).toBe(false);expect(tty.isRaw).toBe(true);
 tty.emit('data',Buffer.from([5]));expect(await done).toBe('home key');
});
it('reports an already exited session instead of an unexplained home return',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);
 connection.request=async body=>{const result=await real(body);if(body.kind!=='sessions.attach')return result;return {...result,session:{id,title:'shell',engine:'shell',cwd:'/tmp',status:'exited',exitCode:0}} as unknown as Awaited<ReturnType<FakeConnection['request']>>;};
 expect(await attach(connection,id,options)).toBe('session exited');expect(tty.output).toContain('[session exited with code 0]');
});
it('reports rejected attach as failure and does not render a session snapshot',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);
 connection.request=body=>body.kind==='sessions.attach'?Promise.reject(new DaemonRequestError('Session operation failed')):real(body);
 await expect(attach(connection,id,options)).rejects.toMatchObject({reason:'attach rejected'});expect(tty.output).not.toContain('SNAPSHOT');expect(tty.isRaw).toBe(false);
});
it('reports an attach request timeout as an error rather than a daemon rejection',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);
 connection.request=body=>body.kind==='sessions.attach'?Promise.reject(new Error('Daemon request timed out')):real(body);
 await expect(attach(connection,id,options)).rejects.toMatchObject({reason:'error'});expect(tty.isRaw).toBe(false);
});
it('debug logging captures at most 64 input bytes as hex and records the actual reason',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-attach-debug-'));
 try{
 const {tty,connection,options}=fixture(),path=join(root,'daemon.log');
 const done=attach(connection,id,{...options,debugLog:new Logger(path)});await Promise.resolve();await Promise.resolve();
 const input=Buffer.from('generated-input-'.repeat(8));tty.emit('data',input);tty.emit('data',Buffer.from([5]));expect(await done).toBe('home key');
 const log=await readFile(path,'utf8');expect(log).toContain(`inputHex=${input.subarray(0,64).toString('hex')}`);expect(log).not.toContain('generated-input');expect(log).toContain('reason=home key');
 expect(log.match(/inputHex=([a-f0-9]*)/)?.[1]).toHaveLength(128);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('reports non-TTY stdin without changing terminal modes',async()=>{
 const {tty,connection,options}=fixture();tty.isTTY=false;
 await expect(attach(connection,id,options)).rejects.toMatchObject({reason:'stdin not a TTY'});expect(tty.output).toBe('');expect(tty.isRaw).toBe(false);
});
it('does not turn an early exit followed by a rejected attach into a successful return',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);
 connection.request=async body=>{if(body.kind!=='sessions.attach')return real(body);connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:0}});throw new DaemonRequestError('Attach rejected after exit');};
 await expect(attach(connection,id,options)).rejects.toMatchObject({reason:'attach rejected'});expect(tty.output).not.toContain('SNAPSHOT');expect(tty.isRaw).toBe(false);
});
it.each(['exit','disconnect','uncaught','takeover','home','SIGTERM','SIGHUP','SIGQUIT'] as const)('restores all terminal modes, title, palette and cursor after %s',async(reason)=>{
 const {tty,connection,signals,options}=fixture();const done=attach(connection,id,options);const outcome=done.catch(error=>error);await Promise.resolve();await Promise.resolve();
 if(reason==='exit')connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:0}});
 if(reason==='disconnect')connection.emit('disconnected');
 if(reason==='uncaught')signals.emit('uncaughtException',new Error('forced uncaught failure'));
 if(reason==='takeover')connection.emit('event',{kind:'session.detached',sessionId:id,reason:'attached elsewhere'});
 if(reason==='home')tty.emit('data',Buffer.from([5]));
 if(reason==='SIGTERM'||reason==='SIGHUP'||reason==='SIGQUIT')signals.emit(reason);
 const result=await outcome;
 if(reason==='disconnect')expect(result).toMatchObject({reason:'daemon gone'});
 if(reason==='uncaught')expect(result).toMatchObject({reason:'error'});
 if(reason==='takeover')expect(result).toBe('attached elsewhere');
 if(reason==='exit')expect(result).toBe('session exited');
 expect(tty.isRaw).toBe(false);expect(tty.output).toContain(RESET_MODES);expect(tty.output).toContain('\x1b[?1049l');if(reason==='exit')expect(tty.output).toContain('[session exited with code 0]');expect(signals.listenerCount('uncaughtException')).toBe(0);
 for(const bytes of ['\x1b]0;\x1b\\','\x1b]104\x1b\\','\x1b]110\x1b\\','\x1b]111\x1b\\','\x1b]112\x1b\\','\x1b[0 q','\x1b[?1007l'])expect(tty.output).toContain(bytes);
 expect(connection.requests).toContainEqual({kind:'sessions.detach',sessionId:id});expect(connection.requests.some(r=>r.kind==='sessions.stop')).toBe(false);
});
it('Ctrl+C cancels startup but belongs to the agent after attach completes',async()=>{
 const {tty,connection,options}=fixture();const done=attach(connection,id,options);tty.emit('data',Buffer.from([3]));await done;expect(connection.inputBytes).toHaveLength(0);expect(tty.isRaw).toBe(false);
 const next=fixture(),running=attach(next.connection,id,next.options);await Promise.resolve();await Promise.resolve();next.tty.emit('data',Buffer.from([3]));next.tty.emit('data',Buffer.from([5]));await running;expect(Buffer.concat(next.connection.inputBytes)).toEqual(Buffer.from([3]));
});
it('retains SGR mouse encoding when an unrelated encoding is reset',async()=>{
 const mirror=new Mirror(80,24,()=>{});try{await mirror.write('\x1b[?1006h\x1b[?1015l');expect(mirror.modes().mouseEncoding).toBe('sgr');}finally{mirror.dispose();}
});
it('restores locally immediately when startup request stays pending',async()=>{
 const {tty,connection,signals,options}=fixture();let release:(value:Awaited<ReturnType<FakeConnection['request']>>)=>void=()=>{};const real=connection.request.bind(connection);
 const pending=new Promise<Awaited<ReturnType<FakeConnection['request']>>>(r=>{release=r;});connection.request=body=>body.kind==='sessions.attach'?pending:real(body);
 const done=attach(connection,id,options);signals.emit('SIGINT');await new Promise(r=>setTimeout(r,0));
 try{expect(tty.isRaw).toBe(false);expect(tty.output).toContain('\x1b[?1049l');}finally{release(await real({kind:'sessions.attach',sessionId:id,cols:80,rows:24}));await done;}
});
it('preserves final snapshot and output when exit arrives in the attach response read',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);connection.request=async body=>{
 const result=await real(body);if(body.kind==='sessions.attach'){connection.emit('output',id,Buffer.from('FINAL_OUTPUT'));connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:0}});}return result;
 };
 await attach(connection,id,options);expect(tty.output).toContain('SNAPSHOT');expect(tty.output).toContain('FINAL_OUTPUT');expect(tty.output).toContain('[session exited with code 0]');
});
it('rejects an untrusted exitCode before printing a post-attach status line',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);connection.request=async body=>{const result=await real(body);if(body.kind!=='sessions.attach')return result;return {...result,session:{id,title:'shell',engine:'shell',cwd:'/tmp',status:'exited',exitCode:'\x1b]52;c;BAD\x07'}} as unknown as Awaited<ReturnType<FakeConnection['request']>>;};
 await expect(attach(connection,id,options)).rejects.toThrow('Invalid session exit code');expect(tty.output).not.toContain('BAD');expect(tty.isRaw).toBe(false);
});
it('rejects malformed lifecycle exit codes without waiting for startup or writing status bytes',async()=>{
 const {tty,connection,options}=fixture();const real=connection.request.bind(connection);
 connection.request=body=>body.kind==='sessions.attach'?new Promise(()=>{}):real(body);
 const done=attach(connection,id,options);
 connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:'\x1b]52;c;BAD\x07'}});
 await expect(done).rejects.toThrow('Invalid session exit code');expect(tty.isRaw).toBe(false);expect(tty.output).not.toContain('BAD');expect(tty.output).not.toContain('SNAPSHOT');
});
it('does not render startup output after cancellation even if an exit event follows it',async()=>{
 const {tty,connection,signals,options}=fixture();const real=connection.request.bind(connection);
 connection.request=async body=>{
 const result=await real(body);if(body.kind==='sessions.attach'){signals.emit('SIGINT');connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:0}});}return result;
 };
 await attach(connection,id,options);expect(tty.output).not.toContain('SNAPSHOT');expect(tty.output).not.toContain('[session exited');expect(tty.isRaw).toBe(false);
});

import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { attach, type AttachTTY } from '../src/client/attach.js';
import { enterModes, RESET_MODES } from '../src/client/terminal-modes.js';
import { Mirror } from '../src/daemon/mirror.js';
import type { RequestBody } from '../src/client/connection.js';
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
it('writes snapshot first, streams only target output, sends input, and never forwards Ctrl+E',async()=>{
 const {tty,connection,options}=fixture();const done=attach(connection,id,options);await Promise.resolve();await Promise.resolve();
 connection.emit('output',randomUUID(),Buffer.from('OTHER_SESSION'));connection.emit('output',id,Buffer.from('live'));tty.emit('data',Buffer.from('echo hi\r'));tty.emit('data',Buffer.from([5]));connection.emit('output',id,Buffer.from('AFTER_HOME'));
 await done;expect(tty.output).toContain('SNAPSHOT');expect(tty.output.indexOf('SNAPSHOT')).toBeLessThan(tty.output.indexOf('live'));expect(tty.output).not.toContain('OTHER_SESSION');expect(tty.output).not.toContain('AFTER_HOME');expect(Buffer.concat(connection.inputBytes)).toEqual(Buffer.from('echo hi\r'));expect(connection.requests).toContainEqual({kind:'sessions.detach',sessionId:id});expect(tty.isRaw).toBe(false);expect(tty.output).toContain('\x1b[?1049l');
});
it.each(['exit','disconnect','uncaught','takeover'] as const)('restores raw/alternate modes after %s',async(reason)=>{
 const {tty,connection,signals,options}=fixture();const done=attach(connection,id,options);const outcome=done.catch(error=>error);await Promise.resolve();await Promise.resolve();
 if(reason==='exit')connection.emit('event',{kind:'session.updated',session:{id,status:'exited',exitCode:0}});
 if(reason==='disconnect')connection.emit('disconnected');
 if(reason==='uncaught')signals.emit('uncaughtException',new Error('forced uncaught failure'));
 if(reason==='takeover')connection.emit('event',{kind:'session.detached',sessionId:id,reason:'attached elsewhere'});
 await outcome;expect(tty.isRaw).toBe(false);expect(tty.output).toContain(RESET_MODES);expect(tty.output).toContain('\x1b[?1049l');if(reason==='exit')expect(tty.output).toContain('[session exited with code 0]');expect(signals.listenerCount('uncaughtException')).toBe(0);
});
it('Ctrl+C cancels startup but belongs to the agent after attach completes',async()=>{
 const {tty,connection,options}=fixture();const done=attach(connection,id,options);tty.emit('data',Buffer.from([3]));await done;expect(connection.inputBytes).toHaveLength(0);expect(tty.isRaw).toBe(false);
 const next=fixture(),running=attach(next.connection,id,next.options);await Promise.resolve();await Promise.resolve();next.tty.emit('data',Buffer.from([3]));next.tty.emit('data',Buffer.from([5]));await running;expect(Buffer.concat(next.connection.inputBytes)).toEqual(Buffer.from([3]));
});

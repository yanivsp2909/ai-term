import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { expect,it } from 'vitest';
import { attach,type AttachTTY } from '../src/client/attach.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse,SessionInfo } from '../src/shared/protocol.js';
const id=randomUUID();
const session={id,title:'bar agent',engine:'shell',cwd:'/tmp',status:'running',model:null} as SessionInfo;
class TTY extends EventEmitter implements AttachTTY {
 isTTY=true;isRaw=false;columns=80;rows=24;output='';probe=true;
 setRawMode(raw:boolean){this.isRaw=raw;}resume(){}pause(){}
 write(data:string|Buffer){this.output+=data.toString();if(this.probe&&data.toString().includes('\x1b[c'))queueMicrotask(()=>this.emit('data',Buffer.from('\x1b[?1;2c')));return true;}
}
class Connection extends EventEmitter {
 requests:RequestBody[]=[];sent:Buffer[]=[];
 async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);return {id:randomUUID(),ok:true,snapshot:'hello',cols:80,rows:body.kind==='sessions.attach'?body.rows:24,session,modes:{applicationCursorKeys:false,applicationKeypad:false,bracketedPaste:true,mouseTracking:'drag',mouseEncoding:'sgr',focusEvents:false,cursorVisible:true}};}
 input(_id:string,data:Buffer){this.sent.push(data);}
}
const tick=()=>new Promise(r=>setTimeout(r,20));
it('opt-in attach gives daemon rows minus one, filters other output, resizes and leaves daemon agent alive',async()=>{
 const tty=new TTY(),connection=new Connection(),signals=new EventEmitter();const done=attach(connection,id,{stdin:tty,stdout:tty,signals,bar:'on'});await tick();
 expect(connection.requests).toContainEqual({kind:'sessions.attach',sessionId:id,cols:80,rows:23});expect(tty.output).toContain('bar agent');
 connection.emit('output',randomUUID(),Buffer.from('OTHER_BYTES'));connection.emit('output',id,Buffer.from('LIVE'));tty.emit('data',Buffer.from('x'));tty.emit('data',Buffer.from('\x1b[<0;3;5M'));
 tty.rows=35;tty.columns=100;signals.emit('SIGWINCH');await tick();tty.emit('data',Buffer.from([5]));expect(await done).toBe('home key');
 expect(connection.requests).toContainEqual({kind:'sessions.resize',sessionId:id,cols:100,rows:34});expect(tty.output).not.toContain('OTHER_BYTES');expect(Buffer.concat(connection.sent).toString()).toContain('\x1b[<0;3;4M');expect(Buffer.concat(connection.sent).includes(5)).toBe(false);expect(connection.requests.some(r=>r.kind==='sessions.stop')).toBe(false);expect(tty.isRaw).toBe(false);
});
it('failed probe logs once and falls back to full-height raw snapshot and output for this attach',async()=>{
 const tty=new TTY(),connection=new Connection(),signals=new EventEmitter();tty.probe=false;const logs:string[]=[];
 const done=attach(connection,id,{stdin:tty,stdout:tty,signals,bar:'on',fallbackLog:text=>logs.push(text)});await new Promise(r=>setTimeout(r,300));
 connection.emit('output',id,Buffer.from('RAW_BYTES'));tty.emit('data',Buffer.from([5]));await done;
 expect(connection.requests).toContainEqual({kind:'sessions.attach',sessionId:id,cols:80,rows:24});expect(tty.output).toContain('RAW_BYTES');expect(logs).toHaveLength(1);
});
it('off never probes and retains raw passthrough including original terminal escape bytes',async()=>{
 const tty=new TTY(),connection=new Connection();const done=attach(connection,id,{stdin:tty,stdout:tty,signals:new EventEmitter(),bar:'off'});await tick();connection.emit('output',id,Buffer.from('\x1b]8;;target\x07RAW'));tty.emit('data',Buffer.from([5]));await done;
 expect(tty.output).not.toContain('\x1b[c');expect(tty.output).toContain('\x1b]8;;target\x07RAW');
});

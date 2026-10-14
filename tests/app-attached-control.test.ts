import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { attach } from '../src/client/attach.js';
import { split } from '../src/client/split.js';
import { AppInput } from '../src/client/app-input.js';
import { encodeAppControl, type AppCommand } from '../src/shared/app-control.js';
import { createTheme, BACKGROUND_QUERY } from '../src/client/tui/theme.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
const token = 'a'.repeat(64), now = '2026-10-14T12:00:00Z';
const sessions: SessionInfo[] = ['one','two'].map(title=>({id:randomUUID(),title,engine:'shell',model:null,auth:{kind:'account'},cwd:'/tmp',permission:'ask',status:'running',statusDetail:'',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null}));
class TTY extends EventEmitter {
  isTTY=true; isRaw=false; columns=130; rows=45; output='';
  setRawMode(value:boolean){this.isRaw=value;} resume(){} pause(){}
  write(data:string|Buffer){
    this.output+=data.toString();
    if(data.toString().includes('\x1b[c')) queueMicrotask(()=>this.emit('data',Buffer.from('\x1b[?1;2c')));
    if(data===BACKGROUND_QUERY) queueMicrotask(()=>this.emit('data',Buffer.from('\x1b]11;rgb:ff/ff/ff\x1b\\')));
    return true;
  }
}
class Client extends EventEmitter {
  sent:Buffer[]=[]; requests:RequestBody[]=[];
  async request(body:RequestBody):Promise<SuccessResponse>{
    this.requests.push(body);
    if(body.kind==='sessions.list')return {id:randomUUID(),ok:true,sessions};
    if(body.kind!=='sessions.attach')return {id:randomUUID(),ok:true};
    const session=sessions.find(s=>s.id===body.sessionId);if(!session)throw new Error('No test session');
    return {id:randomUUID(),ok:true,session,snapshot:'hello',cols:body.cols,rows:body.rows,modes:{applicationCursorKeys:false,applicationKeypad:false,bracketedPaste:true,mouseTracking:'none',mouseEncoding:'default',focusEvents:false,cursorVisible:true}};
  }
  input(_id:string,data:Buffer){this.sent.push(data);} pauseOutput(){} resumeOutput(){} close(){}
}
it.each(['raw','bar','split'] as const)('%s: controls cannot reach the agent; output/paste/wrong-token are inert; authenticated home detaches',async mode=>{
  const tty=new TTY(),input=new AppInput(tty,token),clients:Client[]=[],controller=new AbortController(),commands:AppCommand[]=[],theme=createTheme('auto','#1e1f22');
  input.on('command',(command:AppCommand)=>{commands.push(command);if(command==='home')controller.abort();});
  const first=sessions[0];if(!first)throw new Error('No test session');
  const connection=new Client();clients.push(connection);
  const run=mode==='split'?split(sessions.map(s=>s.id),{stdin:input,stdout:tty,signals:new EventEmitter(),home:controller.signal,themeEvents:input,theme,connect:async()=>{const client=new Client();clients.push(client);return client;}}):attach(connection,first.id,{stdin:input,stdout:tty,signals:new EventEmitter(),home:controller.signal,bar:mode==='bar'?'on':'off',appTheme:()=>theme,themeEvents:input});
  const typed=()=>Buffer.concat(clients.flatMap(client=>client.sent)).toString();
  try{
    await expect.poll(()=>tty.output).toContain('hello');
    for(const client of clients)client.emit('output',first.id,Buffer.from(encodeAppControl(token,'home')));
    tty.emit('data',Buffer.from('\x1b[200~'+encodeAppControl(token,'home')+'\x1b[201~'));
    tty.emit('data',Buffer.from(encodeAppControl('b'.repeat(64),'home')));
    expect(commands).toEqual([]);expect(typed()).not.toContain('ai-term');
    expect(await input.background(tty)).toBe('#ffffff');
    expect(typed()).not.toContain('rgb:');
    tty.emit('data',Buffer.from(encodeAppControl(token,'home')));
    const result=await run;expect(typeof result==='string'?result:result.reason).toBe('home key');
    expect(commands).toEqual(['home']);expect(typed()).not.toContain('ai-term');
    expect(clients.flatMap(client=>client.requests).some(request=>request.kind==='sessions.stop')).toBe(false);
  }finally{controller.abort();await run;input.dispose();}
});

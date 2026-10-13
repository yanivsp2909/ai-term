import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import headless from '@xterm/headless';
import {Homepage} from '../src/client/tui/homepage.js';
import {InputParser,type InputEvent} from '../src/client/tui/keys.js';
import {keyTable} from '../src/client/tui/commands.js';
import {createTheme,mix} from '../src/client/tui/theme.js';
import type {RequestBody} from '../src/client/connection.js';
import type {SessionInfo,SuccessResponse} from '../src/shared/protocol.js';
const shell:SessionInfo={id:randomUUID(),title:'project shell',engine:'shell',model:'shell',auth:{kind:'account'},cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:'2026-10-13T10:00:00Z',createdAt:'2026-10-13T10:00:00Z',lastOutputAt:null,exitCode:null,ctxPercent:null};
class TTY extends EventEmitter {
 isTTY=true;isRaw=false;columns=130;rows=45;output='';
 setRawMode(value:boolean){this.isRaw=value;} resume(){} pause(){}
 write(value:string|Buffer){this.output+=value.toString();return true;}
}
class Client extends EventEmitter {
 requests:RequestBody[]=[];input=vi.fn();
 constructor(private readonly sessions:SessionInfo[]=[]){super();}
 async request(body:RequestBody):Promise<SuccessResponse>{
  this.requests.push(body);const result:SuccessResponse={id:randomUUID(),ok:true};
  if(body.kind==='settings.get')result.settings={theme:'graphite'};
  if(body.kind==='sessions.list')result.sessions=this.sessions;
  if(body.kind==='sessions.preview'){result.snapshot='hello preview';result.cols=88;result.rows=27;}
  return result;
 }
}
afterEach(()=>vi.restoreAllMocks());
async function fixture(sessions:SessionInfo[]=[]){
 const tty=new TTY(),client=new Client(sessions),copy=vi.fn(async()=>{}),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp',copy});
 await home.start();return {tty,client,home,copy};
}
const send=(tty:TTY,text:string)=>tty.emit('data',Buffer.from(text));
const paste=(tty:TTY,text:string)=>send(tty,'\x1b[200~'+text+'\x1b[201~');
// SGR mouse reports are 1-based; the field's text starts at column 4 of row rows-3.
const FIELD_ROW=43,col=(x:number)=>x+5;
const drag=(tty:TTY,from:number,to:number)=>send(tty,`\x1b[<0;${col(from)};${FIELD_ROW}M\x1b[<32;${col(to)};${FIELD_ROW}M\x1b[<0;${col(to)};${FIELD_ROW}m`);
const theme=createTheme('graphite'),selectionBg=Number.parseInt(mix(theme.colors.surface,theme.colors.accent,0.38).slice(1),16);
// The field as drawn: its text (block cursor removed) and the run of cells painted with the selection color.
async function field(tty:TTY):Promise<{text:string;selected:string}>{
 const terminal=new headless.Terminal({cols:tty.columns,rows:tty.rows,allowProposedApi:true});
 try{
  await new Promise<void>(resolve=>terminal.write(tty.output,resolve));
  const line=terminal.buffer.active.getLine(tty.rows-3);if(!line)throw new Error('field row');
  let text='',selected='';
  for(let x=4;x<tty.columns-2;x++){const cell=line.getCell(x);if(!cell)continue;const char=cell.getChars()||' ';if(char==='█')continue;text+=char;if(cell.isBgRGB()&&cell.getBgColor()===selectionBg)selected+=char;}
  return {text:text.trimEnd(),selected};
 }finally{terminal.dispose();}
}
it('the parser names the new editing keys',()=>{
 const events:InputEvent[]=[],parser=new InputParser(event=>events.push(event));
 try{parser.push(Buffer.from('\x1b[1;2D\x1b[1;2C\x1b[3~\x15\x1b\x7f\x17'));expect(events.map(e=>e.kind==='key'?e.key:e.kind)).toEqual(['shift-left','shift-right','delete','ctrl-u','alt-backspace','alt-backspace']);}finally{parser.dispose();}
});
it('a mouse drag selects field text, Backspace removes it, and Esc or a click clears it without copying',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'hello world');drag(f.tty,6,10);await expect.poll(()=>field(f.tty)).toEqual({text:'hello world',selected:'world'});
  send(f.tty,'\x1b');await expect.poll(()=>field(f.tty)).toEqual({text:'hello world',selected:''});
  // A second Esc still clears the whole field, as before.
  drag(f.tty,0,4);await expect.poll(()=>field(f.tty)).toMatchObject({selected:'hello'});
  send(f.tty,'\x1b[<0;5;10M\x1b[<0;5;10m');await expect.poll(()=>field(f.tty)).toEqual({text:'hello world',selected:''});
  drag(f.tty,0,4);send(f.tty,'\x7f');await expect.poll(()=>field(f.tty)).toEqual({text:' world',selected:''});
  // Dragging right to left selects the same cells.
  drag(f.tty,5,1);await expect.poll(()=>field(f.tty)).toMatchObject({selected:' wor'});
  send(f.tty,'\x1b');send(f.tty,'\x1b');await expect.poll(()=>field(f.tty)).toEqual({text:'What do you want to build?',selected:''});
  expect(f.copy).not.toHaveBeenCalled();
 }finally{await f.home.stop();}
});
it('Delete removes a selection; typing and pasting replace it',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'one two three');drag(f.tty,4,7);send(f.tty,'\x1b[3~');await expect.poll(()=>field(f.tty)).toEqual({text:'one three',selected:''});
  drag(f.tty,4,8);send(f.tty,'X');await expect.poll(()=>field(f.tty)).toEqual({text:'one X',selected:''});
  // The caret stays after the replacement, so typing continues there.
  send(f.tty,'Y');await expect.poll(()=>field(f.tty)).toMatchObject({text:'one XY'});
  drag(f.tty,0,2);paste(f.tty,'Z');await expect.poll(()=>field(f.tty)).toEqual({text:'Z XY',selected:''});
  drag(f.tty,0,0);await expect.poll(()=>field(f.tty)).toMatchObject({selected:''});
  drag(f.tty,0,1);paste(f.tty,'line 1\nline 2');await expect.poll(()=>field(f.tty)).toEqual({text:'[pasted · 2 lines]XY',selected:''});
  send(f.tty,'\r');await expect.poll(()=>f.client.requests.some(r=>r.kind==='engines.status')).toBe(true);
 }finally{await f.home.stop();}
});
it('Shift+arrows extend a selection from the keyboard; Ctrl+U clears the field; Alt+Backspace deletes the previous word',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'alpha beta');send(f.tty,'\x1b[1;2D'.repeat(4));await expect.poll(()=>field(f.tty)).toEqual({text:'alpha beta',selected:'beta'});
  send(f.tty,'\x1b[1;2C');await expect.poll(()=>field(f.tty)).toMatchObject({selected:'eta'});
  send(f.tty,'G');await expect.poll(()=>field(f.tty)).toEqual({text:'alpha bG',selected:''});
  send(f.tty,' gamma  ');send(f.tty,'\x1b\x7f');await expect.poll(()=>field(f.tty)).toEqual({text:'alpha bG',selected:''});
  send(f.tty,'\x1b\x7f');await expect.poll(()=>field(f.tty)).toEqual({text:'alpha',selected:''});
  send(f.tty,'\x15');await expect.poll(()=>field(f.tty)).toEqual({text:'What do you want to build?',selected:''});
  // With an empty field the shortcut letters work again.
  send(f.tty,'b');await expect.poll(()=>f.tty.output.includes('daily')).toBe(true);
 }finally{await f.home.stop();}
});
it('paste tokens are selected and deleted whole, never cut in half',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'ab');paste(f.tty,'l1\nl2\nl3');send(f.tty,'cd');await expect.poll(()=>field(f.tty)).toMatchObject({text:'ab[pasted · 3 lines]cd'});
  // A drag ending inside the token's label takes the whole token.
  drag(f.tty,1,8);await expect.poll(()=>field(f.tty)).toMatchObject({selected:'b[pasted · 3 lines]'});
  send(f.tty,'\x7f');await expect.poll(()=>field(f.tty)).toEqual({text:'acd',selected:''});
  send(f.tty,'\x15x');paste(f.tty,'p1\np2');send(f.tty,'\x1b[1;2D');await expect.poll(()=>field(f.tty)).toEqual({text:'x[pasted · 2 lines]',selected:'[pasted · 2 lines]'});
  send(f.tty,'\x1b[3~');await expect.poll(()=>field(f.tty)).toEqual({text:'x',selected:''});
  paste(f.tty,'p1\np2');send(f.tty,'\x1b\x7f');await expect.poll(()=>field(f.tty)).toEqual({text:'x',selected:''});
  // A drag starting inside a token takes it whole too, and typing replaces it.
  paste(f.tty,'q1\nq2');send(f.tty,'y');drag(f.tty,5,6);send(f.tty,'T');await expect.poll(()=>field(f.tty)).toEqual({text:'xTy',selected:''});
 }finally{await f.home.stop();}
});
it('dragging in the preview still copies, clears the field selection, and no key reaches the agent',async()=>{
 const f=await fixture([shell]);
 try{
  await expect.poll(()=>f.client.requests.some(r=>r.kind==='sessions.preview')).toBe(true);
  send(f.tty,'abc');send(f.tty,'\x1b[1;2D'.repeat(2));await expect.poll(()=>field(f.tty)).toMatchObject({selected:'bc'});
  send(f.tty,'\x1b[<0;41;4M\x1b[<32;45;4M\x1b[<0;45;4m');
  await expect.poll(()=>f.copy.mock.calls.length).toBe(1);expect(f.copy).toHaveBeenCalledWith('hello');
  await expect.poll(()=>field(f.tty)).toEqual({text:'abc',selected:''});
  send(f.tty,'\x1b[1;2D\x1b[3~\x15\x1b\x7f\x17');
  expect(f.client.input).not.toHaveBeenCalled();expect(f.client.requests.some(r=>r.kind==='sessions.input')).toBe(false);
 }finally{await f.home.stop();}
});
it('the key table lists the new field keys',()=>{
 const keys=keyTable.map(([key])=>key).join('\n');
 for(const key of ['Shift+←/→','Delete','Ctrl+U','Alt+Backspace','Command field drag'])expect(keys).toContain(key);
});

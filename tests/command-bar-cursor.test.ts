import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import headless from '@xterm/headless';
import {Homepage} from '../src/client/tui/homepage.js';
import {CommandField,InputParser,type InputEvent} from '../src/client/tui/keys.js';
import {keyTable} from '../src/client/tui/commands.js';
import {createTheme} from '../src/client/tui/theme.js';
import type {RequestBody} from '../src/client/connection.js';
import type {SuccessResponse} from '../src/shared/protocol.js';
class TTY extends EventEmitter {
 isTTY=true;isRaw=false;columns=130;rows=45;output='';
 setRawMode(value:boolean){this.isRaw=value;} resume(){} pause(){}
 write(value:string|Buffer){this.output+=value.toString();return true;}
}
class Client extends EventEmitter {
 requests:RequestBody[]=[];input=vi.fn();
 async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);const result:SuccessResponse={id:randomUUID(),ok:true};if(body.kind==='settings.get')result.settings={theme:'graphite'};if(body.kind==='sessions.list')result.sessions=[];return result;}
}
afterEach(()=>vi.restoreAllMocks());
async function fixture(){const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp',copy:vi.fn(async()=>{})});await home.start();return {tty,client,home};}
const send=(tty:TTY,text:string)=>tty.emit('data',Buffer.from(text));
const paste=(tty:TTY,text:string)=>send(tty,'\x1b[200~'+text+'\x1b[201~');
const cursorColor=Number.parseInt(createTheme('graphite').colors.cursor.slice(1),16);
// The field as drawn, with | where the cursor is: a reversed cell inside the text, or the block after it.
async function field(tty:TTY):Promise<string>{
 const terminal=new headless.Terminal({cols:tty.columns,rows:tty.rows,allowProposedApi:true});
 try{
  await new Promise<void>(resolve=>terminal.write(tty.output,resolve));
  const line=terminal.buffer.active.getLine(tty.rows-3);if(!line)throw new Error('field row');
  let text='';
  for(let x=4;x<tty.columns-2;x++){const cell=line.getCell(x);if(!cell||cell.getWidth()===0)continue;const char=cell.getChars()||' ';if(char==='█'){text+='|';continue;}if(cell.isBgRGB()&&cell.getBgColor()===cursorColor)text+='|';text+=char;}
  return text.trimEnd();
 }finally{terminal.dispose();}
}
const LEFT='\x1b[D',RIGHT='\x1b[C',ALT_LEFT='\x1b[1;3D',ALT_RIGHT='\x1b[1;3C',HOME='\x1b[H',END='\x1b[F';
it('the parser names word moves and line ends, including the ESC b / ESC f form macOS terminals send',()=>{
 const events:InputEvent[]=[],parser=new InputParser(event=>events.push(event));
 try{parser.push(Buffer.from('\x1b[1;3D\x1b[1;3C\x1bb\x1bf\x1b[H\x1bOH\x1b[1~\x01\x05\x1b[F'));expect(events.map(e=>e.kind==='key'?e.key:e.kind)).toEqual(['alt-left','alt-right','alt-left','alt-right','home','home','home','ctrl-a','ctrl-e','end']);}finally{parser.dispose();}
});
it('← → move by character; typing, Backspace and Delete work at the cursor',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'helo');await expect.poll(()=>field(f.tty)).toBe('helo|');
  send(f.tty,LEFT);await expect.poll(()=>field(f.tty)).toBe('hel|o');
  send(f.tty,'l');await expect.poll(()=>field(f.tty)).toBe('hell|o');
  send(f.tty,LEFT+LEFT+'\x7f');await expect.poll(()=>field(f.tty)).toBe('h|llo');
  send(f.tty,'\x1b[3~');await expect.poll(()=>field(f.tty)).toBe('h|lo');
  send(f.tty,RIGHT+RIGHT+RIGHT+RIGHT);await expect.poll(()=>field(f.tty)).toBe('hlo|');
  send(f.tty,'\x1b[3~');await expect.poll(()=>field(f.tty)).toBe('hlo|');
 }finally{await f.home.stop();}
});
it('Alt+← → move by word, Home/End and Ctrl+A/Ctrl+E jump to the ends, and paste inserts at the cursor',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'one two  three');send(f.tty,ALT_LEFT);await expect.poll(()=>field(f.tty)).toBe('one two  |three');
  send(f.tty,ALT_LEFT);await expect.poll(()=>field(f.tty)).toBe('one |two  three');
  send(f.tty,'\x1bb');await expect.poll(()=>field(f.tty)).toBe('|one two  three');
  send(f.tty,ALT_RIGHT);await expect.poll(()=>field(f.tty)).toBe('one| two  three');
  send(f.tty,'\x1bf');await expect.poll(()=>field(f.tty)).toBe('one two|  three');
  send(f.tty,END);await expect.poll(()=>field(f.tty)).toBe('one two  three|');
  send(f.tty,HOME);await expect.poll(()=>field(f.tty)).toBe('|one two  three');
  send(f.tty,'\x05');await expect.poll(()=>field(f.tty)).toBe('one two  three|');
  send(f.tty,'\x01');await expect.poll(()=>field(f.tty)).toBe('|one two  three');
  paste(f.tty,'go ');await expect.poll(()=>field(f.tty)).toBe('go |one two  three');
  send(f.tty,ALT_RIGHT);paste(f.tty,'a\nb');await expect.poll(()=>field(f.tty)).toBe('go one[pasted · 2 lines]| two  three');
 }finally{await f.home.stop();}
});
it('the cursor steps over a paste token as one unit; Backspace and Delete remove it whole',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'ab');paste(f.tty,'x\ny');send(f.tty,'cd');await expect.poll(()=>field(f.tty)).toBe('ab[pasted · 2 lines]cd|');
  send(f.tty,LEFT+LEFT+LEFT);await expect.poll(()=>field(f.tty)).toBe('ab|[pasted · 2 lines]cd');
  send(f.tty,RIGHT);await expect.poll(()=>field(f.tty)).toBe('ab[pasted · 2 lines]|cd');
  send(f.tty,ALT_LEFT);await expect.poll(()=>field(f.tty)).toBe('ab|[pasted · 2 lines]cd');
  send(f.tty,'\x1b[3~');await expect.poll(()=>field(f.tty)).toBe('ab|cd');
  paste(f.tty,'x\ny');send(f.tty,'\x7f');await expect.poll(()=>field(f.tty)).toBe('ab|cd');
 }finally{await f.home.stop();}
});
it('End follows the preview live while the field is empty; ↑↓ select agents only as before',()=>{
 const field=new CommandField();
 expect(field.key('end')).toEqual({kind:'end'});expect(field.key('home')).toEqual({kind:'draw'});expect(field.key('up')).toEqual({kind:'up'});
 field.key('a');field.key('b');field.key('home');expect(field.key('end')).toEqual({kind:'draw'});expect(field.view().caret).toBe(2);
 // With text in the field ↑↓ change nothing, as today.
 expect(field.key('up')).toEqual({kind:'draw'});expect(field.text).toBe('ab');
});
it('the key table lists the cursor keys',()=>{
 const keys=keyTable.map(([key])=>key).join('\n');
 for(const key of ['←/→','Alt+←/→','Home/End','Ctrl+A/Ctrl+E'])expect(keys).toContain(key);
});

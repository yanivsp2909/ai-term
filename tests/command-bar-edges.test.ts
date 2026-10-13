import {afterEach,expect,it,vi} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Homepage} from '../src/client/tui/homepage.js';
import {fieldStart} from '../src/client/tui/command-bar.js';
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
  if(body.kind==='keys.list')result.keys=[];
  if(body.kind==='engines.status')result.engines={claudeCode:{installed:true,path:'/stub/claude',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub/codex',version:'1',loggedIn:true,authMethod:'subscription'}};
  if(body.kind==='sessions.preview'){result.snapshot='hello preview';result.cols=88;result.rows=27;}
  if(body.kind==='sessions.create'&&body.engine!=='shell'){const now=new Date().toISOString();result.session={id:randomUUID(),title:'test agent',engine:body.engine,model:body.model,auth:{kind:'account'},cwd:body.cwd,permission:body.permission,status:'starting',statusDetail:'starting',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};}
  return result;
 }
}
afterEach(()=>vi.restoreAllMocks());
async function fixture(sessions:SessionInfo[]=[]){const tty=new TTY(),client=new Client(sessions),copy=vi.fn(async()=>{}),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp',copy});await home.start();return {tty,client,home,copy};}
const send=(tty:TTY,text:string)=>tty.emit('data',Buffer.from(text));
it('the start box edits its first message at the end even when the bar had a mid-text cursor or a selection',async()=>{
 const f=await fixture();
 try{
  send(f.tty,'ab');send(f.tty,'\x1b[200~x\ny\x1b[201~');send(f.tty,'cd');send(f.tty,'\x1b[1;2D\x1b[1;2D\x1b[D');
  send(f.tty,'\r');await expect.poll(()=>f.client.requests.some(r=>r.kind==='engines.status')).toBe(true);
  send(f.tty,'\x1b[B'.repeat(4));send(f.tty,'Z\x7fQ');send(f.tty,'\r');
  await expect.poll(()=>f.client.requests.some(r=>r.kind==='sessions.create')).toBe(true);
  expect(f.client.requests.find(r=>r.kind==='sessions.create')).toMatchObject({firstMessage:'abx\nycdQ'});
 }finally{await f.home.stop();}
});
it('a field press whose release never arrived does not swallow the next drag in the preview',async()=>{
 const f=await fixture([shell]);
 try{
  await expect.poll(()=>f.client.requests.some(r=>r.kind==='sessions.preview')).toBe(true);
  send(f.tty,'abc');send(f.tty,'\x1b[<0;6;43M');
  send(f.tty,'\x1b[<0;41;4M\x1b[<32;45;4M\x1b[<0;45;4m');
  await expect.poll(()=>f.copy.mock.calls.length).toBe(1);expect(f.copy).toHaveBeenCalledWith('hello');
 }finally{await f.home.stop();}
});
it('the field scrolls so a wide character under the cursor is whole, and a selection up to the last cell does not scroll',()=>{
 const cols=20,visible=cols-6;
 const wide=[...'a'.repeat(visible-1),'界','b'];
 expect(fieldStart({units:wide,caret:visible-1,selection:null},cols)).toBe(1);
 const plain=[...'a'.repeat(30)];
 expect(fieldStart({units:plain,caret:visible,selection:[0,visible]},cols)).toBe(0);
 // Without a selection the end-of-text cursor still needs its own cell.
 expect(fieldStart({units:plain.slice(0,visible),caret:visible,selection:null},cols)).toBe(1);
});

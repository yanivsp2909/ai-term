import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import headless from '@xterm/headless';
import {Homepage} from '../src/client/tui/homepage.js';
import type {RequestBody} from '../src/client/connection.js';
import type {SuccessResponse,SessionInfo} from '../src/shared/protocol.js';
class TTY extends EventEmitter{isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
class Client extends EventEmitter{constructor(public sessions:SessionInfo[]){super();}async request(body:RequestBody):Promise<SuccessResponse>{return {id:randomUUID(),ok:true,...(body.kind==='sessions.list'?{sessions:this.sessions}:body.kind==='settings.get'?{settings:{theme:'graphite'}}:body.kind==='sessions.preview'?{snapshot:'',cols:88,rows:27}:{})};}}
const ago=(ms:number)=>new Date(Date.now()-ms).toISOString();
function agent(over:Partial<SessionInfo>):SessionInfo{return {id:randomUUID(),title:'agent',engine:'claude-code',model:'opus-5.5',auth:{kind:'account'},authMethod:'subscription',cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:ago(30000),createdAt:ago(60000),lastOutputAt:ago(1000),exitCode:null,ctxPercent:null,lastActivity:null,...over};}
async function screen(tty:TTY){const terminal=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});try{await new Promise<void>(r=>terminal.write(tty.output,r));return Array.from({length:45},(_,y)=>terminal.buffer.active.getLine(y)?.translateToString()??'').join('\n');}finally{terminal.dispose();}}
async function fixture(sessions:SessionInfo[]){const tty=new TTY(),client=new Client(sessions),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});await home.start();return {tty,client,home};}
it('a quiet card counts up once a second without any daemon event',async()=>{
 const {tty,home}=await fixture([agent({lastOutputAt:ago(11200)})]);
 try{await expect.poll(()=>screen(tty)).toContain('quiet 11s');await expect.poll(()=>screen(tty),{timeout:2500}).toContain('quiet 12s');}finally{await home.stop();}
});
it('a busy card turns quiet at the 10 s crossing, and no card showing quiet means no timed redraws',async()=>{
 const {tty,home}=await fixture([agent({lastOutputAt:ago(9300)})]);
 try{await expect.poll(()=>screen(tty)).toContain('agent');expect(await screen(tty)).not.toContain('quiet');await expect.poll(()=>screen(tty),{timeout:2500}).toContain('quiet 10s');}finally{await home.stop();}
 const idle=await fixture([agent({status:'done',statusDetail:'done'})]);
 try{await expect.poll(()=>screen(idle.tty)).toContain('ready to review');const length=idle.tty.output.length;await new Promise(r=>setTimeout(r,1300));expect(idle.tty.output.length).toBe(length);}finally{await idle.home.stop();}
});
it('the selection stays on the same agent when a status change reorders the list',async()=>{
 const newer=agent({title:'newer-agent',createdAt:ago(1000)}),older=agent({title:'older-agent',createdAt:ago(90000)});
 const {tty,client,home}=await fixture([newer,older]);
 try{
  await expect.poll(()=>screen(tty)).toContain('newer-agent');tty.emit('data',Buffer.from('\x1b[B'));
  await expect.poll(async()=>(await screen(tty)).split('\n')[5]?.slice(0,20)).toContain('▎');
  client.emit('event',{kind:'session.updated',session:{...older,status:'waiting',statusDetail:'permission',statusSince:new Date().toISOString()}});
  await expect.poll(async()=>(await screen(tty)).split('\n')[2]).toContain('older-agent');
  const rows=(await screen(tty)).split('\n');expect(rows[2]?.slice(0,3)).toContain('▎');expect(rows[5]?.slice(0,3)).not.toContain('▎');expect(rows[4]).toContain('asks: permission');
  tty.emit('data',Buffer.from('\x1b[B'));await expect.poll(async()=>(await screen(tty)).split('\n')[5]?.slice(0,3)).toContain('▎');
 }finally{await home.stop();}
});

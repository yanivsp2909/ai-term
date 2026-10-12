import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { renderHomepage } from '../src/client/tui/layout.js';
import { createTheme } from '../src/client/tui/theme.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';
class TTY extends EventEmitter {isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
const now=new Date().toISOString();
const sessions:SessionInfo[]=[0,1].map(i=>({id:randomUUID(),title:'agent '+i,engine:'shell',model:'shell',auth:{kind:'account'},cwd:'/tmp',permission:'ask',status:'running',statusDetail:'running',statusSince:now,createdAt:new Date(Date.parse(now)-i*1000).toISOString(),lastOutputAt:null,exitCode:null,ctxPercent:null}));
class Client extends EventEmitter {
 requests:RequestBody[]=[];input=vi.fn();
 async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);return {id:randomUUID(),ok:true,...(body.kind==='settings.get'?{settings:{theme:'graphite'}}:body.kind==='sessions.list'?{sessions}:body.kind==='keys.list'?{keys:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key'}}}:{snapshot:'',cols:88,rows:27})};}
}
async function fixture(){const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});await home.start();return {home,tty,client};}
async function screen(tty:TTY){const t=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});try{await new Promise<void>(r=>t.write(tty.output,r));return Array.from({length:45},(_,y)=>t.buffer.active.getLine(y)?.translateToString()??'').join('\n');}finally{t.dispose();}}
it('menu arrows select commands without changing agents, Enter picks, and Esc closes',async()=>{
 const {home,tty,client}=await fixture();try{
  const previews=client.requests.filter(r=>r.kind==='sessions.preview').length;
  tty.emit('data',Buffer.from('/\x1b[B\r'));await expect.poll(()=>screen(tty)).toContain('Select folder');
  expect(client.requests.filter(r=>r.kind==='sessions.preview')).toHaveLength(previews);expect(client.input).not.toHaveBeenCalled();
  tty.emit('data',Buffer.from('\x1b'));await new Promise(r=>setTimeout(r,100));expect(await screen(tty)).not.toContain('Select folder');
  tty.emit('data',Buffer.from('\x1b[B'));await expect.poll(()=>client.requests.filter(r=>r.kind==='sessions.preview').length).toBe(previews+1);
 }finally{await home.stop();}
});
it('menu wraps, typing resets to first filtered match, and argument command fills field',async()=>{
 const {home,tty,client}=await fixture();try{
  tty.emit('data',Buffer.from('/\x1b[A\x1b[A\r'));await expect.poll(()=>screen(tty)).toContain('› /theme █');
  expect(client.requests.some(r=>r.kind==='settings.set')).toBe(false);
  tty.emit('data',Buffer.from('\x1b'));await new Promise(r=>setTimeout(r,100));
  tty.emit('data',Buffer.from('/\x1b[Bm\r'));await expect.poll(()=>screen(tty)).toContain('Select model');
 }finally{await home.stop();}
});
it('selected command uses selected-card fill, accent bar and bold text',()=>{
 const theme=createTheme('graphite');const grid=renderHomepage({cols:130,rows:45,sessions:[],selectedId:null,input:'/',note:'',previewVisible:true,cwd:'/tmp',now:0,menuChoice:1},theme);
 const content=grid.findIndex(row=>row[3]?.char==='/'&&row[4]?.char==='m'),selected=grid[content];
 expect(grid[content+1]?.[1]?.bg).toBe(theme.colors['surface-2']);expect(grid[content+1]?.[1]?.char).toBe('▎');expect(grid[content+1]?.[1]?.fg).toBe(theme.colors.accent);expect(grid[content+1]?.[3]?.bold).toBe(true);expect(selected?.[1]?.bg).toBe(theme.colors.surface);
});

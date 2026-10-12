import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse, SessionInfo } from '../src/shared/protocol.js';
class TTY extends EventEmitter {isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
class Client extends EventEmitter {
 requests:RequestBody[]=[];input=vi.fn();loggedIn=true;
 async request(body:RequestBody):Promise<SuccessResponse>{
  this.requests.push(body);const result:SuccessResponse={id:randomUUID(),ok:true};
  if(body.kind==='settings.get'||body.kind==='settings.set')result.settings={theme:'graphite'};
  if(body.kind==='sessions.list')result.sessions=[];
  if(body.kind==='engines.status')result.engines={claudeCode:{installed:true,path:'/stub/claude',version:'2.1.295',loggedIn:this.loggedIn,authMethod:'subscription'},codex:{installed:true,path:'/stub/codex',version:'0.160.1',loggedIn:true,authMethod:'api-key'}};
  if(body.kind==='sessions.create'&&body.engine!=='shell'){const now=new Date().toISOString();result.session={id:randomUUID(),title:body.title??'Claude Code',engine:body.engine,model:body.model,auth:{kind:'account'},cwd:body.cwd,permission:body.permission,status:'starting',statusDetail:'starting',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};}
  if(body.kind==='sessions.preview'){result.snapshot='AGENT_PREVIEW';result.cols=88;result.rows=27;}
  return result;
 }
}
async function fixture(){const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});await home.start();return {tty,client,home};}
async function screen(tty:TTY){const terminal=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});try{await new Promise<void>(r=>terminal.write(tty.output,r));return Array.from({length:45},(_,y)=>terminal.buffer.active.getLine(y)?.translateToString()??'').join('\n');}finally{terminal.dispose();}}
it('text opens start box, tab toggles per-session mode, Esc restores editing, and enter selects new preview',async()=>{
 const {tty,client,home}=await fixture();try{
  tty.emit('data',Buffer.from('\x1b[200~reply with ok\x1b[201~\r'));await expect.poll(()=>screen(tty)).toContain('Start a new agent');
  expect(client.requests.some(r=>r.kind==='sessions.create')).toBe(false);tty.emit('data',Buffer.from('\t'));expect(await screen(tty)).toContain("! don't ask");
  tty.emit('data',Buffer.from('\x1b'));await new Promise(r=>setTimeout(r,100));expect(await screen(tty)).not.toContain('Start a new agent');expect(await screen(tty)).toContain('reply with ok');
  tty.emit('data',Buffer.from('\r'));await expect.poll(()=>screen(tty)).toContain('Start a new agent');tty.emit('data',Buffer.from('\r'));
  await expect.poll(()=>client.requests.some(r=>r.kind==='sessions.create')).toBe(true);
  expect(client.requests.find(r=>r.kind==='sessions.create')).toMatchObject({engine:'claude-code',model:null,auth:{kind:'account'},cwd:'/tmp',permission:'ask',firstMessage:'reply with ok'});
  await expect.poll(()=>screen(tty)).toContain('AGENT_PREVIEW');expect(client.input).not.toHaveBeenCalled();
 }finally{await home.stop();}
});
it('/model offers account groups and custom id, /cd validates folder, and login failure blocks starting inline',async()=>{
 const {tty,client,home}=await fixture();try{
  tty.emit('data',Buffer.from('/model\r'));await expect.poll(()=>screen(tty)).toContain('ANTHROPIC');expect(await screen(tty)).toContain('OPENAI');expect(await screen(tty)).toContain('CLI default');
  tty.emit('data',Buffer.from('custom-id\r'));await expect.poll(()=>screen(tty)).not.toContain('Select model');
  tty.emit('data',Buffer.from('/cd\r'));await expect.poll(()=>screen(tty)).toContain('Select folder');
  tty.emit('data',Buffer.from('/missing-ai-term-directory\r'));await expect.poll(()=>screen(tty)).toContain('existing directory');
  tty.emit('data',Buffer.from('\x1b'));await new Promise(r=>setTimeout(r,100));
  client.loggedIn=false;tty.emit('data',Buffer.from('hi\r'));await expect.poll(()=>screen(tty)).toContain('not logged in');tty.emit('data',Buffer.from('\r'));await new Promise(r=>setTimeout(r,100));expect(client.requests.some(r=>r.kind==='sessions.create')).toBe(false);
 }finally{await home.stop();}
});
it('cards show CLI default, engine, actual auth and red dontAsk marker',async()=>{
 const {renderHomepage}=await import('../src/client/tui/layout.js'),{plainText}=await import('../src/client/tui/grid.js'),{createTheme}=await import('../src/client/tui/theme.js');
 const now=new Date().toISOString(),session:SessionInfo={id:randomUUID(),title:'agent',engine:'codex',model:null,auth:{kind:'account'},authMethod:'api-key',cwd:'/tmp',permission:'dontAsk',status:'running',statusDetail:'running',statusSince:now,createdAt:now,lastOutputAt:null,exitCode:null,ctxPercent:null};
 const text=plainText(renderHomepage({cols:130,rows:45,sessions:[session],selectedId:session.id,input:'',note:'',previewVisible:true,cwd:'/tmp',now:Date.now()},createTheme('graphite')));
 expect(text).toContain('CLI default');expect(text).toContain('codex');expect(text).toContain('API key');expect(text).toContain("! don't ask");
});

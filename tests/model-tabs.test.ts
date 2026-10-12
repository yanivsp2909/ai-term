import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { KeyView, SuccessResponse } from '../src/shared/protocol.js';
class TTY extends EventEmitter {isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
const key:KeyView={id:randomUUID(),provider:'foundry',label:'Azure',last4:'ITid',endpoint:'https://narvis-resource.openai.azure.com/openai/v1',deployments:['gpt-6.1-sol'],lastTest:[{model:'gpt-6.1-sol',status:'ready'}]};
class Client extends EventEmitter {
 requests:RequestBody[]=[];defaultEngine:'claude-code'|'codex'='codex';
 async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);return {id:randomUUID(),ok:true,...(body.kind==='settings.get'?{settings:{theme:'graphite',defaultEngine:this.defaultEngine,defaultModel:'gpt-6.1-sol'}}:body.kind==='keys.list'?{keys:[key]}:body.kind==='sessions.list'?{sessions:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key'}}}:{snapshot:'',cols:88,rows:27})};}
}
async function fixture(){const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});await home.start();return {home,tty,client};}
async function screen(tty:TTY){const t=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});try{await new Promise<void>(r=>t.write(tty.output,r));return Array.from({length:45},(_,y)=>t.buffer.active.getLine(y)?.translateToString()??'').join('\n');}finally{t.dispose();}}
it('opens current provider tab, left/right switch providers, and Enter selects key auth visible in defaults',async()=>{
 const {home,tty}=await fixture();try{
  tty.emit('data',Buffer.from('/model\r'));await expect.poll(()=>screen(tty)).toContain('Select model');
  const opened=await screen(tty);expect(opened).toContain('ANTHROPIC');expect(opened).toContain('OPENAI');expect(opened).toContain('FOUNDRY · narvis-resource');expect(opened).not.toContain('opus · claude code');
  tty.emit('data',Buffer.from('\x1b[C'));await expect.poll(()=>screen(tty)).toContain('key ····ITid');
  tty.emit('data',Buffer.from('\r'));await expect.poll(()=>screen(tty)).not.toContain('Select model');expect(await screen(tty)).toContain('· key ····ITid');
  tty.emit('data',Buffer.from('/model\r'));await expect.poll(()=>screen(tty)).toContain('Select model');expect(await screen(tty)).toContain('key ····ITid');
  tty.emit('data',Buffer.from('\x1b[D'));await expect.poll(()=>screen(tty)).toContain('own login · API key');
  tty.emit('data',Buffer.from('\x1b[Dson'));await expect.poll(()=>screen(tty)).toContain('sonnet · claude code');expect(await screen(tty)).not.toContain('gpt-6.1-sol · codex · key');
 }finally{await home.stop();}
});
it('typing searches all providers and jumps to matching tab, Escape leaves defaults unchanged',async()=>{
 const {home,tty}=await fixture();try{
  tty.emit('data',Buffer.from('/model\r'));await expect.poll(()=>screen(tty)).toContain('Select model');
  tty.emit('data',Buffer.from('opus'));await expect.poll(()=>screen(tty)).toContain('opus · claude code · own login · sub');
  tty.emit('data',Buffer.from('\x1b'));await expect.poll(()=>screen(tty)).not.toContain('Select model');expect(await screen(tty)).toContain('gpt-6.1-sol · codex');
 }finally{await home.stop();}
});

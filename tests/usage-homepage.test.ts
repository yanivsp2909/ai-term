import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import headless from '@xterm/headless';
import {Homepage} from '../src/client/tui/homepage.js';
import type {RequestBody} from '../src/client/connection.js';
import type {SuccessResponse} from '../src/shared/protocol.js';
const period={costUsd:2,tokens:1000,unknownPrice:false,providers:[]},usage={today:period,week:period,month:period};
class TTY extends EventEmitter{isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}resume(){}pause(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
it('homepage subscribes usage, b saves budgets and stops subscription on exit',async()=>{
 const tty=new TTY(),requests:RequestBody[]=[],client=new EventEmitter()as EventEmitter&{request:(body:RequestBody)=>Promise<SuccessResponse>};client.request=async body=>{requests.push(body);return {id:randomUUID(),ok:true,...(body.kind==='settings.get'||body.kind==='settings.set'?{settings:{theme:'graphite',budgets:body.kind==='settings.set'?body.patch.budgets:{daily:null,weekly:null,monthly:null}}}:body.kind==='usage.summary'?{usage}:body.kind==='keys.list'?{keys:[]}:body.kind==='sessions.list'?{sessions:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key'}}}:{snapshot:'',cols:88,rows:27})};};
 const home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'}),t=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});const screen=async()=>{await new Promise<void>(r=>t.write(tty.output,r));return Array.from({length:45},(_,y)=>t.buffer.active.getLine(y)?.translateToString()??'').join('\n');};
 try{await home.start();expect(requests).toContainEqual({kind:'usage.subscribe',on:true});expect(await screen()).toContain('$2.00');tty.emit('data',Buffer.from('b'));expect(await screen()).toContain('Budget limits');tty.emit('data',Buffer.from('1\r'));await expect.poll(()=>requests.some(r=>r.kind==='settings.set'&&r.patch.budgets?.daily===1)).toBe(true);expect(await screen()).toContain('budget: today');
 }finally{await home.stop();t.dispose();}expect(requests).toContainEqual({kind:'usage.subscribe',on:false});
});
it('settings opens and saves a deployment price override without dropping other settings',async()=>{
 const tty=new TTY(),requests:RequestBody[]=[],client=new EventEmitter()as EventEmitter&{request:(body:RequestBody)=>Promise<SuccessResponse>};const settings={theme:'graphite' as const,priceOverrides:{existing:{input:1,output:2}},budgets:{daily:10,weekly:null,monthly:null}};client.request=async body=>{requests.push(body);return {id:randomUUID(),ok:true,...(body.kind==='settings.get'||body.kind==='settings.set'?{settings}:body.kind==='usage.summary'?{usage}:body.kind==='keys.list'?{keys:[]}:body.kind==='sessions.list'?{sessions:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key'}}}:{snapshot:'',cols:88,rows:27})};};const home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});
 try{await home.start();tty.emit('data',Buffer.from('/settings\r'));await new Promise(r=>setTimeout(r,30));tty.emit('data',Buffer.from('p'));await new Promise(r=>setTimeout(r,30));tty.emit('data',Buffer.from('\x1b[Bcustom-deployment\x1b[B2\x1b[B10\r'));await expect.poll(()=>requests.some(r=>r.kind==='prices.set')).toBe(true);
  // B27: the price is the provider's (Foundry, the first with no keys), saved by the daemon in its own queue (review); the old record by model id is left as it is.
  expect(requests.find(r=>r.kind==='prices.set')).toMatchObject({provider:'foundry',model:'custom-deployment',price:{input:2,output:10}});expect(requests.some(r=>r.kind==='settings.set')).toBe(false);
 }finally{await home.stop();}
});

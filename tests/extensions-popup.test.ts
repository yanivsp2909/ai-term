import { expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import headless from '@xterm/headless';
import { ExtensionsPanel } from '../src/client/tui/extensions-panel.js';
import { Homepage } from '../src/client/tui/homepage.js';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { MockLanguageModelV4 } from 'ai/test';
import { Grid, plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
import { catalogTokens, extensionTokens, type ExtensionAccess, type ExtensionItem } from '../src/shared/extensions.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';
import { stubFacts } from './fixtures/agent-facts.js';

const theme=createTheme('graphite');
function catalog():ExtensionAccess {
  const items:ExtensionItem[]=[{id:'0'.repeat(16),kind:'skill',name:'safe-skill',description:'Edit with care',source:'shared',enabled:true,tokens:extensionTokens('skill safe-skill: Edit with care\n')},{id:'1'.repeat(16),kind:'agent',name:'reviewer',description:'Read a small diff',source:'Claude',enabled:true,tokens:extensionTokens('agent reviewer: Read a small diff\n')},{id:'2'.repeat(16),kind:'command',name:'hello',description:'Say hello',source:'Codex',enabled:true,tokens:0}];
  return {list:async()=>({items:items.map(i=>({...i})),notes:[],tokens:catalogTokens(items)}),read:async(_cwd,id)=>{const item=items.find(i=>i.id===id);if(!item)throw new Error('missing');return {item,text:'---\nname: '+item.name+'\n---\nFULL FILE BODY\n'+Array.from({length:50},(_,i)=>'line '+i).join('\n'),body:'FULL FILE BODY'};},toggle:async(cwd,id,enabled)=>{const item=items.find(i=>i.id===id);if(!item)throw new Error('missing');item.enabled=enabled;return {items:items.map(i=>({...i})),notes:[],tokens:catalogTokens(items)};}};
}
it('one popup exposes every tab, per-item tokens, toggles, read-only files, scroll and Esc',async()=>{
  const access=catalog(),close=vi.fn(),changed=vi.fn(),toggled=vi.fn(),panel=new ExtensionsPanel(access,'/unused','skills',changed,close,toggled);
  const draw=()=>plainText(panel.draw(new Grid(120,32,theme).cells,theme));await panel.load();
  expect(draw()).toContain('[Skills] · Agents · Commands · MCP');expect(draw()).toContain('safe-skill · shared · ✓ on');const before=(await access.list('/unused')).tokens;
  await panel.key(' ');expect(draw()).toContain('○ off');expect(draw()).not.toContain(`≈${before} tokens/request on`);expect(toggled).toHaveBeenCalledOnce();
  await panel.key('enter');expect(draw()).toContain('read-only');expect(draw()).toContain('FULL FILE BODY');await panel.key('page-down');expect(draw()).toContain('line 25');await panel.key('escape');expect(close).not.toHaveBeenCalled();expect(draw()).toContain('[Skills]');
  await panel.key('right');expect(draw()).toContain('[Agents]');expect(draw()).toContain('reviewer · Claude');await panel.key('right');expect(draw()).toContain('hello · Codex · ✓ on · ≈0');await panel.key('right');expect(draw()).toContain('empty until v0.4.4');await panel.key('left');expect(draw()).toContain('[Commands]');await panel.key('escape');expect(close).toHaveBeenCalledOnce();
});

class TTY extends EventEmitter {isTTY=true;isRaw=false;columns=120;rows=32;output='';setRawMode(raw:boolean){this.isRaw=raw;}resume(){}pause(){}write(s:string|Buffer){this.output+=s.toString();return true;}}
async function screen(tty:TTY){const t=new headless.Terminal({cols:tty.columns,rows:tty.rows,allowProposedApi:true});try{await new Promise<void>(r=>t.write(tty.output,r));return Array.from({length:tty.rows},(_,i)=>t.buffer.active.getLine(i)?.translateToString()??'').join('\n');}finally{t.dispose();}}
const type=(tty:TTY,text:string)=>{for(const char of text)tty.emit('data',char);};
class Client extends EventEmitter {
  requests:RequestBody[]=[];extensions=catalog();
  async request(body:RequestBody):Promise<SuccessResponse>{this.requests.push(body);const result:SuccessResponse={id:randomUUID(),ok:true};if(body.kind==='settings.get')result.settings={theme:'graphite'};if(body.kind==='sessions.list')result.sessions=[];if(body.kind==='keys.list')result.keys=[{id:randomUUID(),provider:'openai',label:'fake',last4:'1234'}];if(body.kind==='extensions.list')result.extensions=await this.extensions.list(body.cwd);if(body.kind==='extensions.read')result.extension=await this.extensions.read(body.cwd,body.extensionId);if(body.kind==='extensions.toggle')result.extensions=await this.extensions.toggle(body.cwd,body.extensionId,body.enabled);return result;}
}
it('/skills and /agents on the homepage open the same popup and isolate its keys',async()=>{
  const tty=new TTY(),client=new Client(),home=new Homepage(client,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/unused',terminalProgram:'unknown'});await home.start();
  try{type(tty,'/skills\r');await vi.waitFor(async()=>expect(await screen(tty)).toContain('safe-skill'));type(tty,' ');await vi.waitFor(async()=>expect(await screen(tty)).toContain('○ off'));type(tty,'\x1b[C');await vi.waitFor(async()=>expect(await screen(tty)).toContain('[Agents]'));type(tty,'\r');await vi.waitFor(async()=>expect(await screen(tty)).toContain('read-only'));type(tty,'\x1b');await vi.waitFor(async()=>expect(await screen(tty)).toContain('[Agents]'));type(tty,'\x1b');await vi.waitFor(async()=>expect(await screen(tty)).not.toContain('Extensions ·'));type(tty,'/agents\r');await vi.waitFor(async()=>expect(await screen(tty)).toContain('[Agents]'));expect(client.requests.some(r=>r.kind==='sessions.send'||r.kind==='sessions.create')).toBe(false);}finally{await home.stop();}
});

it('/skills inside the agent accepts arrows and toggles without sending a model request',async()=>{
  const tty=new TTY(),model=new MockLanguageModelV4({doStream:[]}),access=catalog();const app=new AgentApp({screen:new Screen({write:s=>tty.write(s),columns:tty.columns,rows:tty.rows},theme),permission:'ask',models:['m1'],makeModel:async()=>model,agent:io=>new Agent({root:'/unused',permission:'ask',model,modelId:'m1',instructions:{text:'',files:[],notes:[]},reporter:{status:async()=>{},usage:async()=>{},facts:async()=>stubFacts()},transcript:new Transcript(null,s=>s,()=>{}),io,redact:s=>s,bashEnv:{PATH:'/usr/bin:/bin'},rg:null,extensions:access}),quit:vi.fn()});
  app.start();app.input('/skills\r');await vi.waitFor(async()=>expect(await screen(tty)).toContain('safe-skill'));app.input(' ');await vi.waitFor(async()=>expect(await screen(tty)).toContain('○ off'));app.input('\x1b[C');await vi.waitFor(async()=>expect(await screen(tty)).toContain('[Agents]'));app.input('\r');await vi.waitFor(async()=>expect(await screen(tty)).toContain('read-only'));app.input('\x1b');app.input('\x1b');await vi.waitFor(()=>expect(tty.output).toContain('\x1b[?1049l'));expect(model.doStreamCalls).toHaveLength(0);app.close();
});

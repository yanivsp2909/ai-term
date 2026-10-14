import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { buildBashEnv } from '../src/daemon/env.js';
import { killAllBash } from '../src/agent/bash.js';
import { createTheme } from '../src/client/tui/theme.js';
import { catalogTokens, extensionTokens, type ExtensionAccess, type ExtensionFile, type ExtensionItem } from '../src/shared/extensions.js';
import type { AgentStatus, Reporter, TokenUsage } from '../src/agent/report.js';
import { stubFacts } from './fixtures/agent-facts.js';

const roots:string[]=[];
afterEach(async()=>{killAllBash();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const usage=(input=100,output=10)=>({inputTokens:{total:input,noCache:input,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:output,text:output,reasoning:undefined}});
const call=(toolName:string,input:unknown)=>({stream:convertArrayToReadableStream([{type:'stream-start' as const,warnings:[]},{type:'tool-call' as const,toolCallId:'call-'+Math.random(),toolName,input:JSON.stringify(input)},{type:'finish' as const,finishReason:{unified:'tool-calls' as const,raw:undefined},usage:usage()}])});
const text=(delta:string)=>({stream:convertArrayToReadableStream([{type:'stream-start' as const,warnings:[]},{type:'text-start' as const,id:'t'},{type:'text-delta' as const,id:'t',delta},{type:'text-end' as const,id:'t'},{type:'finish' as const,finishReason:{unified:'stop' as const,raw:undefined},usage:usage()}])});
type Steps=NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'];
class Catalog implements ExtensionAccess {
  files:ExtensionFile[]=[]; reads:string[]=[];
  constructor(){this.add('skill','careful','Use careful edits','PRIVATE SKILL BODY');this.add('agent','reviewer','Review a diff','PRIVATE AGENT INSTRUCTIONS');this.add('command','greet','Greet someone','Say hello to $ARGUMENTS');this.add('command','help','Clash','NEVER USE THIS');}
  add(kind:ExtensionItem['kind'],name:string,description:string,body:string,model?:string){const id=this.files.length.toString(16).padStart(16,'0'),item:ExtensionItem={id,kind,name,description,enabled:true,source:'shared',tokens:kind==='command'?0:extensionTokens(`${kind} ${name}: ${description}\n`),...(model?{model}:{})};this.files.push({item,body,text:body});}
  async list(){const items=this.files.map(f=>({...f.item}));return {items,notes:[],tokens:catalogTokens(items)};}
  async read(_cwd:string,id:string){this.reads.push(id);const file=this.files.find(f=>f.item.id===id);if(!file)throw new Error('unavailable');return {...file,item:{...file.item}};}
  async toggle(_cwd:string,id:string,enabled:boolean){const f=this.files.find(f=>f.item.id===id);if(!f)throw new Error('unavailable');f.item.enabled=enabled;return this.list();}
}
class Recorder implements Reporter,AgentIO {
  statuses:AgentStatus[]=[];usages:{model:string;tokens:TokenUsage}[]=[];notes:string[]=[];approvals:{title:string;body:string}[]=[];pauses:string[]=[];output='';
  current=stubFacts({model:'m1',price:{input:1,output:1},output:1000});
  async facts(model:string){return {...this.current,model};}
  async status(s:AgentStatus){this.statuses.push(s);}
  async usage(model:string,tokens:TokenUsage){this.usages.push({model,tokens});}
  text(s:string){this.output+=s;}toolStart(){}toolEnd(){}
  async approve(r:{title:string;body:string}){this.approvals.push(r);return true;}
  note(s:string){this.notes.push(s);}
  async pause(s:string){this.pauses.push(s);return false;}
}
async function setup(steps:Steps){const root=await realpath(await mkdtemp(join(tmpdir(),'ai-ext-turn-')));roots.push(root);const catalog=new Catalog(),recorder=new Recorder(),model=new MockLanguageModelV4({doStream:steps});const options={root,permission:'ask' as const,model,modelId:'m1',instructions:{text:'PROJECT INSTRUCTIONS',files:[],notes:[]},reporter:recorder,transcript:new Transcript(null,s=>s,()=>{}),io:recorder,redact:(s:string)=>s,bashEnv:buildBashEnv(process.env),rg:null,extensions:catalog,models:['m1']};return {root,catalog,recorder,model,options,agent:new Agent(options)};}
const signal=()=>new AbortController().signal;
const prompt=(m:MockLanguageModelV4,n:number)=>JSON.stringify(m.doStreamCalls[n]?.prompt);

it('lists only skill metadata, then loads the body through skill on use',async()=>{
  const a=await setup([call('skill',{name:'careful'}),text('Used it.')]);
  expect(await a.agent.turn('Use careful',signal())).toBe('done');
  expect(prompt(a.model,0)).toContain('skill careful: Use careful edits');expect(prompt(a.model,0)).not.toContain('PRIVATE SKILL BODY');expect(prompt(a.model,1)).toContain('PRIVATE SKILL BODY');
  expect(a.catalog.reads).toEqual(['0000000000000000']);expect(a.recorder.approvals).toEqual([]);
});

it('a disabled skill is absent and cannot load; changing toggles clears previously loaded bodies',async()=>{
  const a=await setup([call('skill',{name:'careful'}),text('first'),text('second'),call('skill',{name:'careful'}),text('off')]);
  await a.agent.turn('first',signal());await a.catalog.toggle(a.root,'0000000000000000',false);
  await a.agent.turn('second',signal());expect(prompt(a.model,2)).not.toContain('PRIVATE SKILL BODY');expect(prompt(a.model,2)).not.toContain('skill careful:');
  await a.agent.turn('load disabled',signal());expect(prompt(a.model,4)).toContain('disabled or unavailable');expect(a.catalog.reads).toHaveLength(1);
  expect(a.recorder.notes.some(n=>n.includes('conversation cleared'))).toBe(true);
});

it('runs a subagent as its own conversation, asks in the parent, counts cost/caps, and returns only its final answer',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'Review the tiny file'}),call('write',{path:'tiny.txt',content:'one line'}),text('FINAL REVIEW'),text('Parent done')]);
  expect(await a.agent.turn('review',signal())).toBe('done');expect(await readFile(join(a.root,'tiny.txt'),'utf8')).toBe('one line');
  expect(a.recorder.approvals.map(r=>r.title)).toEqual(['task reviewer','write tiny.txt']);expect(a.recorder.approvals[0]?.body).toContain('estimated');
  expect(prompt(a.model,1)).toContain('PRIVATE AGENT INSTRUCTIONS');expect(prompt(a.model,1)).not.toContain('reviewer: Review a diff",');
  expect(prompt(a.model,3)).toContain('FINAL REVIEW');expect(prompt(a.model,3)).not.toContain('PRIVATE AGENT INSTRUCTIONS');expect(prompt(a.model,3)).not.toContain('wrote tiny.txt');
  expect(a.recorder.output).not.toContain('FINAL REVIEW');expect(a.agent.limits.turns).toBe(4);expect(a.agent.limits.spent).toBeCloseTo(0.00044,8);expect(a.recorder.usages).toHaveLength(4);
  expect(a.recorder.statuses.filter(s=>s.event==='done')).toEqual([{event:'done',reply:'Parent done'}]);
});

it('child tool calls share the folder jail and cannot spawn another task',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'try escape'}),call('write',{path:'../escape.txt',content:'bad'}),text('refused'),text('parent')]);
  await a.agent.turn('go',signal());expect(a.recorder.approvals.map(r=>r.title)).toEqual(['task reviewer']);expect(prompt(a.model,2)).toContain('Path is outside the folder');
  expect(a.model.doStreamCalls[1]?.tools?.map(t=>t.type==='function'?t.name:'')).not.toContain('task');
});

it('maps an agent model only to keyed models, else uses the parent',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'review'}),text('parent')]);const child=new MockLanguageModelV4({doStream:[text('child')]});const requested=a.catalog.files[1];if(!requested)throw new Error('missing');requested.item.model='m2';
  const made:string[]=[];const agent=new Agent({...a.options,models:['m1','m2'],makeModel:async id=>{made.push(id);return child;}});
  await agent.turn('go',signal());expect(made).toEqual(['m2']);expect(a.recorder.usages.map(u=>u.model)).toEqual(['m2','m1','m1']);
  const b=await setup([call('task',{name:'reviewer',prompt:'review'}),text('child'),text('parent')]);const fallback=b.catalog.files[1];if(!fallback)throw new Error('missing');fallback.item.model='unkeyed';await b.agent.turn('go',signal());expect(b.recorder.usages.every(u=>u.model==='m1')).toBe(true);
});

it('parent caps include child requests and reserve the parent request before child spending',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'review'}),text('child'),text('never')]);a.recorder.current.caps={turns:2,spendUsd:null};
  expect(await a.agent.turn('go',signal())).toBe('interrupted');expect(a.model.doStreamCalls).toHaveLength(2);expect(a.recorder.pauses[0]).toContain('2 turns');expect(a.agent.limits.turns).toBe(2);
  const b=await setup([call('task',{name:'reviewer',prompt:'review'}),text('never')]);b.recorder.current.caps={turns:null,spendUsd:0.004};
  // Each request fits individually, but the held parent request plus the child request does not.
  await b.agent.turn('go',signal());expect(b.recorder.pauses.some(p=>p.includes('cap reached'))).toBe(true);expect(b.agent.limits.reserved).toBe(0);
});

it('slash arguments substitute literally and built-in commands win clashes',async()=>{
  const a=await setup([text('hello')]);let out='';const app=new AgentApp({screen:new Screen({write:s=>{out+=s;},columns:100,rows:30},createTheme('graphite')),permission:'ask',models:['m1'],makeModel:async()=>a.model,agent:io=>new Agent({...a.options,io}),quit:vi.fn()});
  app.start();app.input('/help\r');await vi.waitFor(()=>expect(out).toContain('/skills'));expect(a.model.doStreamCalls).toHaveLength(0);expect(out).not.toContain('NEVER USE THIS');
  app.input('/greet Ada $&\r');await vi.waitFor(()=>expect(app.running).toBe(false));expect(prompt(a.model,0)).toContain('Say hello to Ada $&');app.close();
});

it('Ctrl+K kills a child command and cancels both conversations with no queued request',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'run a command'}),call('bash',{command:'sleep 30'}),text('never'),text('never parent')]);let out='';
  const app=new AgentApp({screen:new Screen({write:s=>{out+=s;},columns:120,rows:40},createTheme('graphite')),permission:'ask',models:['m1'],makeModel:async()=>a.model,agent:io=>new Agent({...a.options,io}),quit:vi.fn()});
  app.start();app.input('go\r');await vi.waitFor(()=>expect(out).toContain('⏎ run job'));app.input('\x1b[200~\r\x1b[201~');expect(a.model.doStreamCalls).toHaveLength(1);app.input('\r');
  await vi.waitFor(()=>expect(out).toContain('allow bash'));app.input('y');await new Promise(r=>setTimeout(r,100));app.input('queued\r');app.input('\x0b');
  await vi.waitFor(()=>expect(app.running).toBe(false),{timeout:2000});expect(out).toContain('killed: the request and 1 running command');expect(a.model.doStreamCalls).toHaveLength(2);expect(killAllBash()).toBe(0);app.close();
});

it('the manifest and banner token estimate is deterministic and counts only enabled metadata',async()=>{
  const a=await setup([]),c=await a.catalog.list();expect(c.tokens).toBe(Math.ceil(Buffer.byteLength('skill careful: Use careful edits\nagent reviewer: Review a diff')/3));
  let out='';new Screen({write:s=>{out+=s;}},createTheme('graphite')).extensionsBanner(4,c.tokens);expect(out).toContain(`extensions: 4 on · ≈${c.tokens} tokens/request`);
});

it('runs the model and instructions confirmed for a task even if its file changes meanwhile',async()=>{
  const a=await setup([call('task',{name:'reviewer',prompt:'review'}),text('approved child'),text('parent')]);
  const child=new MockLanguageModelV4({doStream:[text('changed child')]}),made:string[]=[];
  a.recorder.approve=async request=>{a.recorder.approvals.push(request);const file=a.catalog.files[1];if(!file)throw new Error('missing');file.item.model='m2';file.body='CHANGED INSTRUCTIONS';return true;};
  const agent=new Agent({...a.options,models:['m1','m2'],makeModel:async id=>{made.push(id);return child;}});
  await agent.turn('go',signal());expect(a.recorder.approvals[0]?.body).toContain('AI Term · m1');expect(made).toEqual([]);
  expect(prompt(a.model,1)).toContain('PRIVATE AGENT INSTRUCTIONS');expect(prompt(a.model,1)).not.toContain('CHANGED INSTRUCTIONS');
});

it('Esc cancels a slash command that is still looking up its extension',async()=>{
  const a=await setup([text('must not run')]);let release:()=>void=()=>{};const waiting=new Promise<void>(r=>{release=r;}),original=a.catalog.list.bind(a.catalog);a.catalog.list=async()=>{await waiting;return original();};
  const app=new AgentApp({screen:new Screen({write:()=>{},columns:100,rows:30},createTheme('graphite')),permission:'ask',models:['m1'],makeModel:async()=>a.model,agent:io=>new Agent({...a.options,io}),quit:vi.fn()});
  app.start();app.input('/greet Ada\r');expect(app.running).toBe(true);app.input('\x1b');release();await vi.waitFor(()=>expect(app.running).toBe(false));expect(a.model.doStreamCalls).toHaveLength(0);app.close();
});

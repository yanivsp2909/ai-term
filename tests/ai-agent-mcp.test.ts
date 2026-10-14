import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { Agent, type AgentIO } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { createTheme } from '../src/client/tui/theme.js';
import { mcpTokens, type McpAccess, type McpCatalog, type McpView } from '../src/shared/mcp.js';
import { stubFacts } from './fixtures/agent-facts.js';
const roots:string[]=[];
afterEach(async()=>{for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
const usage={inputTokens:{total:100,noCache:100,cacheRead:undefined,cacheWrite:undefined},outputTokens:{total:10,text:10,reasoning:undefined}};
const call=(toolName:string,input:unknown)=>({stream:convertArrayToReadableStream([{type:'stream-start' as const,warnings:[]},{type:'tool-call' as const,toolCallId:'c'+Math.random(),toolName,input:JSON.stringify(input)},{type:'finish' as const,finishReason:{unified:'tool-calls' as const,raw:undefined},usage}])});
const text=()=>({stream:convertArrayToReadableStream([{type:'stream-start' as const,warnings:[]},{type:'text-start' as const,id:'t'},{type:'text-delta' as const,id:'t',delta:'done'},{type:'text-end' as const,id:'t'},{type:'finish' as const,finishReason:{unified:'stop' as const,raw:undefined},usage}])});
type Steps=NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'];
class Mcp implements McpAccess {
 server:McpView={id:'0'.repeat(16),hash:'1'.repeat(64),config:{name:'stub',type:'stdio',command:'node',args:['server.js'],env:[]},values:[],enabled:true,tools:{},source:'AI Term',approved:true,available:[]};
 calls:Record<string,unknown>[]=[];approvals:string[]=[];schemas=0;stops=0;slow=false;cancelled=false;
 async list():Promise<McpCatalog>{const c={servers:[structuredClone(this.server)],notes:[],tokens:0};c.tokens=mcpTokens(c);return c;}
 async add(){}async remove(){}async toggle(_cwd:string,_id:string,tool:string|undefined,enabled:boolean){if(tool)this.server.tools[tool]=enabled;else this.server.enabled=enabled;return this.list();}
 async approve(_cwd:string,_id:string,hash:string){this.approvals.push(hash);this.server.approved=true;}
 async discover(){this.server.available=[{name:'echo',description:'Echo a message',tokens:10,enabled:true}];return this.list();}
 async schema(){this.schemas++;return {type:'object',properties:{message:{type:'string',description:'DEFERRED SCHEMA BODY'}}};}
 async call(_cwd:string,_id:string,_hash:string,_tool:string,args:Record<string,unknown>,signal:AbortSignal){this.calls.push(args);if(this.slow)return new Promise<string>((_resolve,reject)=>{const abort=()=>{this.cancelled=true;reject(new Error('cancelled'));};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});return 'tool final result';}
 async stop(){this.stops++;}
}
async function setup(steps:Steps){const root=await realpath(await mkdtemp(join(tmpdir(),'ai-mcp-agent-')));roots.push(root);const mcp=new Mcp(),model=new MockLanguageModelV4({doStream:steps}),approvals:{title:string;body:string}[]=[],project:string[]=[];
 let choice:'allow'|'deny'|'session'='allow';const io:AgentIO={text:()=>{},toolStart:()=>{},toolEnd:()=>{},note:()=>{},pause:async()=>false,approve:async r=>{project.push(r.body);return true;},approveMcp:async r=>{approvals.push(r);return choice;}};
 const options={root,permission:'ask' as const,model,modelId:'m1',instructions:{text:'',files:[],notes:[]},reporter:{status:async()=>{},usage:async()=>{},facts:async()=>stubFacts({model:'m1',price:{input:1,output:1},output:1000})},transcript:new Transcript(null,s=>s,()=>{}),io,redact:(s:string)=>s,bashEnv:{},rg:null,mcp};return {options,mcp,model,io,approvals,project,agent:new Agent(options),choice:(v:typeof choice)=>{choice=v;}};}
const select=()=>call('mcp_tools',{server:'stub',tool:'echo'});
const invoke=()=>call('mcp_call',{server:'stub',tool:'echo',arguments:{message:'hello'}});
const prompt=(model:MockLanguageModelV4,n:number)=>JSON.stringify(model.doStreamCalls[n]?.prompt);
it('lists metadata, defers the full schema, and asks with server, tool and arguments even in Dont ask',async()=>{
 const f=await setup([call('mcp_tools',{server:'stub'}),select(),invoke(),text()]),agent=new Agent({...f.options,permission:'dontAsk'});
 expect(await agent.turn('go',new AbortController().signal)).toBe('done');expect(prompt(f.model,0)).toContain('mcp server stub: stdio');expect(prompt(f.model,0)).not.toContain('DEFERRED SCHEMA BODY');expect(prompt(f.model,1)).toContain('Echo a message');expect(prompt(f.model,1)).not.toContain('DEFERRED SCHEMA BODY');expect(prompt(f.model,2)).toContain('DEFERRED SCHEMA BODY');
 expect(f.approvals).toHaveLength(1);expect(f.approvals[0]?.body).toContain('server: stub\ntool: echo\narguments:');expect(f.approvals[0]?.body).toContain('hello');expect(f.mcp.calls).toEqual([{message:'hello'}]);expect(agent.limits.turns).toBe(4);expect(agent.limits.spent).toBeCloseTo(0.00044);
});
it('denial prevents execution; session allow is only for the selected tool in this agent session',async()=>{
 const denied=await setup([select(),invoke(),text()]);denied.choice('deny');await denied.agent.turn('go',new AbortController().signal);expect(denied.mcp.calls).toEqual([]);expect(prompt(denied.model,2)).toContain('user denied');
 const allowed=await setup([select(),invoke(),invoke(),text(),select(),invoke(),text()]);allowed.choice('session');await allowed.agent.turn('go',new AbortController().signal);expect(allowed.approvals).toHaveLength(1);expect(allowed.mcp.calls).toHaveLength(2);
 await new Agent(allowed.options).turn('fresh session',new AbortController().signal);expect(allowed.approvals).toHaveLength(2);
});
it('requires a selected schema, removes disabled metadata and updates token totals',async()=>{
 const f=await setup([invoke(),text(),text()]);await f.agent.turn('call',new AbortController().signal);expect(f.mcp.calls).toEqual([]);expect(f.approvals).toEqual([]);expect(prompt(f.model,1)).toContain('Load this MCP tool schema');
 const before=(await f.mcp.list()).tokens;expect(before).toBe(Math.ceil(Buffer.byteLength('mcp server stub: stdio')/3));f.mcp.server.enabled=false;expect((await f.mcp.list()).tokens).toBe(0);await f.agent.turn('off',new AbortController().signal);expect(prompt(f.model,2)).not.toContain('mcp server stub:');
});
it('project approval is shown once per hash and again after an entry changes',async()=>{
 const f=await setup([select(),text(),select(),text(),select(),text()]);f.mcp.server.source='this project';f.mcp.server.approved=false;
 await f.agent.turn('go',new AbortController().signal);await f.agent.turn('again',new AbortController().signal);expect(f.project).toHaveLength(1);expect(f.project[0]).toContain('command: "node"\nargs: ["server.js"]');
 f.mcp.server.hash='2'.repeat(64);f.mcp.server.approved=false;await f.agent.turn('changed',new AbortController().signal);expect(f.project).toHaveLength(2);expect(f.mcp.approvals).toEqual(['1'.repeat(64),'2'.repeat(64)]);
});
it('refuses a changed server after tool approval instead of calling the replacement',async()=>{
 const f=await setup([select(),invoke(),text()]);f.io.approveMcp=async()=>{f.mcp.server.hash='2'.repeat(64);return 'allow';};await f.agent.turn('go',new AbortController().signal);expect(f.mcp.calls).toEqual([]);expect(prompt(f.model,2)).toContain('configuration changed');
});
it('Ctrl+K cancels a slow MCP tool, stops the owner, and exit stops it before quitting',async()=>{
 const f=await setup([select(),invoke(),text()]);f.mcp.slow=true;let output='';const quit=vi.fn();const app=new AgentApp({screen:new Screen({write:s=>{output+=s;},columns:120,rows:40},createTheme('graphite')),permission:'ask',models:['m1'],makeModel:async()=>f.model,agent:io=>new Agent({...f.options,io}),quit});
 app.start();app.input('go\r');await vi.waitFor(()=>expect(output).toContain('allow MCP'));app.input('y');await vi.waitFor(()=>expect(f.mcp.calls).toHaveLength(1));app.input('\x0b');await vi.waitFor(()=>expect(app.running).toBe(false));expect(f.mcp.cancelled).toBe(true);expect(f.mcp.stops).toBe(1);expect(f.model.doStreamCalls).toHaveLength(2);app.close();await vi.waitFor(()=>expect(quit).toHaveBeenCalledOnce());expect(f.mcp.stops).toBe(2);
});
it('Ctrl+K also stops idle connections and pending popup discovery without a model turn',async()=>{
 const f=await setup([]);let output='',cancel:()=>void=()=>{},pending=false;f.mcp.stop=async()=>{f.mcp.stops++;cancel();};f.mcp.discover=async()=>{pending=true;return new Promise((_resolve,reject)=>{cancel=()=>reject(new Error('stopped'));});};const app=new AgentApp({screen:new Screen({write:s=>{output+=s;},columns:120,rows:40},createTheme('graphite')),permission:'ask',models:['m1'],makeModel:async()=>f.model,agent:io=>new Agent({...f.options,io,extensions:{list:async()=>({items:[],notes:[],tokens:0}),read:async()=>{throw new Error('unused');},toggle:async()=>({items:[],notes:[],tokens:0})}}),quit:vi.fn()});app.start();app.input('\x0b');expect(f.mcp.stops).toBe(1);app.input('/mcp\r');await vi.waitFor(()=>expect(output).toContain('[MCP]'));app.input('d');await vi.waitFor(()=>expect(pending).toBe(true));app.input('\x0b');expect(f.mcp.stops).toBe(2);await vi.waitFor(()=>expect(output).toContain('MCP operation failed'));expect(f.model.doStreamCalls).toHaveLength(0);app.close();
});
it('first discovery preserves the original task on follow-up; explicit tool switches still clear old schema content',async()=>{
 const f=await setup([call('mcp_tools',{server:'stub'}),select(),text(),text(),text()]);await f.agent.turn('FIRST TASK MUST REMAIN',new AbortController().signal);await f.agent.turn('continue',new AbortController().signal);expect(prompt(f.model,3)).toContain('FIRST TASK MUST REMAIN');expect(prompt(f.model,3)).toContain('DEFERRED SCHEMA BODY');f.mcp.server.tools.echo=false;await f.agent.turn('disabled',new AbortController().signal);expect(prompt(f.model,4)).not.toContain('DEFERRED SCHEMA BODY');
});

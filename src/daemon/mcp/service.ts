import { homedir } from 'node:os';
import { realpath } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import type { SettingsStore } from '../settings.js';
import type { KeyStore } from '../keys.js';
import type { Logger } from '../log.js';
import { parseMcpRequest, validateMcpServer, validateMcpCatalog, validateMcpConfig } from '../../shared/validate.js';
import { mcpContains, mcpTokens, type McpServer, type McpCatalog, type McpView } from '../../shared/mcp.js';
import { hashMcp, projectMcp } from './project.js';
import { McpRuntime, mcpConnector, type McpConnect } from './runtime.js';

// One service shared by the socket and engine-bound requests. Metadata never starts servers; owners are live agents.
// v1.0.7 /reverse: an add-on agent's own server (REA), approved by its popup's y. That agent sees only it, as Claude Code
// does with --strict-mcp-config; no other agent ever sees it, and it ends with the session.
export interface SessionMcp {command:string;args:string[]}
export class McpService {
 private sessions=new Map<string,McpServer>();
 private requests=new Map<string,Set<AbortController>>();private runtime:McpRuntime;private queue:Promise<unknown>=Promise.resolve();
 constructor(private settings:SettingsStore,private keys:KeyStore,private log:Logger,private home=homedir(),connect?:McpConnect){this.runtime=new McpRuntime(keys,connect??mcpConnector(keys),()=>log.error('MCP server stop failed'));}
 // A value left behind by a failed rollback is logged by account name (never a value), so it can be removed by hand.
 private async rollback(id:string,names:string[]):Promise<void>{try{await this.keys.removeMcp(id,names);}catch{this.log.error(`MCP keychain cleanup failed: remove ai-term accounts mcp:${id}:* in Keychain Access`);}}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work);this.queue=next.then(()=>undefined,()=>undefined);return next;}
 session(owner:string,server:SessionMcp):void{
  const id=hashMcp({session:owner}).slice(0,16),config=validateMcpConfig({name:'rea',type:'stdio',command:server.command,args:server.args,env:[]});
  this.sessions.set(owner,validateMcpServer({id,config,hash:hashMcp({id,config}),enabled:true,values:[],tools:{}}));
 }
 endSession(owner:string):void{this.sessions.delete(owner);}
 async list(cwd:string,owner?:string):Promise<McpCatalog>{
  const own=owner?this.sessions.get(owner):undefined;
  if(own){const catalog={servers:[{...own,source:'this session' as const,approved:true,available:this.runtime.available(own),...(this.runtime.note(own)?{note:this.runtime.note(own)}:{})}],notes:[],tokens:0};catalog.tokens=mcpTokens(catalog);return validateMcpCatalog(catalog);}
  const root=await realpath(cwd),settings=await this.settings.get(),servers:McpView[]=[],notes:string[]=[];
  let project:ReturnType<typeof projectMcp>={entries:[],notes:[]};try{project=projectMcp(this.home,root);}catch{notes.push('MCP project file unavailable or malformed');this.log.error('MCP project file skipped');}
  notes.push(...project.notes);const names=new Set<string>();
  for(const p of project.entries){const s=p.server,override=settings.mcpOverrides?.[s.id];const merged={...s,enabled:override?.enabled??s.enabled,tools:override?.tools??{}};names.add(s.config.name);servers.push({...merged,source:'this project',approved:settings.mcpApprovals?.[s.id]===s.hash,available:this.runtime.available(merged),...((p.note??this.runtime.note(s))?{note:p.note??this.runtime.note(s)}:{})});}
  for(const s of settings.mcp??[]){if(names.has(s.config.name))continue;const valid=s.hash===hashMcp({id:s.id,config:s.config});servers.push({...s,source:'AI Term',approved:valid,available:this.runtime.available(s),...(!valid?{note:'MCP configuration changed; add it again'}:this.runtime.note(s)?{note:this.runtime.note(s)}:{})});}
  const catalog={servers,notes,tokens:0};catalog.tokens=mcpTokens(catalog);return validateMcpCatalog(catalog);
 }
 private async selected(owner:string,cwd:string,id:string,hash?:string,tool?:string,allowDisabled=false):Promise<McpView>{const s=(await this.list(cwd,owner)).servers.find(s=>s.id===id);if(!s||!allowDisabled&&s.note||hash!==undefined&&s.hash!==hash||!allowDisabled&&(!s.enabled||tool!==undefined&&s.tools[tool]===false))throw new Error('MCP server or tool unavailable');return s;}
 async query(owner:string,raw:unknown):Promise<{mcp?:McpCatalog;mcpSchema?:Record<string,unknown>;mcpResult?:string}>{
  let controller:AbortController|undefined;
  try{
   const r=parseMcpRequest(raw);
   if(['mcp.discover','mcp.schema','mcp.call'].includes(r.kind)){controller=new AbortController();const pending=this.requests.get(owner)??new Set<AbortController>();pending.add(controller);this.requests.set(owner,pending);}
   if(r.kind==='mcp.stop'||r.kind==='mcp.cancel'){await this.stop(owner);return {};}
   if(r.kind==='mcp.add')return this.serial(async()=>{
    const settings=await this.settings.get();if((settings.mcp??[]).some(s=>s.config.name===r.config.name))throw new Error('MCP name already exists');
    // Values cannot hide in public argv/URL/metadata, even if the form also marks that value secret.
    if(Object.values(r.values).some(v=>mcpContains(r.config,v)))throw new Error('MCP value duplicated in configuration');
    const id=randomBytes(8).toString('hex'),hash=hashMcp({id,config:r.config}),names=r.config.type==='stdio'?r.config.env:r.config.headers,values:McpServer['values']=[],written:string[]=[];
    try{for(const name of names){values.push({name,last4:await this.keys.saveMcp(id,name,r.values[name]??'',hash)});written.push(name);}
     const server=validateMcpServer({id,config:r.config,hash,values,enabled:true,tools:{}});await this.settings.update(async s=>({...s,mcp:[...s.mcp??[],server]}));
    }catch{if(written.length)await this.rollback(id,written);throw new Error('MCP server could not be saved');}return {};
   });
   if(r.kind==='mcp.remove')return this.serial(async()=>{const settings=await this.settings.get(),s=settings.mcp?.find(s=>s.config.name===r.name);if(!s)throw new Error('MCP server not found');await this.runtime.stopServer(s.id);await this.keys.removeMcp(s.id,s.values.map(v=>v.name));await this.settings.update(async s=>({...s,mcp:s.mcp?.filter(server=>server.config.name!==r.name)}));return {};});
   if(r.kind==='mcp.list')return {mcp:await this.list(r.cwd,owner)};
   const cwd=await realpath(r.cwd),s=await this.selected(owner,cwd,r.serverId,'hash'in r?r.hash:undefined,'tool'in r?r.tool:undefined,r.kind==='mcp.toggle');
   // A session's server is fixed by its popup: nothing to switch or approve.
   if(s.source==='this session'&&(r.kind==='mcp.toggle'||r.kind==='mcp.approve'))throw new Error('MCP operation unavailable');
   if(r.kind==='mcp.toggle'){
    await this.settings.update(async settings=>{if(s.source==='AI Term')return {...settings,mcp:settings.mcp?.map(server=>server.id!==s.id?server:r.tool?{...server,tools:{...server.tools,[r.tool]:r.enabled}}:{...server,enabled:r.enabled})};const current=settings.mcpOverrides?.[s.id]??{tools:{}};return {...settings,mcpOverrides:{...settings.mcpOverrides,[s.id]:r.tool?{...current,tools:{...current.tools,[r.tool]:r.enabled}}:{...current,enabled:r.enabled}}};});if(!r.enabled&&!r.tool)await this.runtime.stopServer(s.id);return {mcp:await this.list(cwd)};
   }
   if(r.kind==='mcp.approve'){
    if(s.source==='this project')await this.serial(async()=>{const p=projectMcp(this.home,cwd).entries.find(p=>p.server.id===s.id&&p.server.hash===r.hash&&!p.note);if(!p)throw new Error('MCP project changed');
     await this.runtime.stopServer(s.id);const written:string[]=[];try{for(const [name,value]of Object.entries(p.secrets)){await this.keys.saveMcp(s.id,name,value,s.hash);written.push(name);}await this.settings.update(async settings=>({...settings,mcpApprovals:{...settings.mcpApprovals,[s.id]:s.hash}}));}catch{if(written.length)await this.rollback(s.id,written);throw new Error('MCP project approval failed');}
    });return {};
   }
   if(!s.approved)throw new Error('MCP project server needs approval');
   if(!controller||controller.signal.aborted)throw new Error('MCP operation cancelled');
   if(r.kind==='mcp.discover'){
    try{await this.runtime.discover(owner,cwd,s,controller.signal);return {mcp:await this.list(cwd,owner)};}finally{if(owner==='homepage')await this.runtime.stop(owner);}
   }
   if(r.kind==='mcp.schema')return {mcpSchema:await this.runtime.schema(owner,cwd,s,r.tool,controller.signal)};
   if(r.kind==='mcp.call')return {mcpResult:await this.runtime.call(owner,cwd,s,r.tool,r.arguments,controller.signal)};
   throw new Error('MCP operation unavailable');
  }catch{this.log.error('MCP operation failed');throw new Error('MCP operation failed; check configuration or approval');}finally{if(controller){const pending=this.requests.get(owner);pending?.delete(controller);if(pending?.size===0)this.requests.delete(owner);}}
 }
 // The daemon is exiting: every owner's requests and servers stop before it returns, or detached stdio groups outlive it.
 async shutdown():Promise<void>{for(const pending of this.requests.values())for(const controller of pending)controller.abort();this.requests.clear();await this.runtime.stopAll();}
 stop(owner:string):Promise<void>{for(const controller of this.requests.get(owner)??[])controller.abort();this.requests.delete(owner);return this.runtime.stop(owner);}
}

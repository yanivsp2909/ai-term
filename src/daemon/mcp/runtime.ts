import type { MCPClient, MCPTransport, ListToolsResult } from '@ai-sdk/mcp';
// Loaded on use (v0.9.3 performance pass), like the AI SDK in handoff.ts.
async function createMCPClient(config: import('@ai-sdk/mcp').MCPClientConfig & { experimental_events?: { adapter?: never } }): Promise<MCPClient> { const { createMCPClient: create } = await import('@ai-sdk/mcp'); const client: MCPClient = await create(config); return client; }
import { tmpdir } from 'node:os';
import { McpStdio } from './stdio.js';
import type { KeyStore } from '../keys.js';
import { MCP_MESSAGE_BYTES, MCP_MAX_TOOLS, mcpSecretForms, type McpServer, type McpTool } from '../../shared/mcp.js';
import { isMcpTool, validateMcpObject } from '../../shared/validate.js';
import { extensionTokens } from '../../shared/extensions.js';
import { cutText } from '../../shared/text-cut.js';

export const mcpEnv=(cwd:string,values:Record<string,string>):Record<string,string>=>({PATH:'/usr/bin:/bin:/usr/sbin:/sbin:/usr/local/bin:/opt/homebrew/bin',HOME:cwd,TMPDIR:tmpdir(),LANG:'C.UTF-8',TERM:'dumb',...values});
const scrub=(text:string,values:Record<string,string>)=>Object.values(values).flatMap(mcpSecretForms).sort((a,b)=>b.length-a.length).reduce((out,value)=>out.split(value).join('[redacted]'),text);
function scrubObject(value:unknown,values:Record<string,string>):unknown {
 if(typeof value==='string')return scrub(value,values);
 if(Array.isArray(value))return value.map(v=>scrubObject(v,values));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,v])=>[scrub(key,values),scrubObject(v,values)]));
 return value;
}
export type McpConnect=(server:McpServer,cwd:string,signal:AbortSignal)=>Promise<{client:MCPClient;transport?:MCPTransport;needsLogin?:()=>boolean}>;
class McpLoginError extends Error {}
export function mcpConnector(keys:KeyStore,fetchFn:typeof fetch=fetch):McpConnect{return async(server,cwd,signal)=>{
 const config=server.config;
 if(config.type==='stdio')return keys.withMcp(server.id,config.env,server.hash,async values=>{
  if(signal.aborted)throw new Error('MCP connection cancelled');const transport=new McpStdio(config.command,config.args,cwd,mcpEnv(cwd,values));
  try{return {client:await createMCPClient({transport,protocolVersionDiscovery:false,initializationOptions:{signal,timeout:5000},onUncaughtError:()=>{}}),transport};}catch{await transport.close();throw new Error('MCP server unavailable');}
 });
 let login=false;const guarded:typeof fetch=async(input,init)=>{
  if(signal.aborted)throw new Error('MCP connection cancelled');const url=input instanceof Request?input.url:String(input);if(url!==config.url)throw new Error('MCP destination refused');
  return keys.withMcp(server.id,config.headers,server.hash,async values=>{
   const headers=new Headers(init?.headers);for(const [name,value]of Object.entries(values))headers.set(name,value);
   const response=await fetchFn(config.url,{...init,headers,redirect:'error',signal:AbortSignal.any([signal,...(init?.signal?[init.signal]:[])])});
   if(response.status===401||response.status===403){login=true;throw new McpLoginError('needs login, not supported yet');}
   if(response.status>=300&&response.status<400)throw new Error('MCP redirect refused');
   if(!response.body)return response;
   const reader=response.body.getReader();let count=0;
   const body=new ReadableStream<Uint8Array>({async pull(controller){try{const result=await reader.read();if(result.done){controller.close();return;}count+=result.value.byteLength;if(count>MCP_MESSAGE_BYTES){await reader.cancel();controller.error(new Error('MCP reply too large'));return;}controller.enqueue(result.value);}catch{controller.error(new Error('MCP request failed'));}},cancel:()=>reader.cancel()});
   return new Response(body,{status:response.status,statusText:'',headers:response.headers});
  });
 };
 try{return {client:await createMCPClient({transport:{type:'http',url:config.url,fetch:guarded,redirect:'error'},protocolVersionDiscovery:false,initializationOptions:{signal,timeout:5000},onUncaughtError:()=>{}}),needsLogin:()=>login};}catch{if(login)throw new McpLoginError('needs login, not supported yet');throw new Error('MCP server unavailable');}
};}
interface Connection { client:MCPClient; transport?:MCPTransport; server:McpServer; schema:Map<string,Record<string,unknown>>; controller:AbortController; needsLogin?:()=>boolean }
export class McpRuntime {
 private connections=new Map<string,{pending:Promise<Connection>;controller:AbortController;serverId:string}>();private metadata=new Map<string,McpTool[]>();private logins=new Set<string>();
 constructor(private keys:KeyStore,private connect:McpConnect=mcpConnector(keys),private onFailure:()=>void=()=>{}){}
 note(server:McpServer):string|undefined{return this.logins.has(server.hash)?'needs login, not supported yet':undefined;}
 available(server:McpServer):McpTool[]{return (this.metadata.get(server.hash)??[]).map(t=>({...t,enabled:server.enabled&&server.tools[t.name]!==false}));}
 private async connection(owner:string,cwd:string,server:McpServer,signal:AbortSignal):Promise<Connection>{
  const key=JSON.stringify([owner,cwd,server.hash]);let entry=this.connections.get(key);
  if(!entry){const controller=new AbortController();const abort=()=>controller.abort();signal.addEventListener('abort',abort,{once:true});if(signal.aborted)controller.abort();
   const pending=this.connect(server,cwd,controller.signal).then(c=>({...c,server,schema:new Map<string,Record<string,unknown>>(),controller}));entry={pending,controller,serverId:server.id};this.connections.set(key,entry);
   try{return await pending;}catch(error){this.connections.delete(key);controller.abort();if(error instanceof McpLoginError)this.logins.add(server.hash);throw new Error(this.note(server)??'MCP server unavailable',{cause:error});}finally{signal.removeEventListener('abort',abort);}
  }
  const connection=await entry.pending;if(signal.aborted||connection.controller.signal.aborted)throw new Error('MCP call cancelled');return connection;
 }
 async discover(owner:string,cwd:string,server:McpServer,signal:AbortSignal):Promise<void>{
  const c=await this.connection(owner,cwd,server,signal),names=server.config.type==='stdio'?server.config.env:server.config.headers;
  try{await this.keys.withMcp(server.id,names,server.hash,async values=>{
   const result:ListToolsResult=await c.client.listTools({options:{signal,timeout:5000}});if(result.tools.length>MCP_MAX_TOOLS||result.nextCursor)throw new Error('MCP catalog too large');
   c.schema.clear();const tools:McpTool[]=[];for(const raw of result.tools){const name=scrub(raw.name,values);if(!isMcpTool(name)||name!==raw.name||c.schema.has(name))continue;
    const text=scrub(raw.description??'',values).replace(/[\p{C}]/gu,' ').replace(/\s+/g,' ');const description=cutText(text,240);
    const schema=validateMcpObject(scrubObject(raw.inputSchema,values));c.schema.set(name,schema);tools.push({name,description,enabled:true,tokens:extensionTokens(`mcp ${server.config.name}/${name}: ${description}\n`)});
   }this.metadata.set(server.hash,tools);
  });}finally{if(c.needsLogin?.())this.logins.add(server.hash);}
 }
 async schema(owner:string,cwd:string,server:McpServer,tool:string,signal:AbortSignal):Promise<Record<string,unknown>>{const c=await this.connection(owner,cwd,server,signal);if(!c.schema.size)await this.discover(owner,cwd,server,signal);const schema=c.schema.get(tool);if(!schema)throw new Error('MCP tool unavailable');return schema;}
 async call(owner:string,cwd:string,server:McpServer,tool:string,args:Record<string,unknown>,signal:AbortSignal):Promise<string>{
  // A cancel or Ctrl+K drops the connection with its schemas while the agent still holds the tool it selected: reconnect
  // and list again rather than fail every later call. The agent's own gate still required the schema first.
  const c=await this.connection(owner,cwd,server,signal);if(!c.schema.size)await this.discover(owner,cwd,server,signal);if(!c.schema.has(tool))throw new Error('MCP schema must be selected first');
  const names=server.config.type==='stdio'?server.config.env:server.config.headers;
  return this.keys.withMcp(server.id,names,server.hash,async values=>{
   const abort=()=>{c.controller.abort();void c.transport?.close();};signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
   try{const result=await c.client.callTool({name:tool,arguments:args,options:{signal,timeout:120_000}});if(result.isError)throw new Error('MCP tool failed');const output=JSON.stringify(scrubObject(result,values));return Buffer.byteLength(output)<=64*1024?output:'MCP result exceeded the size limit';}
   finally{signal.removeEventListener('abort',abort);if(c.needsLogin?.())this.logins.add(server.hash);}
  });
 }
 async stopServer(id:string):Promise<void>{await this.closeEntries([...this.connections].filter(([,e])=>e.serverId===id));}
 async stopAll():Promise<void>{await this.closeEntries([...this.connections]);}
 async stop(owner:string):Promise<void>{await this.closeEntries([...this.connections].filter(([key])=>JSON.parse(key)[0]===owner));}
 private async closeEntries(entries:[string,{pending:Promise<Connection>;controller:AbortController;serverId:string}][]):Promise<void>{for(const [key,entry]of entries){this.connections.delete(key);entry.controller.abort();}
  await Promise.all(entries.map(async([,entry])=>{try{const c=await entry.pending;c.controller.abort();await c.transport?.close();await c.client.close();}catch{this.onFailure();}}));
 }
}

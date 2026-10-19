import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SettingsStore } from '../src/daemon/settings.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { Logger } from '../src/daemon/log.js';
import { McpService } from '../src/daemon/mcp/service.js';
import { mcpConnector, mcpEnv } from '../src/daemon/mcp/runtime.js';
import { validateMcpConfig, validateMcpRequest } from '../src/shared/validate.js';
import type { McpView } from '../src/shared/mcp.js';
import { processRuns } from './platform.js';

const roots:string[]=[],services:McpService[]=[];
afterEach(async()=>{for(const s of services.splice(0))await s.stop('agent');for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});vi.unstubAllEnvs();});
async function fixture(fetchFn?:typeof fetch){
 const home=await realpath(await mkdtemp(join(tmpdir(),'ai-mcp-')));roots.push(home);const cwd=join(home,'work'),state=join(home,'state');await mkdir(cwd);await mkdir(state);
 const values=new Map<string,string>(),vault:KeyVault={read:async n=>values.get(n)??null,write:async(n,v)=>{values.set(n,v);},remove:async n=>{values.delete(n);}},keys=new KeyStore(state,{vault}),settings=new SettingsStore(state),log=new Logger(join(state,'logs/daemon.log'));
 const service=new McpService(settings,keys,log,home,mcpConnector(keys,fetchFn));services.push(service);return {home,cwd,state,keys,settings,values,service};
}
async function first(service:McpService,cwd:string):Promise<McpView>{const s=(await service.list(cwd)).servers[0];if(!s)throw new Error('missing server');return s;}
const rpc=(id:unknown,result:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id,result}),{headers:{'content-type':'application/json'}});
const tools=[{name:'echo',description:'Echo a message',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}];
const initialized={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stub',version:'1'}};
it('stdio gets only a minimal base and its configured value; secrets stay in the Keychain stub and are scrubbed from results',async()=>{
 const f=await fixture(),path=join(f.cwd,'server.mjs'),secret='MCP-pr' + 'ivate-value-1234567890';
 await writeFile(path,`import {createInterface} from 'node:readline';const rl=createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result=m.method==='initialize'?${JSON.stringify(initialized)}:m.method==='tools/list'?{tools:${JSON.stringify(tools)}}:{content:[{type:'text',text:JSON.stringify(process.env)}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
 vi.stubEnv('AITERM_AGENT_KEY','agent-private');vi.stubEnv('OPENAI_API_KEY','provider-private');vi.stubEnv('AI_TERM_CANARY','private');
 await f.service.query('agent',{kind:'mcp.add',config:{name:'local',type:'stdio',command:process.execPath,args:[path],env:['SERVER_TOKEN']},values:{SERVER_TOKEN:secret}});
 const s=await first(f.service,f.cwd);expect(s.values).toEqual([{name:'SERVER_TOKEN',last4:'7890'}]);expect([...f.values.values()].join()).toContain(secret);
 await f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash});
 const result=await f.service.query('agent',{kind:'mcp.call',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo',arguments:{message:'hi'}});
 expect(result.mcpResult).toContain('[redacted]');for(const field of ['AITERM_AGENT_KEY','OPENAI_API_KEY','AI_TERM_CANARY',secret])expect(result.mcpResult).not.toContain(field);
 expect(await readFile(join(f.state,'settings.json'),'utf8')).not.toContain(secret);const log=await readFile(join(f.state,'logs/daemon.log'),'utf8').catch(()=> '');expect(log).not.toContain(secret);
 expect(mcpEnv(f.cwd,{})).not.toHaveProperty('AITERM_AGENT_KEY');
});
it('HTTP posts only the configured URL with the bound header and refuses redirects',async()=>{
 const requests:{url:string;headers:Headers;redirect:RequestRedirect|undefined}[]=[],secret='header' + '-private-1234567890';let redirect=false;
 const stub:typeof fetch=async(input,init)=>{requests.push({url:String(input),headers:new Headers(init?.headers),redirect:init?.redirect});if(redirect)return new Response(null,{status:302,headers:{location:'https://other.invalid/mcp'}});const m=JSON.parse(String(init?.body)) as {id?:string;method:string};if(m.id===undefined)return new Response(null,{status:202});return rpc(m.id,m.method==='initialize'?initialized:m.method==='tools/list'?{tools}: {content:[{type:'text',text:'ok'}]});};
 const f=await fixture(stub);await f.service.query('agent',{kind:'mcp.add',config:{name:'remote',type:'http',url:'https://stub.invalid/mcp',headers:['Authorization']},values:{Authorization:secret}});const s=await first(f.service,f.cwd);
 await f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash});expect(requests.length).toBeGreaterThanOrEqual(2);expect(requests.every(r=>r.url==='https://stub.invalid/mcp'&&r.redirect==='error'&&r.headers.get('Authorization')===secret)).toBe(true);
 redirect=true;await expect(f.service.query('agent',{kind:'mcp.call',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo',arguments:{message:'hi'}})).rejects.toThrow('MCP operation failed');expect(requests.every(r=>r.url==='https://stub.invalid/mcp')).toBe(true);
});
it('project approval is keyed to the exact entry and asks again on changes; browsing never starts a server',async()=>{
 const fetchFn=vi.fn<typeof fetch>(async(_input,init)=>{const m=JSON.parse(String(init?.body)) as {id?:string;method:string};return m.id!==undefined?rpc(m.id,m.method==='initialize'?initialized:{tools}):new Response(null,{status:202});});const f=await fixture(fetchFn),path=join(f.cwd,'.mcp.json');
 const entry={type:'http',url:'https://stub.invalid/mcp'};await writeFile(path,JSON.stringify({mcpServers:{project:entry}}));let s=await first(f.service,f.cwd);expect(s.approved).toBe(false);expect(fetchFn).not.toHaveBeenCalled();
 await expect(f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash})).rejects.toThrow('MCP operation failed');expect(fetchFn).not.toHaveBeenCalled();
 await f.service.query('agent',{kind:'mcp.approve',cwd:f.cwd,serverId:s.id,hash:s.hash});expect((await first(f.service,f.cwd)).approved).toBe(true);await f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash});
 await writeFile(path,JSON.stringify({mcpServers:{project:{...entry,url:'https://stub.invalid/changed'}}}));const changed=await first(f.service,f.cwd);expect(changed.id).toBe(s.id);expect(changed.hash).not.toBe(s.hash);expect(changed.approved).toBe(false);
 await expect(f.service.query('agent',{kind:'mcp.approve',cwd:f.cwd,serverId:s.id,hash:s.hash})).rejects.toThrow('MCP operation failed');s=changed;await f.service.query('agent',{kind:'mcp.approve',cwd:f.cwd,serverId:s.id,hash:s.hash});expect((await first(f.service,f.cwd)).approved).toBe(true);
});
it('server and tool switches persist and can be switched back on; schemas are absent from catalog responses',async()=>{
 const f=await fixture(async(_input,init)=>{const m=JSON.parse(String(init?.body)) as {id?:string;method:string};return m.id!==undefined?rpc(m.id,m.method==='initialize'?initialized:{tools}):new Response(null,{status:202});});await f.service.query('agent',{kind:'mcp.add',config:{name:'remote',type:'http',url:'https://stub.invalid/mcp',headers:[]},values:{}});const s=await first(f.service,f.cwd);
 await f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash});const list=await f.service.list(f.cwd);expect(list.servers[0]?.available[0]?.name).toBe('echo');expect(JSON.stringify(list)).not.toContain('inputSchema');
 const schema=await f.service.query('agent',{kind:'mcp.schema',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo'});expect(schema.mcpSchema).toEqual(tools[0]?.inputSchema);
 for(const tool of ['echo',undefined]){await f.service.query('agent',{kind:'mcp.toggle',cwd:f.cwd,serverId:s.id,...(tool?{tool}:{}),enabled:false});await f.service.query('agent',{kind:'mcp.toggle',cwd:f.cwd,serverId:s.id,...(tool?{tool}:{}),enabled:true});}
 expect((await first(f.service,f.cwd)).enabled).toBe(true);
});
it('validates argv, names, URLs, secret references and request bounds before side effects',()=>{
 for(const command of ['node -e','-x','node\n'])expect(()=>validateMcpConfig({name:'x',type:'stdio',command,args:[],env:[]})).toThrow();
 for(const url of ['https://user:pass@host.invalid/mcp','https://host.invalid/mcp?key=secret','http://remote.invalid/mcp'])expect(()=>validateMcpConfig({name:'x',type:'http',url,headers:[]})).toThrow();
 expect(()=>validateMcpConfig({name:'x',type:'stdio',command:'node',args:[],env:['AITERM_AGENT_KEY']})).toThrow();expect(()=>validateMcpRequest({kind:'mcp.call',cwd:'/tmp',serverId:'0'.repeat(16),hash:'0'.repeat(64),tool:'echo',arguments:{},secret:'private'})).toThrow();
});
it('cancels a slow stdio call and kills the process group; exiting also stops an idle server',async()=>{
 const f=await fixture(),path=join(f.cwd,'slow.mjs'),pidPath=join(f.cwd,'pid.json'),callPath=join(f.cwd,'called');
 await writeFile(path,`import {writeFileSync} from 'node:fs';import {spawn} from 'node:child_process';import {createInterface} from 'node:readline';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},JSON.stringify([process.pid,child.pid]));createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.method==='tools/call')writeFileSync(${JSON.stringify(callPath)},'');if(m.id===undefined||m.method==='tools/call')return;process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?${JSON.stringify(initialized)}:{tools:${JSON.stringify(tools)}}})+'\\n');});`);
 await f.service.query('agent',{kind:'mcp.add',config:{name:'slow',type:'stdio',command:process.execPath,args:[path],env:[]},values:{}});const s=await first(f.service,f.cwd);
 await f.service.query('agent',{kind:'mcp.schema',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo'});const pids=JSON.parse(await readFile(pidPath,'utf8')) as number[];
 const pending=f.service.query('agent',{kind:'mcp.call',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo',arguments:{message:'wait'}}).catch(()=>null);
 await vi.waitFor(()=>readFile(callPath),{timeout:10_000});await f.service.query('agent',{kind:'mcp.cancel'});expect(await pending).toBeNull();for(const pid of pids)await vi.waitFor(()=>expect(processRuns(pid)).toBe(false),{timeout:10_000});
 await f.service.query('agent',{kind:'mcp.schema',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo'});const next=JSON.parse(await readFile(pidPath,'utf8')) as number[];await f.service.stop('agent');for(const pid of next)await vi.waitFor(()=>expect(processRuns(pid)).toBe(false),{timeout:10_000});
});
it('a server that exits cannot leave its grandchild behind',async()=>{
 const f=await fixture(),path=join(f.cwd,'exit.mjs'),pidPath=join(f.cwd,'child.json');await writeFile(path,`import {spawn} from 'node:child_process';import {writeFileSync} from 'node:fs';const p=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});writeFileSync(${JSON.stringify(pidPath)},String(p.pid));setTimeout(()=>process.exit(0),50);`);
 await f.service.query('agent',{kind:'mcp.add',config:{name:'exit',type:'stdio',command:process.execPath,args:[path],env:[]},values:{}});const s=await first(f.service,f.cwd);await expect(f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash})).rejects.toThrow();const pid=Number(await readFile(pidPath,'utf8'));await vi.waitFor(()=>expect(processRuns(pid)).toBe(false),{timeout:10_000});
});
it('project aliases outside the folder, hard links, malformed entries and secrets in argv are skipped',async()=>{
 const f=await fixture(),outside=join(f.home,'outside.json'),path=join(f.cwd,'.mcp.json');const {symlink,link}=await import('node:fs/promises');await writeFile(outside,JSON.stringify({mcpServers:{x:{command:'node'}}}));await symlink(outside,path);expect((await f.service.list(f.cwd)).servers).toEqual([]);await rm(path);await link(outside,path);expect((await f.service.list(f.cwd)).servers).toEqual([]);await rm(path);
 await writeFile(path,JSON.stringify({mcpServers:{secret:{command:'node',args:['privat' + 'e-token-value-1234567890'],env:{TOKEN:'privat' + 'e-token-value-1234567890'}},login:{url:'https://stub.invalid/mcp',auth:{type:'oauth'}},bad:{command:'node',disabled:'false'}}}));const catalog=await f.service.list(f.cwd);expect(catalog.servers.map(s=>s.config.name)).toEqual(['login']);expect(catalog.servers[0]?.note).toBe('needs login, not supported yet');expect(JSON.stringify(catalog)).not.toContain('privat' + 'e-token-value-1234567890');
});
it('login-required HTTP servers get a fixed unsupported note and are not retried',async()=>{
 const fetchFn=vi.fn<typeof fetch>(async()=>new Response('private server error',{status:401})),f=await fixture(fetchFn);await f.service.query('agent',{kind:'mcp.add',config:{name:'login',type:'http',url:'https://stub.invalid/mcp',headers:[]},values:{}});const s=await first(f.service,f.cwd);await expect(f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash})).rejects.toThrow('MCP operation failed');expect((await first(f.service,f.cwd)).note).toBe('needs login, not supported yet');const calls=fetchFn.mock.calls.length;await expect(f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash})).rejects.toThrow();expect(fetchFn).toHaveBeenCalledTimes(calls);
});
it('redacts escaped secrets structurally from nested schemas and tool results',async()=>{
 const secret='private"quote\\value-1234567890',f=await fixture(async(_input,init)=>{const m=JSON.parse(String(init?.body)) as {id?:number;method:string};if(m.id===undefined)return new Response(null,{status:202});return rpc(m.id,m.method==='initialize'?initialized:m.method==='tools/list'?{tools:[{...tools[0],inputSchema:{type:'object',description:secret,properties:{message:{type:'string',description:secret}}}}]}:{content:[{type:'text',text:secret}],nested:{[secret]:secret}});});
 await f.service.query('agent',{kind:'mcp.add',config:{name:'escaped',type:'http',url:'https://stub.invalid/mcp',headers:['Authorization']},values:{Authorization:secret}});const s=await first(f.service,f.cwd);const schema=await f.service.query('agent',{kind:'mcp.schema',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo'});expect(schema.mcpSchema?.description).toBe('[redacted]');expect(JSON.stringify(schema)).not.toContain(JSON.stringify(secret).slice(1,-1));const result=await f.service.query('agent',{kind:'mcp.call',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo',arguments:{}});expect(JSON.parse(result.mcpResult??'{}').content[0].text).toBe('[redacted]');
});
it('rejects quote/backslash-containing secrets duplicated in public argv for own and project servers',async()=>{
 const f=await fixture(),secret='private"quote\\value-1234567890',config={name:'escape',type:'stdio',command:'node',args:[secret],env:['TOKEN']};await expect(f.service.query('agent',{kind:'mcp.add',config,values:{TOKEN:secret}})).rejects.toThrow();expect(f.values.size).toBe(0);expect((await f.settings.get()).mcp).toBeUndefined();await writeFile(join(f.cwd,'.mcp.json'),JSON.stringify({mcpServers:{escape:{command:'node',args:[secret],env:{TOKEN:secret}}}}));expect((await f.service.list(f.cwd)).servers).toEqual([]);expect(f.values.size).toBe(0);
});
it('cancel and exit stop requests before asynchronous selection can start a connection',async()=>{
 for(const action of ['cancel','exit']){const fetchFn=vi.fn<typeof fetch>(async(_input,init)=>{const m=JSON.parse(String(init?.body)) as {id?:number;method:string};return m.id!==undefined?rpc(m.id,m.method==='initialize'?initialized:{tools}):new Response(null,{status:202});}),f=await fixture(fetchFn);await f.service.query('agent',{kind:'mcp.add',config:{name:'race',type:'http',url:'https://stub.invalid/mcp',headers:[]},values:{}});const s=await first(f.service,f.cwd),original=f.service.list.bind(f.service);let release:()=>void=()=>{},held=false;const waiting=new Promise<void>(r=>{release=r;});f.service.list=async cwd=>{held=true;await waiting;return original(cwd);};const pending=f.service.query('agent',{kind:'mcp.discover',cwd:f.cwd,serverId:s.id,hash:s.hash}).catch(()=>null);await vi.waitFor(()=>expect(held).toBe(true));if(action==='cancel')await f.service.query('agent',{kind:'mcp.cancel'});else await f.service.stop('agent');release();expect(await pending).toBeNull();expect(fetchFn).not.toHaveBeenCalled();}
});
it('closing stdio immediately after start kills the process before its spawn callback',async()=>{
 const {McpStdio}=await import('../src/daemon/mcp/stdio.js'),f=await fixture(),pidPath=join(f.cwd,'early-pid');const transport=new McpStdio(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000)`],f.cwd,mcpEnv(f.cwd,{}));const pending=transport.start();await transport.close();await pending;await new Promise(r=>setTimeout(r,100));const pid=await readFile(pidPath,'utf8').then(Number,()=>null);if(pid){let alive=true;try{process.kill(pid,0);}catch{alive=false;}if(alive){process.kill(-pid,'SIGKILL');expect(alive).toBe(false);}}
});
it('redacts JSON-escaped secrets embedded in ordinary schema/result text',async()=>{
 const secret='private"quote\\value-1234567890',json=JSON.stringify({TOKEN:secret}),f=await fixture(async(_input,init)=>{const m=JSON.parse(String(init?.body)) as {id?:number;method:string};if(m.id===undefined)return new Response(null,{status:202});return rpc(m.id,m.method==='initialize'?initialized:m.method==='tools/list'?{tools:[{...tools[0],inputSchema:{type:'object',description:json}}]}:{content:[{type:'text',text:json}]});});await f.service.query('agent',{kind:'mcp.add',config:{name:'jsontext',type:'http',url:'https://stub.invalid/mcp',headers:['Authorization']},values:{Authorization:secret}});const s=await first(f.service,f.cwd),schema=await f.service.query('agent',{kind:'mcp.schema',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo'});expect(JSON.parse(String(schema.mcpSchema?.description)).TOKEN).toBe('[redacted]');const result=await f.service.query('agent',{kind:'mcp.call',cwd:f.cwd,serverId:s.id,hash:s.hash,tool:'echo',arguments:{}});expect(JSON.parse(JSON.parse(result.mcpResult??'{}').content[0].text).TOKEN).toBe('[redacted]');
});
it('refuses secrets embedded as JSON text in public command arguments',async()=>{
 const f=await fixture(),secret='private"quote\\value-1234567890',arg=JSON.stringify({TOKEN:secret});await expect(f.service.query('agent',{kind:'mcp.add',config:{name:'jsonarg',type:'stdio',command:'node',args:[arg],env:['TOKEN']},values:{TOKEN:secret}})).rejects.toThrow();expect(f.values.size).toBe(0);expect((await f.settings.get()).mcp).toBeUndefined();await writeFile(join(f.cwd,'.mcp.json'),JSON.stringify({mcpServers:{jsonarg:{command:'node',args:[arg],env:{TOKEN:secret}}}}));expect((await f.service.list(f.cwd)).servers).toEqual([]);
});

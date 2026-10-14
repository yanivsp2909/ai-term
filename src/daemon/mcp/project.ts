import { createHash } from 'node:crypto';
import { ExtensionReader } from '../../agent/extensions/reader.js';
import { validateMcpConfig, validateMcpValues, isMcpName } from '../../shared/validate.js';
import { mcpContains, type McpServer } from '../../shared/mcp.js';

export const hashMcp=(value:unknown):string=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export interface ProjectMcp {server:McpServer;secrets:Record<string,string>;note?:string}
// Canonical fields and sorted names make whitespace/key ordering irrelevant, but any executable/value change asks again.
export function projectMcp(home:string,cwd:string):{entries:ProjectMcp[];notes:string[]}{
 const text=new ExtensionReader(home,cwd).projectMcp(cwd);if(text===null)return {entries:[],notes:[]};
 let raw:unknown;try{raw=JSON.parse(text) as unknown;}catch{throw new Error('MCP project file malformed');}
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!('mcpServers'in raw)||!raw.mcpServers||typeof raw.mcpServers!=='object'||Array.isArray(raw.mcpServers)||Object.keys(raw).some(k=>k!=='mcpServers')||Object.keys(raw.mcpServers).length>16)throw new Error('MCP project file malformed');
 const entries:ProjectMcp[]=[],notes:string[]=[];
 for(const [name,input]of Object.entries(raw.mcpServers)){
  if(!isMcpName(name)){notes.push('MCP entry skipped: invalid name');continue;}
  try{
   if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('bad entry');const v=input as Record<string,unknown>;
   const oauth=v.oauth!==undefined||v.auth!==undefined||v.type==='oauth',type=v.url!==undefined?'http':'stdio';
   if(!oauth&&Object.keys(v).some(k=>!['type','command','args','env','url','headers','disabled'].includes(k)))throw new Error('unsupported entry');
   const values=v[type==='stdio'?'env':'headers']??{};if(!values||typeof values!=='object'||Array.isArray(values))throw new Error('bad values');
   const names=Object.keys(values).sort(),config=validateMcpConfig(type==='stdio'?{name,type,command:v.command??'unsupported',args:v.args??[],env:names}:{name,type,url:v.url,headers:names});
   if(v.disabled!==undefined&&typeof v.disabled!=='boolean')throw new Error('bad switch');
   const secrets=validateMcpValues(config,values);if(Object.values(secrets).some(value=>mcpContains(config,value)))throw new Error('secret in configuration');
   const hash=hashMcp({config,values:secrets,disabled:v.disabled===true,oauth}),id=hashMcp({cwd,name}).slice(0,16);
   entries.push({server:{id,config,hash,enabled:v.disabled!==true,values:names.map(name=>({name,last4:(secrets[name]?.length??0)>=16?secrets[name]?.slice(-4)??'':''})),tools:{}},secrets,...(oauth?{note:'needs login, not supported yet'}:{})});
  }catch{notes.push(`MCP ${name}: unsupported or malformed entry skipped`);}
 }
 return {entries,notes};
}

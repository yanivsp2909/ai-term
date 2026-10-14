import type { McpAccess, McpRequest } from '../shared/mcp.js';
import { validateMcpCatalog, validateMcpObject } from '../shared/validate.js';
import type { Request } from './tui/worktree-question.js';

export function socketMcp(request:Request):McpAccess{return mcpAccess(async body=>request(body));}
// The adapter returns metadata/schema/results only. Values travel inward only from the masked add form.
export function mcpAccess(query:(body:McpRequest,signal?:AbortSignal)=>Promise<{mcp?:unknown;mcpSchema?:unknown;mcpResult?:unknown}>):McpAccess{return {
 list:async cwd=>validateMcpCatalog((await query({kind:'mcp.list',cwd})).mcp),
 add:async(config,values)=>{await query({kind:'mcp.add',config,values});},
 remove:async name=>{await query({kind:'mcp.remove',name});},
 toggle:async(cwd,serverId,tool,enabled)=>validateMcpCatalog((await query({kind:'mcp.toggle',cwd,serverId,...(tool?{tool}:{}),enabled})).mcp),
 approve:async(cwd,serverId,hash)=>{await query({kind:'mcp.approve',cwd,serverId,hash});},
 discover:async(cwd,serverId,hash,signal)=>validateMcpCatalog((await query({kind:'mcp.discover',cwd,serverId,hash},signal)).mcp),
 schema:async(cwd,serverId,hash,tool,signal)=>validateMcpObject((await query({kind:'mcp.schema',cwd,serverId,hash,tool},signal)).mcpSchema),
 call:async(cwd,serverId,hash,tool,args,signal)=>{const result=(await query({kind:'mcp.call',cwd,serverId,hash,tool,arguments:args},signal)).mcpResult;if(typeof result!=='string'||Buffer.byteLength(result)>64*1024)throw new Error('MCP call failed');return result;},
 stop:async()=>{await query({kind:'mcp.stop'});},
};}

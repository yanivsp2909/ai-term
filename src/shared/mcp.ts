import { extensionTokens } from './extensions.js';

export const MCP_MAX_SERVERS = 16, MCP_MAX_TOOLS = 64, MCP_MESSAGE_BYTES = 1024 * 1024;
export interface McpValue { name: string; last4: string }
export type McpConfig = { name: string; type: 'stdio'; command: string; args: string[]; env: string[] } | { name: string; type: 'http'; url: string; headers: string[] };
export interface McpServer { id: string; config: McpConfig; hash: string; enabled: boolean; values: McpValue[]; tools: Record<string, boolean> }
export interface McpTool { name: string; description: string; enabled: boolean; tokens: number }
export interface McpView extends McpServer { source: 'AI Term'|'this project'; approved: boolean; note?: string; available: McpTool[] }
export interface McpCatalog { servers: McpView[]; notes: string[]; tokens: number }
export interface McpAccess {
  list(cwd: string): Promise<McpCatalog>;
  add(config: McpConfig, values: Record<string,string>): Promise<void>;
  remove(name: string): Promise<void>;
  toggle(cwd: string, serverId: string, tool: string | undefined, enabled: boolean): Promise<McpCatalog>;
  approve(cwd: string, serverId: string, hash: string): Promise<void>;
  discover(cwd: string, serverId: string, hash: string, signal?: AbortSignal): Promise<McpCatalog>;
  schema(cwd: string, serverId: string, hash: string, tool: string, signal: AbortSignal): Promise<unknown>;
  call(cwd: string, serverId: string, hash: string, tool: string, args: Record<string,unknown>, signal: AbortSignal): Promise<string>;
  stop(): Promise<void>;
}
export type McpRequest = { kind:'mcp.list';cwd:string } | { kind:'mcp.add';config:McpConfig;values:Record<string,string> } | { kind:'mcp.remove';name:string } |
  { kind:'mcp.toggle';cwd:string;serverId:string;tool?:string;enabled:boolean } | {kind:'mcp.approve';cwd:string;serverId:string;hash:string} | {kind:'mcp.discover';cwd:string;serverId:string;hash:string} |
  {kind:'mcp.schema';cwd:string;serverId:string;hash:string;tool:string} | {kind:'mcp.call';cwd:string;serverId:string;hash:string;tool:string;arguments:Record<string,unknown>} |
  {kind:'mcp.cancel'} | {kind:'mcp.stop'};
export function mcpManifest(catalog: McpCatalog): string {
  return catalog.servers.filter(s=>s.enabled&&!s.note).map(s=>`mcp server ${s.config.name}: ${s.config.type}` + s.available.filter(t=>t.enabled).map(t=>`\nmcp ${s.config.name}/${t.name}: ${t.description}`).join('')).join('\n');
}
export const mcpTokens = (catalog: McpCatalog): number => extensionTokens(mcpManifest(catalog));
export function mcpPreview(server: McpView): string {
  const c=server.config;
  return `${c.name} · ${server.source}\n${c.type==='stdio'?`command: ${JSON.stringify(c.command)}\nargs: ${JSON.stringify(c.args)}\nenv names: ${c.env.join(', ')||'(none)'}`:`URL: ${c.url}\nheader names: ${c.headers.join(', ')||'(none)'}`}\n${server.values.map(v=>`${v.name}: secret ····${v.last4}`).join('\n')}`;
}

export function mcpContains(value:unknown,secret:string):boolean {
 if(typeof value==='string')return value.includes(secret);
 if(Array.isArray(value))return value.some(v=>mcpContains(v,secret));
 return !!value&&typeof value==='object'&&Object.entries(value).some(([key,v])=>key.includes(secret)||mcpContains(v,secret));
}

export const mcpSecretForms=(secret:string):string[]=>[JSON.stringify(secret).slice(1,-1),secret];

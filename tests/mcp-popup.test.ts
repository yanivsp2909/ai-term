import { expect, it, vi } from 'vitest';
import { McpPanel } from '../src/client/tui/mcp-panel.js';
import { ExtensionsPanel } from '../src/client/tui/extensions-panel.js';
import { Grid, plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
import { mcpTokens, type McpAccess, type McpCatalog, type McpView } from '../src/shared/mcp.js';
const theme=createTheme('graphite');
function setup(add=false){const server:McpView={id:'0'.repeat(16),hash:'1'.repeat(64),config:{name:'local',type:'stdio',command:'node',args:[],env:[]},values:[],enabled:true,tools:{},source:'this project',approved:false,available:[{name:'echo',description:'Echo a message',tokens:12,enabled:true}]};const list=async():Promise<McpCatalog>=>{const c={servers:[structuredClone(server)],tokens:0,notes:[]};c.tokens=mcpTokens(c);return c;};const saved:unknown[]=[],approve=vi.fn(),discover=vi.fn(async()=>list()),toggle=vi.fn(async(_cwd:string,_id:string,tool:string|undefined,enabled:boolean)=>{if(tool){const t=server.available.find(t=>t.name===tool);if(t)t.enabled=enabled;}else server.enabled=enabled;return list();});const access:McpAccess={list,add:async(c,v)=>{saved.push(structuredClone({c,v}));},remove:async()=>{},toggle,approve,discover,schema:async()=>({}),call:async()=>'',stop:async()=>{}};const panel=new McpPanel(access,'/tmp/work',()=>{},()=>{},()=>{},add);return {server,access,panel,saved,approve,discover,toggle,draw:()=>plainText(panel.draw(new Grid(100,28,theme).cells,theme))};}
it('MCP tab shows server/tool source, tokens and switches without starting anything',async()=>{
 const f=setup(),panel=new ExtensionsPanel({list:async()=>({items:[],tokens:0,notes:[]}),read:async()=>{throw new Error('unused');},toggle:async()=>({items:[],tokens:0,notes:[]})},'/tmp/work','mcp',()=>{},()=>{},()=>{},f.access);
 await panel.load();const draw=()=>plainText(panel.draw(new Grid(120,32,theme).cells,theme));expect(draw()).toContain('[MCP]');expect(draw()).toContain('local · this project · ✓ on');expect(draw()).toContain('local/echo');expect(draw()).toContain(`≈${(await f.access.list('/tmp/work')).tokens} tokens/request on`);expect(f.discover).not.toHaveBeenCalled();await panel.key(' ');expect(f.toggle).toHaveBeenCalledOnce();expect(draw()).toContain('○ off');
});
it('exact project approval is paged, typed, and never runs on browsing or paste',async()=>{
 const f=setup();f.server.config={name:'local',type:'stdio',command:'node',args:['a'.repeat(1500)],env:[]};await f.panel.load();await f.panel.key('d');await f.panel.key('y');expect(f.approve).not.toHaveBeenCalled();f.panel.paste('y');f.draw();await f.panel.key('y');expect(f.approve).not.toHaveBeenCalled();for(let n=0;n<10;n++){await f.panel.key(' ');f.draw();}await f.panel.key('y');expect(f.approve).toHaveBeenCalledOnce();expect(f.discover).toHaveBeenCalledOnce();
});
it('add form masks values, reviews exact argv, saves only on Enter after review',async()=>{
 const f=setup(true),secret='private-form-value-1234567890';const fields=['new','stdio','node','["server.mjs"]','SERVER_TOKEN',secret];
 for(const field of fields){f.panel.paste(field);expect(f.draw()).not.toContain(secret);await f.panel.key('enter');}
 expect(f.saved).toEqual([]);await f.panel.key('enter');expect(f.saved).toEqual([]);const view=f.draw();expect(view).toContain('"node"');expect(view).toContain('["server.mjs"]');expect(view).toContain('····7890');expect(view).not.toContain(secret);await f.panel.key('enter');expect(f.saved).toEqual([{c:{name:'new',type:'stdio',command:'node',args:['server.mjs'],env:['SERVER_TOKEN']},v:{SERVER_TOKEN:secret}}]);
});

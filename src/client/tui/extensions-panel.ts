import type { ExtensionAccess, ExtensionCatalog } from '../../shared/extensions.js';
import { validateExtensionCatalog, validateExtensionFile } from '../../shared/validate.js';
import { Grid, type Frame } from './grid.js';
import type { Theme } from './theme.js';
import { overlay } from './worktree-question.js';
import { TextPanel } from './text-panel.js';
import { plain } from '../../agent/display.js';
import { McpPanel } from './mcp-panel.js';
import type { McpAccess } from '../../shared/mcp.js';

const TABS = ['Skills', 'Agents', 'Commands', 'MCP'] as const;
const KINDS = ['skill', 'agent', 'command', 'mcp'] as const;
// One popup and keyboard model for both surfaces. No model call is made to browse, toggle or preview a full file.
export class ExtensionsPanel {
  private catalog: ExtensionCatalog | null = null;
  private tab: number;
  private row = 0;
  private note = '';
  private preview?: TextPanel;
  private closed = false;
  private busy = false;
  private mcp?:McpPanel;
  constructor(private readonly access: ExtensionAccess, private readonly cwd: string, first: 'skills'|'agents'|'mcp', private readonly changed: () => void, private readonly close: () => void, private readonly toggled: () => void = () => {},mcp?:McpAccess,add=false) { this.tab=first==='agents'?1:first==='mcp'?3:0;if(mcp)this.mcp=new McpPanel(mcp,cwd,changed,close,toggled,add); }
  async load(): Promise<void> {
    try { this.catalog=validateExtensionCatalog(await this.access.list(this.cwd));this.note=this.catalog.notes[0]??''; }
    catch { this.catalog={items:[],notes:[],tokens:0};this.note='Extensions unavailable; try again'; }
    await this.mcp?.load();
    if(!this.closed)this.changed();
  }
  paste(text:string):void{if(this.tab===3)this.mcp?.paste(text);}
  async key(key: string): Promise<void> {
    if(this.closed)return;
    if(this.tab===3&&this.mcp&&(this.mcp.modal||!['left','right'].includes(key))){await this.mcp.key(key);return;}
    if(this.preview){this.preview.key(key);return;}
    if(key==='escape'){this.closed=true;this.close();return;}
    if(this.busy)return;
    if(key==='left'||key==='right'){this.tab=(this.tab+(key==='left'?3:1))%4;this.row=0;this.changed();return;}
    const items=this.catalog?.items.filter(i=>i.kind===KINDS[this.tab])??[],item=items[this.row];
    if(key==='up'||key==='down'){this.row=Math.max(0,Math.min(items.length-1,this.row+(key==='up'?-1:1)));this.changed();return;}
    if(!item||![' ','space','enter'].includes(key))return;
    this.busy=true;
    try {
      if(key==='enter') {
        const file=validateExtensionFile(await this.access.read(this.cwd,item.id));
        if(this.closed)return;
        const preview=new TextPanel(`${file.item.name} · read-only`,this.changed,()=>{this.preview=undefined;this.changed();});
        this.preview=preview;preview.set(plain(file.text).split('\n').map(text=>({text,tone:'ink-2'})));
      } else {
        this.catalog=validateExtensionCatalog(await this.access.toggle(this.cwd,item.id,!item.enabled));
        this.note=`${item.name}: ${item.enabled?'off':'on'} · applies to the next message`;
        this.toggled();
      }
    } catch { this.note='Extension could not be read or saved; selection unchanged'; }
    finally {this.busy=false;if(!this.closed)this.changed();}
  }
  draw(frame: Frame, theme: Theme): Frame {
    if(this.tab===3&&this.mcp)return this.mcp.draw(frame,theme,this.catalog?.tokens??0);
    const grid=overlay(frame,theme),w=Math.min(grid.cols,120),h=Math.min(grid.rows,Math.max(8,grid.rows-2)),x=Math.floor((grid.cols-w)/2),y=Math.max(0,Math.floor((grid.rows-h)/2)),width=w-6,surface=theme.colors.surface;
    grid.box(x,y,w,h,`Extensions · ≈${(this.catalog?.tokens??0)+(this.mcp?.tokens??0)} tokens/request on`,surface);
    grid.text(x+3,y+1,TABS.map((t,n)=>n===this.tab?`[${t}]`:t).join(' · '),theme.colors.ink,surface,true,width);
    const items=this.catalog?.items.filter(i=>i.kind===KINDS[this.tab])??[],capacity=Math.max(1,Math.floor((h-6)/2)),start=Math.max(0,this.row-capacity+1);
    if(!this.catalog)grid.text(x+3,y+3,'· loading extensions',theme.colors['ink-3'],surface,false,width);
    else if(!items.length)grid.text(x+3,y+3,this.tab===3?'MCP unavailable in this connection':'No extensions in this tab',theme.colors['ink-3'],surface,false,width);
    items.slice(start,start+capacity).forEach((item,n)=>{
      const selected=start+n===this.row,bg=selected?theme.colors['surface-2']:surface,top=y+2+n*2;
      grid.fill(x+1,top,w-2,2,bg);
      grid.text(x+2,top,selected?'›':' ',theme.colors.accent,bg);
      grid.text(x+3,top,`${item.name} · ${item.source} · ${item.enabled?'✓ on':'○ off'} · ≈${item.tokens} tokens/request`,theme.colors.ink,bg,selected,width);
      grid.text(x+3,top+1,item.description||'No description',theme.colors['ink-2'],bg,false,width);
    });
    if(this.note)grid.text(x+3,y+h-3,this.note,theme.colors['ink-3'],surface,false,width);
    grid.text(x+3,y+h-2,'←→ tab · ↑↓ item · Space on/off · ⏎ full file · Esc close',theme.colors['ink-3'],surface,false,width);
    return this.preview?this.preview.draw(grid.cells,theme):grid.cells;
  }
  // The agent starts from a blank alternate screen; the homepage overlays its existing frame.
  blank(theme: Theme, cols: number, rows: number): Frame { return this.draw(new Grid(cols,rows,theme).cells,theme); }
}

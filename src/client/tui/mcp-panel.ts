import { mcpPreview, type McpAccess, type McpCatalog, type McpConfig, type McpView } from '../../shared/mcp.js';
import { validateMcpConfig, validateMcpValues } from '../../shared/validate.js';
import { plain } from '../../agent/display.js';
import { type Frame } from './grid.js';
import type { Theme } from './theme.js';
import { overlay } from './worktree-question.js';
import { wrapHelpLines } from './help.js';
import { TextPanel } from './text-panel.js';
import { lastFour } from '../../shared/text-cut.js';

type Row={server:McpView;tool?:string;name:string;description:string;enabled:boolean;tokens:number};
export class McpPanel {
 private catalog:McpCatalog={servers:[],notes:[],tokens:0};private row=0;private note='';private busy=false;private closed=false;private preview?:TextPanel;
 private form?:{phase:number;fields:string[];config?:McpConfig;names:string[]};
 private confirmation?:{body:string;page:number;pages:string[][];server?:McpView;save?:()=>Promise<void>};
 constructor(private access:McpAccess,private cwd:string,private changed:()=>void,private close:()=>void,private toggled:()=>void,add=false){if(add)this.form={phase:0,fields:['','','','',''],names:[]};}
 paste(text:string):void{const f=this.form;if(!f||this.confirmation||this.closed)return;f.fields[f.phase]=((f.fields[f.phase]??'')+text).slice(0,2048);this.changed();}
 get tokens():number{return this.catalog.tokens;}
 get modal():boolean{return !!(this.form||this.confirmation||this.preview);}
 async load():Promise<void>{try{this.catalog=await this.access.list(this.cwd);this.note=this.catalog.notes[0]??'';}catch{this.note='MCP unavailable; try again';}if(!this.closed)this.changed();}
 private rows():Row[]{return this.catalog.servers.flatMap(server=>[{server,name:server.config.name,description:server.note??`${server.config.type} · ${server.approved?'approved':'project approval required'} · d discovers tools`,enabled:server.enabled,tokens:server.enabled?Math.ceil(Buffer.byteLength(`mcp server ${server.config.name}: ${server.config.type}\n`)/3):0},...server.available.map(t=>({server,tool:t.name,name:`${server.config.name}/${t.name}`,description:t.description,enabled:t.enabled,tokens:t.tokens}))]);}
 async key(key:string):Promise<void>{
  if(this.closed)return;if(this.preview){this.preview.key(key);return;}
  if(this.confirmation){const c=this.confirmation,last=c.page>=c.pages.length-1;
   if(key==='escape'||key==='n'){this.confirmation=undefined;this.changed();return;}
   if(key===' '&&!last){c.page++;this.changed();return;}
   if((c.server?key==='y':key==='enter')&&c.pages.length>0&&last&&!this.busy){this.busy=true;try{if(c.server){await this.access.approve(this.cwd,c.server.id,c.server.hash);await this.discover(c.server);}else await c.save?.();this.confirmation=undefined;}catch{this.note='MCP approval or save failed; check configuration';this.confirmation=undefined;}finally{this.busy=false;this.changed();}}return;
  }
  if(this.form){await this.formKey(key);return;}
  if(key==='escape'){this.closed=true;this.close();return;}if(this.busy)return;
  const rows=this.rows(),item=rows[this.row];
  if(key==='up'||key==='down'){this.row=Math.max(0,Math.min(rows.length-1,this.row+(key==='up'?-1:1)));this.changed();return;}
  if(key==='a'){this.form={phase:0,fields:['','','','',''],names:[]};this.changed();return;}
  if(!item)return;this.busy=true;
  try{
   if(key===' '||key==='space'){this.catalog=await this.access.toggle(this.cwd,item.server.id,item.tool,!item.enabled);this.toggled();}
   else if(key==='enter'){const preview=new TextPanel(`${item.name} · read-only`,this.changed,()=>{this.preview=undefined;this.changed();});this.preview=preview;preview.set((mcpPreview(item.server)+(item.tool?`\nTool: ${item.tool}\n${item.description}`:'')).split('\n').map(text=>({text:plain(text),tone:'ink-2'})));}
   else if(key==='d'&&!item.tool){if(item.server.note)this.note=item.server.note;else if(!item.server.approved)this.confirmation={body:mcpPreview(item.server),server:item.server,page:0,pages:[]};else await this.discover(item.server);}
  }catch{this.note='MCP operation failed; selection unchanged';}finally{this.busy=false;this.changed();}
 }
 private async discover(server:McpView):Promise<void>{this.catalog=await this.access.discover(this.cwd,server.id,server.hash);this.note='MCP tools discovered; schemas load only when selected by the agent';this.toggled();}
 private async formKey(key:string):Promise<void>{
  const f=this.form;if(!f||this.busy)return;
  if(key==='escape'){f.fields.fill('');this.form=undefined;this.changed();return;}
  if(key==='backspace')f.fields[f.phase]=(f.fields[f.phase]??'').slice(0,-1);
  else if(key.length===1)f.fields[f.phase]=((f.fields[f.phase]??'')+key).slice(0,2048);
  else if(key==='enter'){
   try{
    if(f.phase===1&&!f.fields[1])f.fields[1]='stdio';
    if(f.phase===1&&!['stdio','http'].includes(f.fields[1]??''))throw new Error('transport');
    if(f.phase===4){const names=(f.fields[4]??'').split(',').map(n=>n.trim()).filter(Boolean),type=f.fields[1];
     f.config=validateMcpConfig(type==='stdio'?{name:f.fields[0],type,command:f.fields[2],args:JSON.parse(f.fields[3]||'[]') as unknown,env:names}:{name:f.fields[0],type,url:f.fields[2],headers:names});f.names=names;
    }
    if(f.phase===4+f.names.length&&f.config){const config=f.config,values=Object.fromEntries(f.names.map((name,n)=>[name,f.fields[n+5]??'']));validateMcpValues(config,values);
     const body=mcpPreview({id:'0'.repeat(16),hash:'0'.repeat(64),config,values:f.names.map(name=>({name,last4:lastFour(values[name]??'')})),tools:{},enabled:true,source:'AI Term',approved:false,available:[]});
     this.confirmation={body,page:0,pages:[],save:async()=>{try{await this.access.add(config,values);this.note='MCP server saved; starts only on use';this.form=undefined;await this.load();}finally{f.fields.fill('');for(const name of Object.keys(values))delete values[name];}}};
    }else{f.phase++;if(f.phase===3&&f.fields[1]==='http')f.phase++;}
    this.note='';
   }catch{this.note='Check the field: stdio/http, JSON argv, valid names and nonempty secret values';}
  }
  this.changed();
 }
 draw(frame:Frame,theme:Theme,otherTokens=0):Frame{
  const grid=overlay(frame,theme),w=Math.min(grid.cols,120),h=Math.max(8,grid.rows-2),x=Math.floor((grid.cols-w)/2),y=1,width=w-6,surface=theme.colors.surface;
  grid.box(x,y,w,h,`Extensions · ≈${this.tokens+otherTokens} tokens/request on`,surface);grid.text(x+3,y+1,'Skills · Agents · Commands · [MCP]',theme.colors.ink,surface,true,width);
  if(this.confirmation){const c=this.confirmation,rows=wrapHelpLines(plain(c.body).split('\n'),width),size=Math.max(1,h-6);c.pages=[];for(let n=0;n<rows.length;n+=size)c.pages.push(rows.slice(n,n+size));c.page=Math.min(c.page,c.pages.length-1);
   grid.text(x+3,y+2,c.server?'Approve this exact project MCP server?':'Save and authorize this MCP server?',theme.colors['status-waiting'],surface,true,width);c.pages[c.page]?.forEach((text,n)=>grid.text(x+3,y+3+n,text,theme.colors.ink,surface,false,width));grid.text(x+3,y+h-2,c.page===c.pages.length-1?(c.server?'y approve · n deny · Esc cancel':'⏎ save · Esc cancel'):'Space next page · Esc cancel',theme.colors['ink-3'],surface,false,width);return grid.cells;
  }
  if(this.form){const f=this.form,labels=['server name','transport: stdio or http',f.fields[1]==='http'?'exact URL':'command (one executable)','args (JSON array)','env/header names (comma separated)'],label=labels[f.phase]??`${f.names[f.phase-5]??''} value · secret (Keychain only)`;
   grid.text(x+3,y+3,`Add MCP · ${label}`,theme.colors.ink,surface,true,width);grid.text(x+3,y+5,f.phase>=5?'•'.repeat(Math.min(40,(f.fields[f.phase]??'').length)):plain(f.fields[f.phase]??''),theme.colors.ink,surface,false,width);grid.text(x+3,y+h-2,'Type field · ⏎ next/review · Backspace delete · Esc discard',theme.colors['ink-3'],surface,false,width);
  }else{const rows=this.rows(),capacity=Math.max(1,Math.floor((h-6)/2)),start=Math.max(0,this.row-capacity+1);if(!rows.length)grid.text(x+3,y+3,'No MCP servers · /mcp add or a adds one',theme.colors['ink-3'],surface,false,width);
   rows.slice(start,start+capacity).forEach((r,n)=>{const selected=start+n===this.row,bg=selected?theme.colors['surface-2']:surface,top=y+2+n*2;grid.fill(x+1,top,w-2,2,bg);grid.text(x+2,top,selected?'›':' ',theme.colors.accent,bg);grid.text(x+3,top,`${r.name} · ${r.server.source} · ${r.enabled?'✓ on':'○ off'} · ≈${r.tokens} tokens/request`,theme.colors.ink,bg,selected,width);grid.text(x+3,top+1,r.description,theme.colors['ink-2'],bg,false,width);});
   grid.text(x+3,y+h-2,'←→ tab · ↑↓ item · Space on/off · ⏎ details · d discover · a add · Esc close',theme.colors['ink-3'],surface,false,width);
  }
  if(this.note)grid.text(x+3,y+h-3,this.note,theme.colors['ink-3'],surface,false,width);return this.preview?this.preview.draw(grid.cells,theme):grid.cells;
 }
}

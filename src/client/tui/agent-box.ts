import { Grid, type Frame } from './grid.js';
import type { Theme } from './theme.js';
import type { AgentEngine, Permission } from '../../shared/protocol.js';
import type { ModelChoice } from '../../shared/models.js';
export interface AgentBox {kind:'start'|'model'|'folder';engine:AgentEngine;model:string|null;cwd:string;permission:Permission;message:string;error:string;checking:boolean;row:number;filter:string;choices:ModelChoice[];choice:number;path:string;completions:string[]}
export function drawAgentBox(frame:Frame,box:AgentBox,theme:Theme):Frame{
 const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme),t=theme.colors;
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}
 const h=Math.min(rows-2,box.kind==='model'?14:box.kind==='folder'?10:10),w=Math.min(cols,100),x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);
 grid.box(x,y,w,h,box.kind==='start'?'Start a new agent':box.kind==='model'?'Select model':'Select folder',t.surface);
 // Start confirmation has the approved accent border, without adding colors to components.
 for(let r=y;r<y+h;r++)for(let c=x;c<x+w;c++)if(r===y||r===y+h-1||c===x||c===x+w-1){const cell=grid.cells[r]?.[c];if(cell)grid.put(c,r,{...cell,fg:t.accent});}
 const line=(offset:number,text:string,color=t['ink-2'])=>grid.text(x+3,y+offset,text,color,t.surface,false,w-6);
 if(box.kind==='start'){
  line(1,`${box.row===0?'›':' '} model          ${box.model??'CLI default'} · ${box.engine==='codex'?'codex':'claude code'}   m /model`);
  line(2,`${box.row===1?'›':' '} folder         ${box.cwd}   c /cd`);
  line(3,`${box.row===2?'›':' '} mode           ${box.permission==='dontAsk'?"! don't ask":'ask'} · ⇥ toggles`,box.permission==='dontAsk'?t['status-error']:t['ink-2']);
  line(4,`${box.row===3?'›':' '} first message  ${box.message}`);
  line(6,box.error?`✗ ${box.error}`:box.checking?'◐ checking engine': '⏎ starts · Esc returns to editing',box.error?t['status-error']:t['ink-3']);
  line(7,'↑↓ rows · m model · c folder · first message row edits text',t['ink-3']);
 }else if(box.kind==='model'){
  line(1,`Filter: ${box.filter}█`,t.ink);
  let row=2;for(const engine of ['claude-code','codex'] as const){
   line(row++,engine==='codex'?'OPENAI':'ANTHROPIC',t['ink-3']);
   for(const [index,choice] of box.choices.entries())if(choice.engine===engine){line(row++,`${index===box.choice?'›':' '} ${choice.label} · ${engine==='codex'?'codex':'claude code'} · account`,index===box.choice?t.accent:t['ink-2']);}
  }
  line(h-3,box.error?`✗ ${box.error}`:'↑↓ choose · ⇥ custom engine · ⏎ select · Esc back',box.error?t['status-error']:t['ink-3']);
  line(h-2,'account → official CLI',t['ink-3']);
 }else{
  line(1,`Path: ${box.path||box.cwd}█`,t.ink);
  box.completions.slice(0,3).forEach((path,i)=>line(2+i,path,t['ink-3']));
  line(h-3,box.error?`✗ ${box.error}`:'⇥ complete · ⏎ select · Esc back',box.error?t['status-error']:t['ink-3']);
 }
 return grid.cells;
}

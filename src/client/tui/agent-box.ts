import { Grid, type Frame } from './grid.js';
import type { Theme } from './theme.js';
import type { AgentEngine, Permission, AuthRef, Effort } from '../../shared/protocol.js';
import { engineLabel, type ModelChoice } from '../../shared/models.js';
import type { MessageField } from './message-field.js';
export interface AgentBox {kind:'start'|'model'|'folder'|'effort'|'mode';engine:AgentEngine;model:string|null;cwd:string;permission:Permission;message:string;messageField?:MessageField;messageNote?:string;worktreePreview?:import('../../shared/protocol.js').WorktreePreview;error:string;checking:boolean;row:number;filter:string;choices:ModelChoice[];choice:number;path:string;completions:string[];auth?:AuthRef;tabs?:string[];tab?:string;authLabel?:string;effort?:Effort|null;values?:readonly string[];preset?:string;presetCursor?:string;useWorktree?:boolean;restore?:NextAgent;accountLabel?:string;modeNote?:string}
// The next-agent setup a preset replaced, put back when the start box is cancelled.
export interface NextAgent {engine:AgentEngine;model:string|null;effort:Effort|null;auth:AuthRef;permission:Permission;folder:string}
export function drawAgentBox(frame:Frame,box:AgentBox,theme:Theme):Frame{
 const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme),t=theme.colors;
 for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}
 const h=Math.min(rows-2,box.kind==='model'?14:box.kind==='effort'?16:box.kind==='start'?13:11),w=Math.min(cols,100),x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);
 grid.box(x,y,w,h,box.kind==='start'?'Start a new agent':box.kind==='model'?'Select model':box.kind==='effort'?'Select effort':box.kind==='mode'?'Select mode':'Select folder',t.surface);
 // Start confirmation has the approved accent border, without adding colors to components.
 for(let r=y;r<y+h;r++)for(let c=x;c<x+w;c++)if(r===y||r===y+h-1||c===x||c===x+w-1){const cell=grid.cells[r]?.[c];if(cell)grid.put(c,r,{...cell,fg:t.accent});}
 const line=(offset:number,text:string,color=t['ink-2'])=>grid.text(x+3,y+offset,text,color,t.surface,false,w-6);
 if(box.kind==='start'){
  line(1,`${box.row===0?'›':' '} model          ${box.model??'CLI default'} · ${engineLabel(box.engine)} · ${box.authLabel??'own login'}   m /model`);
  line(2,`${box.row===1?'›':' '} folder         ${box.cwd}   c /cd`);
  // v0.8.1: AI Term's agent without a sandbox for its bash offers Ask only, and says why instead of the toggle hint.
  line(3,`${box.row===2?'›':' '} mode           ${box.permission==='dontAsk'?"! don't ask":box.permission} · ${box.engine==='ai-term'&&box.modeNote?box.modeNote:'⇥ toggles'}`,box.permission==='dontAsk'?t['status-error']:t['ink-2']);
  line(4,`${box.row===3?'›':' '} effort         ${box.effort??'CLI default'}   e /effort`);
  line(5,`${box.row===4?'›':' '} first message  ${box.messageField?.display(true)??box.message}`);
  const tree=box.worktreePreview;
  if(box.useWorktree===false)line(6,'worktree off · this preset',t['ink-3']);
  else if(tree?.branch&&tree.head)line(6,`new worktree · ${tree.branch} from ${tree.head.slice(0,7)}`,t['ink-3']);
  else if(tree?.note)line(6,tree.note,t['ink-3']);
  if(tree?.dirty&&box.useWorktree!==false)line(7,"uncommitted changes in your checkout aren't included",t['ink-3']);
  line(8,box.error?`✗ ${box.error}`:box.messageNote??(box.checking?'◐ checking engine': '⏎ starts · Esc returns to editing'),box.error?t['status-error']:t['ink-3']);
  line(9,'↑↓ rows · m model · c folder · e effort · a account · p preset · message row edits text',t['ink-3']);
  if(box.accountLabel)line(10,`account        ${box.accountLabel} · a`,t['ink-3']);
  if(box.preset)line(11,`preset         ${box.preset} · worktree ${box.useWorktree===false?'off':'on'}`,t['ink-3']);
 }else if(box.kind==='effort'||box.kind==='mode'){
  const capacity=h-4,start=Math.max(0,box.choice-capacity+1);
  for(const [i,value]of(box.values??[]).slice(start,start+capacity).entries())line(i+1,`${box.choice===start+i?'›':' '} ${value}`,box.choice===start+i?t.accent:t['ink-2']);
  line(h-2,box.error||'↑↓ choose · ⏎ select · Esc back',box.error?t['status-error']:t['ink-3']);
 }else if(box.kind==='model'){
  let tabX=x+3;
  for(const tab of box.tabs??[]){const selected=tab===box.tab,label=` ${tab} `;tabX=grid.text(tabX,y+1,label,selected?t.accent:t['ink-3'],selected?t['surface-2']:t.surface,selected,w-3-(tabX-x));tabX=grid.text(tabX,y+1,' · ',t['ink-3'],t.surface,false,w-3-(tabX-x));}
  line(2,`Filter: ${box.filter}█`,t.ink);
  let row=3;
  const start=Math.max(0,box.choice-3),visible=box.choices.slice(start,start+6);
  for(const [offset,choice]of visible.entries()){
   line(row++,`${start+offset===box.choice?'›':' '} ${choice.label} · ${engineLabel(choice.engine)} · ${choice.authLabel??'own login'}`,start+offset===box.choice?t.accent:t['ink-2']);
  }
  line(h-3,box.error?`✗ ${box.error}`:'←→ provider · ↑↓ model · ⏎ select · Esc back',box.error?t['status-error']:t['ink-3']);
  line(h-2,'own login → official CLI · Foundry key → ai term (or its CLI: /settings r)',t['ink-3']);
 }else{
  line(1,`Path: ${box.path||box.cwd}█`,t.ink);
  box.completions.slice(0,3).forEach((path,i)=>line(2+i,path,t['ink-3']));
  line(h-3,box.error?`✗ ${box.error}`:'⇥ complete · ⏎ select · Esc back',box.error?t['status-error']:t['ink-3']);
 }
 return grid.cells;
}

import type { SessionInfo,Status } from '../../shared/protocol.js';
import { textWidth } from '../../shared/unicode-width.js';
import { Grid,type Frame,safeText } from './grid.js';
import type { Theme } from './theme.js';
type BarSession=Pick<SessionInfo,'title'|'engine'|'model'|'status'|'branch'>&Partial<Pick<SessionInfo,'ctxPercent'>>;
const statuses:Record<Status,{glyph:string;word:string;color:'status-running'|'status-waiting'|'status-done'|'status-error'|'ink-3'}>={
 starting:{glyph:'◐',word:'starting',color:'ink-3'},running:{glyph:'◐',word:'running',color:'status-running'},waiting:{glyph:'●',word:'waiting',color:'status-waiting'},done:{glyph:'✓',word:'done',color:'status-done'},exited:{glyph:'○',word:'exited',color:'ink-3'},error:{glyph:'✗',word:'error',color:'status-error'},
};
export function frameBar(cols:number,session:BarSession,others:Pick<SessionInfo,'status'>[],theme:Theme):Frame {
 const grid=new Grid(cols,1,theme),bg=theme.colors.surface;grid.fill(0,0,cols,1,bg);
 const status=statuses[session.status],label=`${status.glyph} ${status.word}`,name=safeText(session.title),detail=`${session.engine} · ${session.model??'CLI default'}`;
 const counts=`others ◐ ${others.filter(s=>s.status==='running'||s.status==='starting'||s.status==='waiting').length}  ✓ ${others.filter(s=>s.status==='done').length}  ✗ ${others.filter(s=>s.status==='error').length}`;
 // Context % (v0.4.2): dropped after the counts and the branch, before the model.
 const ctx=session.engine!=='shell'&&typeof session.ctxPercent==='number'?`ctx ${Math.round(session.ctxPercent)}%`:'';
 const home='^E home';let showCounts=true,showModel=true,showBranch=!!session.branch,showCtx=!!ctx;
 const required=()=>textWidth(label)+2+textWidth(name)+2+(showModel?textWidth(detail)+2:0)+(showBranch?textWidth(session.branch??'')+3:0)+(showCtx?textWidth(ctx)+3:0)+(showCounts?textWidth(counts)+2:0)+textWidth(home)+2;
 if(required()>cols)showCounts=false;if(required()>cols)showBranch=false;if(required()>cols)showCtx=false;if(required()>cols)showModel=false;
 const homeWidth=textWidth(label)+textWidth(home)+3<=cols?textWidth(home)+2:0;
 const right=(showCounts?counts+'  ':'')+(homeWidth?home:'');
 const rightX=cols-textWidth(right)-1;let x=grid.text(1,0,label,theme.colors[status.color],bg);
 const shownDetail=(showModel?detail:session.engine)+(showBranch?` · ${session.branch}`:'')+(showCtx?` · ${ctx}`:'');
 const showDetail=(right?rightX-2:cols)-x>=textWidth(shownDetail)+2;
 const room=Math.max(0,(right?rightX-2:cols)-x-2-(showDetail?textWidth(shownDetail)+2:0));
 x=grid.text(x+2,0,name,theme.colors.ink,bg,true,room);
 if(showDetail)grid.text(x+2,0,shownDetail,theme.colors['ink-2'],bg);
 if(right)grid.text(rightX,0,right,theme.colors['ink-3'],bg);
 return grid.cells;
}

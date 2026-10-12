import {Grid,type Frame} from './grid.js';
import type {Theme} from './theme.js';
export function drawHelp(frame:Frame,lines:readonly string[],offset:number,theme:Theme):Frame{
 const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme);for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}
 const w=Math.min(cols,110),h=Math.max(8,rows-4),x=Math.floor((cols-w)/2),y=1,capacity=h-4,start=Math.max(0,Math.min(offset,Math.max(0,lines.length-capacity)));
 grid.box(x,y,w,h,`Help · ${start+1}–${Math.min(lines.length,start+capacity)} / ${lines.length}`,theme.colors.surface);
 lines.slice(start,start+capacity).forEach((line,i)=>grid.text(x+3,y+1+i,line,theme.colors['ink-2'],theme.colors.surface,false,w-6));grid.text(x+3,y+h-2,'↑↓ scroll · PgUp/PgDn page · Esc close',theme.colors['ink-3'],theme.colors.surface,false,w-6);return grid.cells;
}

import type {UsageSummary,Budgets} from '../../shared/protocol.js';
import type {Grid} from './grid.js';
import type {Theme} from './theme.js';
export function compactTokens(value:number):string{return value>=1e6?(value/1e6).toFixed(1)+'M':value>=1000?(value/1000).toFixed(1)+'K':String(value);}
export function budgetWarning(usage:UsageSummary|undefined|null,budgets:Budgets|undefined):string{
 if(!usage||!budgets)return '';for(const [key,period,label]of [['daily','today','today'],['weekly','week','week'],['monthly','month','month']]as const){const limit=budgets[key];if(limit!==null&&usage[period].costUsd>limit)return `budget: ${label} $${usage[period].costUsd.toFixed(2)} / $${limit}`;}return '';
}
export function drawUsage(grid:Grid,x:number,y:number,width:number,usage:UsageSummary|null|undefined,budgets:Budgets|undefined,theme:Theme):void{
 const colors=theme.colors;
 if(width<32){
  for(const [i,period]of ['today','week','month'].entries()){const summary=usage?.[period as keyof UsageSummary];grid.text(x,y+i,`${i===0?'≈ ':''}${period} ${summary?'$'+summary.costUsd.toFixed(2)+' '+compactTokens(summary.tokens):'—'}`,i===0?colors.ink:colors['ink-2'],colors.bg,i===0,width);}
  grid.text(x,y+3,'budget '+(budgets?.daily===undefined||budgets.daily===null?'none':'$'+budgets.daily),colors['ink-3'],colors.bg,false,width);
  grid.text(x,y+4,usage&&[usage.today,usage.week,usage.month].some(p=>p.unknownPrice)?'price ? · b add':'b add',colors['ink-3'],colors.bg,false,width);return;
 }
 const columns=[Math.max(10,width-31),Math.max(18,width-21),Math.max(26,width-11)];
 grid.text(x,y,'',colors['ink-3']);grid.text(x,y+1,'≈ spend',colors['ink-3']);grid.text(x,y+2,'tokens',colors['ink-3']);grid.text(x,y+3,'budget',colors['ink-3']);
 for(const [i,period]of ['today','week','month'].entries()){
  const col=x+(columns[i]??10),summary=usage?.[period as keyof UsageSummary];grid.text(col,y,period,colors['ink-3']);
  grid.text(col,y+1,summary?'$'+summary.costUsd.toFixed(2):'—',colors.ink,colors.bg,true,10);
  grid.text(col,y+2,summary?compactTokens(summary.tokens):'—',colors['ink-2'],colors.bg,false,10);
  const limit=budgets?.[(['daily','weekly','monthly']as const)[i]??'daily'];grid.text(col,y+3,limit===undefined||limit===null?'none':'$'+limit,colors['ink-3'],colors.bg,false,10);
 }
 const unknown=usage&&[usage.today,usage.week,usage.month].some(p=>p.unknownPrice);grid.text(x,y+4,unknown?'price ? · b add':'b add',colors['ink-3'],colors.bg,false,width);
}

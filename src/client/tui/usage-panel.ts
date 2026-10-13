import type {UsageSummary,UsagePeriod,Budgets} from '../../shared/protocol.js';
import type {Grid} from './grid.js';
import type {Theme} from './theme.js';
export function compactTokens(value:number):string{return value>=1e6?(value/1e6).toFixed(1)+'M':value>=1000?(value/1000).toFixed(1)+'K':String(value);}
// '≈ spend' plus one gap; a slot never grows past what '999.9K (999.9K cached)' needs, so wide panels stay compact.
const LABEL_W=8,MAX_SLOT=23;
// The cache-read share already inside the total: ' (71.0K cached)', or ' (71.0K)' when only the number fits.
function cachedText(period:UsagePeriod|undefined,form:'words'|'number'|'total'):string{const cached=period?.cachedTokens??0;return cached>0&&form!=='total'?` (${compactTokens(cached)}${form==='words'?' cached':''})`:'';}
// Cents when they fit, then whole dollars, then thousands: a clipped '$1234.5' would read as a different amount.
function spend(usd:number,width:number):string{return [`$${usd.toFixed(2)}`,`$${Math.round(usd)}`,`$${(usd/1000).toFixed(1)}K`,`$${Math.round(usd/1000)}K`].find(text=>text.length<=width)??`$${Math.round(usd/1000)}K`;}
export function budgetWarning(usage:UsageSummary|undefined|null,budgets:Budgets|undefined):string{
 if(!usage||!budgets)return '';for(const [key,period,label]of [['daily','today','today'],['weekly','week','week'],['monthly','month','month']]as const){const limit=budgets[key];if(limit!==null&&usage[period].costUsd>limit)return `budget: ${label} $${usage[period].costUsd.toFixed(2)} / $${limit}`;}return '';
}
export function drawUsage(grid:Grid,x:number,y:number,width:number,usage:UsageSummary|null|undefined,budgets:Budgets|undefined,theme:Theme):void{
 const colors=theme.colors;
 if(width<32){
  for(const [i,period]of ['today','week','month'].entries()){const summary=usage?.[period as keyof UsageSummary],end=grid.text(x,y+i,`${i===0?'≈ ':''}${period} ${summary?'$'+summary.costUsd.toFixed(2)+' '+compactTokens(summary.tokens):'—'}`,i===0?colors.ink:colors['ink-2'],colors.bg,i===0,width),cached=cachedText(summary,'words');if(cached&&end-x+cached.length<=width)grid.text(end,y+i,cached,colors['ink-3']);}
  grid.text(x,y+3,'budget '+(budgets?.daily===undefined||budgets.daily===null?'none':'$'+budgets.daily),colors['ink-3'],colors.bg,false,width);
  grid.text(x,y+4,usage&&[usage.today,usage.week,usage.month].some(p=>p.unknownPrice)?'price ? · b add':'b add',colors['ink-3'],colors.bg,false,width);return;
 }
 // Columns share the room after the widest label (≈ spend), so wider panels give the tokens row space for its cached share.
 const slot=Math.min(MAX_SLOT,Math.floor((width-LABEL_W)/3)),columns=[0,1,2].map(i=>LABEL_W+i*slot),room=(i:number)=>i<2?slot-1:width-(columns[i]??0);
 const periods=(['today','week','month']as const).map(period=>usage?.[period]);
 // One form for the whole row so the columns read alike: words, then the bare number with a legend, then totals alone.
 const form=(['words','number']as const).find(f=>periods.every((p,i)=>!p||compactTokens(p.tokens).length+cachedText(p,f).length<=room(i)))??'total';
 grid.text(x,y+1,'≈ spend',colors['ink-3']);grid.text(x,y+2,'tokens',colors['ink-3']);grid.text(x,y+3,'budget',colors['ink-3']);
 for(const [i,period]of ['today','week','month'].entries()){
  const col=x+(columns[i]??LABEL_W),summary=periods[i],w=room(i);grid.text(col,y,period,colors['ink-3']);
  grid.text(col,y+1,summary?spend(summary.costUsd,w):'—',colors.ink,colors.bg,true,w);
  const end=grid.text(col,y+2,summary?compactTokens(summary.tokens):'—',colors['ink-2'],colors.bg,false,w);grid.text(end,y+2,cachedText(summary,form),colors['ink-3'],colors.bg,false,col+w-end);
  const limit=budgets?.[(['daily','weekly','monthly']as const)[i]??'daily'];grid.text(col,y+3,limit===undefined||limit===null?'none':'$'+limit,colors['ink-3'],colors.bg,false,w);
 }
 const legend=form==='number'&&periods.some(p=>(p?.cachedTokens??0)>0)?'(…) cached · ':'',unknown=usage&&[usage.today,usage.week,usage.month].some(p=>p.unknownPrice);grid.text(x,y+4,legend+(unknown?'price ? · b add':'b add'),colors['ink-3'],colors.bg,false,width);
}

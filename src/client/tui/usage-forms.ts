import type {Budgets,KeyProvider,KeyView,ModelPrice,Settings} from '../../shared/protocol.js';
import {PRICED_BY_YOU,priceRows} from '../../shared/prices.js';
import {PROVIDER_LABELS} from '../../shared/providers.js';
import {isAgentCaps,type AgentCaps} from '../../shared/agent-facts.js';
import {isValidModelId,validateBudgets,validatePriceOverrides} from '../../shared/validate.js';
import {Grid,type Frame} from './grid.js';
import type {Theme} from './theme.js';
function amount(text:string):number|null{if(!text)return null;if(!/^\d+(?:\.\d+)?$/.test(text))throw new Error('Enter nonnegative USD amounts');const value=Number(text);if(!Number.isFinite(value)||value>1e9)throw new Error('Amount is too large');return value;}
export class BudgetForm {
 private fields:string[];private row=0;
 constructor(current:Budgets){this.fields=[current.daily,current.weekly,current.monthly].map(v=>v===null?'':String(v));}
 paste(text:string):void{this.fields[this.row]=(this.fields[this.row]??'')+text.slice(0,30);}
 key(key:string):void{if(key==='up'||key==='down')this.row=Math.max(0,Math.min(2,this.row+(key==='up'?-1:1)));else if(key==='backspace')this.fields[this.row]=(this.fields[this.row]??'').slice(0,-1);else if([...key].length===1)this.paste(key);}
 values():Budgets{return validateBudgets({daily:amount(this.fields[0]??''),weekly:amount(this.fields[1]??''),monthly:amount(this.fields[2]??'')});}
 lines():string[]{return ['Budget limits · USD',...['daily','weekly','monthly'].map((name,i)=>`${this.row===i?'›':' '} ${name}: ${this.fields[i]??''}█`),'empty = none · ↑↓ fields · ⏎ save · Esc cancel'];}
}
// B27: a price belongs to a provider and a model id (← → picks the provider: your keys' first). Input and output must be
// typed, so $0 is never a default; cache read is optional (empty: cached input costs the input price). Below the form,
// every price you set, once each (old records from before B27 as "any provider").
const usdText=(n:number)=>`$${n===0||n>=0.01?n.toFixed(2):String(n)}`;
export class PriceForm {
 private fields=['','','','',''];private row=0;private readonly providers:KeyProvider[];private choice=0;
 constructor(private readonly settings?:Pick<Settings,'priceOverrides'|'providerPrices'>,keys:readonly KeyView[]=[]){this.providers=[...new Set([...keys.map(k=>k.provider).filter(p=>PRICED_BY_YOU.includes(p)),...PRICED_BY_YOU])];}
 private get provider():KeyProvider{return this.providers[this.choice]??'foundry';}
 paste(text:string):void{if(this.row===0)return;this.fields[this.row]=((this.fields[this.row]??'')+text).slice(0,this.row===1?80:30);}
 key(key:string):void{
  if(key==='up'||key==='down'){this.row=Math.max(0,Math.min(4,this.row+(key==='up'?-1:1)));return;}
  if(this.row===0){if(key==='left'||key==='right'||key===' ')this.choice=(this.choice+(key==='left'?this.providers.length-1:1))%this.providers.length;return;}
  if(key==='backspace')this.fields[this.row]=(this.fields[this.row]??'').slice(0,-1);else if([...key].length===1)this.paste(key);
 }
 values():{provider:KeyProvider;model:string;price:ModelPrice}{
  const model=this.fields[1]??'';if(!isValidModelId(model))throw new Error('Enter the deployment or model id');
  const input=amount(this.fields[2]??''),output=amount(this.fields[3]??''),cacheRead=amount(this.fields[4]??'');
  if(input===null||output===null)throw new Error('Type the input and output price; 0 counts only typed');
  const price:ModelPrice={input,output,...(cacheRead===null?{}:{cacheRead})};validatePriceOverrides({[model]:price});
  return {provider:this.provider,model,price};
 }
 lines():string[]{
  const rows=priceRows(this.settings??{}),shown=rows.slice(0,8);
  return ['Your price · USD per 1M tokens · for a Foundry deployment or a model of a key',
   `${this.row===0?'›':' '} provider: ‹ ${PROVIDER_LABELS[this.provider]} ›`,
   ...['model or deployment','input','output','cache read (empty: the input price)'].map((name,i)=>`${this.row===i+1?'›':' '} ${name}: ${this.fields[i+1]??''}█`),
   '← → provider · ↑↓ fields · ⏎ save · Esc cancel',
   ...rows.length?['YOUR PRICES · USD per 1M in / out / cache',...shown.map(r=>`  ${r.provider==='any'?'any provider':PROVIDER_LABELS[r.provider]} · ${r.model} · ${usdText(r.price.input)} / ${usdText(r.price.output)} / ${r.price.cacheRead===undefined?'same as input':usdText(r.price.cacheRead)}`),...rows.length>shown.length?[`  +${rows.length-shown.length} more`]:[]]:[]];
 }
}
// AI Term agent's per-run caps (D53): the defaults a new run starts with; /caps changes one run.
export class CapsForm {
 private fields:string[];private row=0;
 constructor(current:AgentCaps){this.fields=[current.turns,current.spendUsd].map(v=>v===null?'':String(v));}
 paste(text:string):void{this.fields[this.row]=((this.fields[this.row]??'')+text).slice(0,12);}
 key(key:string):void{if(key==='up'||key==='down')this.row=Math.max(0,Math.min(1,this.row+(key==='up'?-1:1)));else if(key==='backspace')this.fields[this.row]=(this.fields[this.row]??'').slice(0,-1);else if([...key].length===1)this.paste(key);}
 values():AgentCaps{
  const turnsText=this.fields[0]??'',turns=turnsText?Number(turnsText):null,spendUsd=amount(this.fields[1]??'');
  const caps={turns,spendUsd};if(!isAgentCaps(caps)||turnsText&&!/^\d+$/.test(turnsText))throw new Error('Turns: a whole number above 0; spend: USD above 0; empty = no cap');
  return caps;
 }
 lines():string[]{return ['AI Term agent caps · per run',...['turns (model requests)','spend USD'].map((name,i)=>`${this.row===i?'›':' '} ${name}: ${this.fields[i]??''}█`),'a run pauses and asks at a cap · empty = no cap · ↑↓ fields · ⏎ save · Esc cancel'];}
}
export function drawUsageForm(frame:Frame,lines:string[],error:string,theme:Theme):Frame{const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme);for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}const w=Math.min(cols,90),h=Math.max(9,Math.min(rows-2,lines.length+3)),x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);grid.box(x,y,w,h,lines[0]??'',theme.colors.surface);lines.slice(1).forEach((text,i)=>grid.text(x+3,y+1+i,text,theme.colors['ink-2'],theme.colors.surface,false,w-6));if(error)grid.text(x+3,y+h-2,error,theme.colors['status-error'],theme.colors.surface,false,w-6);return grid.cells;}

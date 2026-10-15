import type {Budgets,ModelPrice} from '../../shared/protocol.js';
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
export class PriceForm {
 private fields=['','',''];private row=0;
 paste(text:string):void{this.fields[this.row]=((this.fields[this.row]??'')+text).slice(0,this.row===0?80:30);}
 key(key:string):void{if(key==='up'||key==='down')this.row=Math.max(0,Math.min(2,this.row+(key==='up'?-1:1)));else if(key==='backspace')this.fields[this.row]=(this.fields[this.row]??'').slice(0,-1);else if([...key].length===1)this.paste(key);}
 values():{model:string;price:ModelPrice}{const model=this.fields[0]??'',input=amount(this.fields[1]??''),output=amount(this.fields[2]??'');if(!isValidModelId(model)||input===null||output===null)throw new Error('Enter a deployment or model id and input/output prices');const price={input,output};validatePriceOverrides({[model]:price});return {model,price};}
 lines():string[]{return ['Price override · USD per 1M tokens · a Foundry deployment or any keyed model',...['deployment or model','input','output'].map((name,i)=>`${this.row===i?'›':' '} ${name}: ${this.fields[i]}█`),'↑↓ fields · ⏎ save · Esc cancel'];}
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
export function drawUsageForm(frame:Frame,lines:string[],error:string,theme:Theme):Frame{const rows=frame.length,cols=frame[0]?.length??0,grid=new Grid(cols,rows,theme);for(let y=0;y<rows;y++)for(let x=0;x<cols;x++){const cell=frame[y]?.[x];if(cell)grid.put(x,y,cell);}const w=Math.min(cols,90),h=9,x=Math.floor((cols-w)/2),y=Math.max(1,rows-4-h);grid.box(x,y,w,h,lines[0]??'',theme.colors.surface);lines.slice(1).forEach((text,i)=>grid.text(x+3,y+1+i,text,theme.colors['ink-2'],theme.colors.surface,false,w-6));if(error)grid.text(x+3,y+h-2,error,theme.colors['status-error'],theme.colors.surface,false,w-6);return grid.cells;}

import {EventEmitter} from 'node:events';
import type {UsageSummary,UsageDiagnostics,UsageDiagnostic} from '../shared/protocol.js';
import {UsageReceiver} from './usage-receiver.js';
import {UsageParser,type UsageContext} from './usage-parse.js';
import {UsageStore} from './usage.js';
import {SettingsStore} from './settings.js';
import {findPrice,estimateCost,type PriceSnapshot} from './usage-prices.js';
import prices from '../../data/usage-prices.json' with {type:'json'};
export interface UsageTelemetry {port:number;credential:string}
export class UsageService extends EventEmitter {
 private readonly store:UsageStore;private readonly receiver:UsageReceiver;private readonly parser:UsageParser;private readonly settings:SettingsStore;
 private observations:UsageDiagnostic[]=[];
 private midnight:ReturnType<typeof setTimeout>|undefined;
 constructor(root:string,log:{error(text:string):void}){super();this.store=new UsageStore(root,log);this.settings=new SettingsStore(root);this.parser=new UsageParser(entry=>{this.observations.push(entry);this.prune();});
  this.receiver=new UsageReceiver(async(route,raw,context)=>{
   const settings=await this.settings.get(),overrides=settings.priceOverrides??{};
   for(const record of this.parser.parse(route,raw,context)){if(record.costSource==='price-table')record.costUsd=estimateCost(findPrice(prices as PriceSnapshot,record.provider,record.model,overrides),record.inputTokens,record.outputTokens,record.cachedTokens??0);await this.store.add(record);}
  },log);
  this.store.on('warning',(on:boolean)=>this.emit('warning',on));this.store.on('updated',(usage:UsageSummary)=>this.emit('updated',usage));
 }
 async start():Promise<void>{await this.store.load();await this.receiver.listen();this.scheduleMidnight();}
 private scheduleMidnight():void{const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);this.midnight=setTimeout(()=>{this.emit('updated',this.summary());this.scheduleMidnight();},next.getTime()-now.getTime());this.midnight.unref();}
 register(context:UsageContext):UsageTelemetry{return {port:this.receiver.port(),credential:this.receiver.register(context)};}
 revoke(sessionId:string):void{this.receiver.revoke(sessionId);this.parser.revoke(sessionId);}
 summary():UsageSummary{return this.store.summary();}
 private prune():void{const cutoff=Date.now()-600000;this.observations=this.observations.filter(o=>Date.parse(o.at)>=cutoff).slice(-1000);}
 diagnostics():UsageDiagnostics{this.prune();return {port:this.receiver.port(),sessions:this.observations.map(o=>({...o,values:o.values.map(v=>({...v}))}))};}
 async close():Promise<void>{if(this.midnight)clearTimeout(this.midnight);await this.receiver.close();await this.store.flush();}
}

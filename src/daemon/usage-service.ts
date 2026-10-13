import {EventEmitter} from 'node:events';
import type {UsageSummary,UsageDiagnostics,UsageDiagnostic,Settings} from '../shared/protocol.js';
import {UsageReceiver} from './usage-receiver.js';
import {UsageParser,type UsageContext} from './usage-parse.js';
import {UsageStore} from './usage.js';
import {SettingsStore} from './settings.js';
import {findPrice,estimateCost,type PriceSnapshot} from './usage-prices.js';
import prices from '../../data/usage-prices.json' with {type:'json'};
// Twenty records per normal ten-second export leaves room for multiple models while bounding disk writes.
const RECORDS_PER_MINUTE=120;
export interface UsageTelemetry {port:number;credential:string}
export class UsageService extends EventEmitter {
 private readonly store:UsageStore;private readonly receiver:UsageReceiver;private readonly parser:UsageParser;private readonly settings:SettingsStore;
 private lastSettings:Settings={theme:'graphite'};private settingsFailed=false;
 private recordLimits=new Map<string,{start:number;count:number;logged:boolean}>();
 private observations:UsageDiagnostic[]=[];
 private midnight:ReturnType<typeof setTimeout>|undefined;
 constructor(root:string,private readonly log:{error(text:string):void}){super();this.store=new UsageStore(root,log);this.settings=new SettingsStore(root);this.parser=new UsageParser(entry=>{this.observations.push(entry);this.prune();});
  this.receiver=new UsageReceiver(async(route,raw,context)=>{
   const settings=await this.readSettings(),overrides=settings.priceOverrides??{};
   for(const record of this.parser.parse(route,raw,context)){if(!this.takeRecord(context.sessionId))continue;if(record.costSource==='price-table')record.costUsd=estimateCost(findPrice(prices as PriceSnapshot,record.provider,record.model,overrides),record.inputTokens,record.outputTokens,record.cachedTokens??0);await this.store.add(record);}
  },log,async(id,body,seq)=>{this.emit('claude-status',id,body,seq);});
  this.store.on('warning',(on:boolean)=>this.emit('warning',on));this.store.on('updated',(usage:UsageSummary)=>this.emit('updated',usage));
 }
 async start():Promise<void>{await this.readSettings();await this.store.load();await this.receiver.listen();this.scheduleMidnight();}
 private takeRecord(sessionId:string):boolean{
  const now=Date.now();let limit=this.recordLimits.get(sessionId);
  if(!limit||now-limit.start>=60000||now<limit.start){limit={start:now,count:0,logged:false};this.recordLimits.set(sessionId,limit);}
  if(limit.count<RECORDS_PER_MINUTE){limit.count++;return true;}
  if(!limit.logged){limit.logged=true;this.log.error('Usage record limit exceeded; excess records dropped');}return false;
 }
 private async readSettings():Promise<Settings>{
  try{this.lastSettings=await this.settings.get();if(this.settingsFailed){this.settingsFailed=false;this.emit('settingsWarning',false);}}
  catch{if(!this.settingsFailed){this.settingsFailed=true;this.log.error('Usage settings read failed; using last good prices');this.emit('settingsWarning',true);}}
  return this.lastSettings;
 }
 private scheduleMidnight():void{const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);this.midnight=setTimeout(()=>{this.emit('updated',this.summary());this.scheduleMidnight();},next.getTime()-now.getTime());this.midnight.unref();}
 registerStatus(sessionId:string):UsageTelemetry{return {port:this.receiver.port(),credential:this.receiver.registerStatus(sessionId)};}
 register(context:UsageContext):UsageTelemetry{return {port:this.receiver.port(),credential:this.receiver.register(context)};}
 revoke(sessionId:string):void{this.receiver.revoke(sessionId);this.parser.revoke(sessionId);this.recordLimits.delete(sessionId);}
 summary():UsageSummary{return this.store.summary();}
 private prune():void{const cutoff=Date.now()-600000;this.observations=this.observations.filter(o=>Date.parse(o.at)>=cutoff).slice(-1000);}
 diagnostics():UsageDiagnostics{this.prune();return {port:this.receiver.port(),sessions:this.observations.map(o=>({...o,values:o.values.map(v=>({...v}))}))};}
 async close():Promise<void>{if(this.midnight)clearTimeout(this.midnight);await this.receiver.close();this.recordLimits.clear();await this.store.flush();}
}

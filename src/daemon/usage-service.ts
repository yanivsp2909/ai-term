import {EventEmitter} from 'node:events';
import type {UsageSummary,UsageDiagnostics,UsageDiagnostic,Settings,UsageRecord} from '../shared/protocol.js';
import {UsageReceiver,type StatusEngine} from './usage-receiver.js';
import {UsageParser,type UsageContext} from './usage-parse.js';
import {UsageStore} from './usage.js';
import {SettingsStore} from './settings.js';
import {findPrice,estimateCost,deploymentAlias,type PriceSnapshot} from './usage-prices.js';
import prices from '../../data/usage-prices.json' with {type:'json'};
// Twenty records per normal ten-second export leaves room for multiple models while bounding disk writes.
const RECORDS_PER_MINUTE=120;
// AI Term's agent reports every request (up to three records each) as it happens, not every ten seconds: a fast tool loop
// must still be counted whole, or budgets (D49) would undercount it. Still bounded against a forging client.
const AGENT_RECORDS_PER_MINUTE=1800;
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
   for(const record of this.parser.parse(route,raw,context)){
    if(!this.takeRecord(context.sessionId,context.engine==='ai-term'?AGENT_RECORDS_PER_MINUTE:RECORDS_PER_MINUTE))continue;
    if(context.taskOnly){const tokens=record.inputTokens+record.outputTokens;if(tokens>0)this.emit('task',context.sessionId,tokens);continue;}
    if(record.costSource==='price-table')record.costUsd=estimateCost(findPrice(prices as PriceSnapshot,record.provider,record.model,overrides,record.provider==='foundry'?deploymentAlias(settings,record.model):undefined),record.inputTokens,record.outputTokens,record.cachedTokens??0);
    await this.add(record);
   }
  },log,async(id,body,seq,engine)=>{this.emit(engine==='codex'?'codex-status':engine==='ai-term'?'ai-term-status':'claude-status',id,body,seq);});
  this.store.on('warning',(on:boolean)=>this.emit('warning',on));this.store.on('updated',(usage:UsageSummary)=>this.emit('updated',usage));
 }
 // Every counted record also goes to its session's own total (cost per task, v0.6.1).
 private async add(record:UsageRecord):Promise<void>{const write=this.store.add(record);this.emit('record',{...record});await write;}
 // B25: a reservation whose usage will never arrive is booked at its worst case, as a usage record of its own.
 book(reservation:{sessionId:string;provider:UsageRecord['provider'];model:string;amountUsd:number}):Promise<void>{
  return this.add({ts:new Date().toISOString(),sessionId:reservation.sessionId,provider:reservation.provider,model:reservation.model,inputTokens:0,outputTokens:0,costUsd:reservation.amountUsd,costSource:'worst-case'});
 }
 async start():Promise<void>{await this.readSettings();await this.store.load();await this.receiver.listen();this.scheduleMidnight();}
 private takeRecord(sessionId:string,perMinute:number):boolean{
  const now=Date.now();let limit=this.recordLimits.get(sessionId);
  if(!limit||now-limit.start>=60000||now<limit.start){limit={start:now,count:0,logged:false};this.recordLimits.set(sessionId,limit);}
  if(limit.count<perMinute){limit.count++;return true;}
  if(!limit.logged){limit.logged=true;this.log.error('Usage record limit exceeded; excess records dropped');}return false;
 }
 private async readSettings():Promise<Settings>{
  try{this.lastSettings=await this.settings.get();if(this.settingsFailed){this.settingsFailed=false;this.emit('settingsWarning',false);}}
  catch{if(!this.settingsFailed){this.settingsFailed=true;this.log.error('Usage settings read failed; using last good prices');this.emit('settingsWarning',true);}}
  return this.lastSettings;
 }
 private scheduleMidnight():void{const now=new Date(),next=new Date(now.getFullYear(),now.getMonth(),now.getDate()+1);this.midnight=setTimeout(()=>{this.emit('updated',this.summary());this.scheduleMidnight();},next.getTime()-now.getTime());this.midnight.unref();}
 registerStatus(sessionId:string,engine:StatusEngine='claude-code'):UsageTelemetry{return {port:this.receiver.port(),credential:this.receiver.registerStatus(sessionId,engine)};}
 setAgentQuery(handler:(id:string,body:unknown)=>Promise<unknown>):void{this.receiver.setAgentQuery(handler);}
 enqueueStatus(sessionId:string,apply:(seq:number)=>void):boolean{return this.receiver.enqueueStatus(sessionId,apply);}
 register(context:UsageContext):UsageTelemetry{return {port:this.receiver.port(),credential:this.receiver.register(context)};}
 revoke(sessionId:string):void{this.receiver.revoke(sessionId);this.parser.revoke(sessionId);this.recordLimits.delete(sessionId);}
 summary():UsageSummary{return this.store.summary();}
 private prune():void{const cutoff=Date.now()-600000;this.observations=this.observations.filter(o=>Date.parse(o.at)>=cutoff).slice(-1000);}
 diagnostics():UsageDiagnostics{this.prune();return {port:this.receiver.port(),sessions:this.observations.map(o=>({...o,values:o.values.map(v=>({...v}))}))};}
 async close():Promise<void>{if(this.midnight)clearTimeout(this.midnight);await this.receiver.close();this.recordLimits.clear();await this.store.flush();}
}

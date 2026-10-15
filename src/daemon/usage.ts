import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,isFsError} from '../shared/paths.js';
import type {UsageRecord,UsageSummary,UsagePeriod} from '../shared/protocol.js';
import {validateUsageRecord} from '../shared/validate.js';
import { ownedByMe } from '../shared/owner.js';
async function append(path:string,record:UsageRecord):Promise<void>{
 const file=await open(path,constants.O_RDWR|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
 try{const stat=await file.stat();if(!stat.isFile()||!ownedByMe(stat))throw new Error('Unsafe usage file');await file.chmod(0o600);
  // ENOSPC can leave half a JSON line. Roll back before retrying instead of corrupting the next record.
  try{await file.writeFile(JSON.stringify(record)+'\n');await file.sync();}catch(error){await file.truncate(stat.size);throw error;}
 }finally{await file.close();}
}
// Each record is capped, but a long-lived forger could still push a sum past 2^53; saturate rather than emit an invalid summary.
const plus=(a:number,b:number)=>Math.min(Number.MAX_SAFE_INTEGER,a+b);
function empty():UsagePeriod{return {costUsd:0,tokens:0,cachedTokens:0,unknownPrice:false,providers:[]};}
export class UsageStore extends EventEmitter {
 private days=new Map<string,UsagePeriod>();private unsaved:UsageRecord[]=[];private queue:Promise<void>=Promise.resolve();private writeFailing=false;private loadFailed=false;private warned=false;
 private readonly folder:string;
 constructor(root:string,private readonly log:{error(text:string):void},private readonly now=()=>new Date(),private readonly writer=append){super();this.folder=join(root,'usage');}
 async load():Promise<void>{
  let names:string[];
  try{await privateDirectory(this.folder);names=(await readdir(this.folder)).sort();}catch(error){if(!isFsError(error,'ENOENT')){this.log.error('Usage history unavailable');this.loadFailed=true;this.warning();}return;}
  // One unsafe or unreadable month must not hide the others; its warning stays until the next start.
  for(const name of names)if(/^\d{4}-\d{2}\.jsonl$/.test(name)){
   try{const file=await open(join(this.folder,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||!ownedByMe(stat)||stat.size>64*1024*1024)throw new Error('Unsafe usage file');await file.chmod(0o600);for(const line of(await file.readFile('utf8')).split('\n'))if(line.trim()){try{this.aggregate(validateUsageRecord(JSON.parse(line)));}catch{this.log.error('Usage record unreadable; skipped');}}}finally{await file.close();}}
   catch{this.log.error('Usage history file unavailable; skipped');this.loadFailed=true;this.warning();}
  }
 }
 private warning(writeFailing=this.writeFailing):void{this.writeFailing=writeFailing;const value=this.loadFailed||writeFailing;if(this.warned===value)return;this.warned=value;this.emit('warning',value);}
 add(raw:UsageRecord):Promise<void>{const record=validateUsageRecord(raw);this.aggregate(record);this.unsaved.push({...record});this.emit('updated',this.summary());
  this.queue=this.queue.then(async()=>{try{await privateDirectory(this.folder);while(this.unsaved.length){const next=this.unsaved[0];if(!next)break;const date=new Date(next.ts),month=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;await this.writer(join(this.folder,month+'.jsonl'),next);this.unsaved.shift();}this.warning(false);}catch{this.log.error('Usage write failed; will retry on next change');this.warning(true);}});return this.queue;
 }
 private dateKey(date:Date):string{return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;}
 private aggregate(record:UsageRecord):void{
  const key=this.dateKey(new Date(record.ts));let day=this.days.get(key);if(!day){day=empty();this.days.set(key,day);}
  let provider=day.providers.find(p=>p.provider===record.provider);if(!provider){provider={provider:record.provider,costUsd:0,tokens:0,cachedTokens:0,unknownPrice:false};day.providers.push(provider);}
  for(const total of [day,provider]){total.tokens=plus(total.tokens,record.inputTokens+record.outputTokens);total.cachedTokens=plus(total.cachedTokens??0,record.cachedTokens??0);total.costUsd+=record.costUsd??0;total.unknownPrice ||= record.costUsd===null;}
 }
 summary():UsageSummary{
  const now=this.now(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),week=new Date(today);week.setDate(week.getDate()-((week.getDay()+6)%7));const month=new Date(now.getFullYear(),now.getMonth(),1),end=this.dateKey(now);
  const result:UsageSummary={today:empty(),week:empty(),month:empty()};
  // Incremental per-day buckets keep every export O(1); calendar rollovers sum only days, not all records.
  for(const [date,day]of this.days){if(date>end)continue;for(const [key,start]of [['today',today],['week',week],['month',month]]as const)if(date>=this.dateKey(start)){
   const total=result[key];total.costUsd+=day.costUsd;total.tokens=plus(total.tokens,day.tokens);total.cachedTokens=plus(total.cachedTokens??0,day.cachedTokens??0);total.unknownPrice ||= day.unknownPrice;
   for(const source of day.providers){let target=total.providers.find(v=>v.provider===source.provider);if(!target){target={provider:source.provider,costUsd:0,tokens:0,cachedTokens:0,unknownPrice:false};total.providers.push(target);}target.costUsd+=source.costUsd;target.tokens=plus(target.tokens,source.tokens);target.cachedTokens=plus(target.cachedTokens??0,source.cachedTokens??0);target.unknownPrice ||= source.unknownPrice;}
  }}return result;
 }
 async flush():Promise<void>{await this.queue;}
}

import {EventEmitter} from 'node:events';
import {constants} from 'node:fs';
import {open,readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {privateDirectory,isFsError} from '../shared/paths.js';
import type {UsageRecord,UsageSummary,UsagePeriod} from '../shared/protocol.js';
import {validateUsageRecord} from '../shared/validate.js';
async function append(path:string,record:UsageRecord):Promise<void>{
 const file=await open(path,constants.O_WRONLY|constants.O_APPEND|constants.O_CREAT|constants.O_NOFOLLOW|constants.O_NONBLOCK,0o600);
 try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.())throw new Error('Unsafe usage file');await file.chmod(0o600);await file.writeFile(JSON.stringify(record)+'\n');await file.sync();}finally{await file.close();}
}
function empty():UsagePeriod{return {costUsd:0,tokens:0,unknownPrice:false,providers:[]};}
export class UsageStore extends EventEmitter {
 private records:UsageRecord[]=[];private unsaved:UsageRecord[]=[];private queue:Promise<void>=Promise.resolve();private failing=false;
 private readonly folder:string;
 constructor(root:string,private readonly log:{error(text:string):void},private readonly now=()=>new Date(),private readonly writer=append){super();this.folder=join(root,'usage');}
 async load():Promise<void>{
  try{await privateDirectory(this.folder);for(const name of(await readdir(this.folder)).sort())if(/^\d{4}-\d{2}\.jsonl$/.test(name)){
   const file=await open(join(this.folder,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.size>64*1024*1024)throw new Error('Unsafe usage file');await file.chmod(0o600);for(const line of(await file.readFile('utf8')).split('\n'))if(line.trim()){try{this.records.push(validateUsageRecord(JSON.parse(line)));}catch{this.log.error('Usage record unreadable; skipped');}}}finally{await file.close();}
  }}catch(error){if(!isFsError(error,'ENOENT')){this.log.error('Usage history unavailable');this.warning(true);}}
 }
 private warning(value:boolean):void{if(this.failing===value)return;this.failing=value;this.emit('warning',value);}
 add(raw:UsageRecord):Promise<void>{const record=validateUsageRecord(raw);this.records.push({...record});this.unsaved.push({...record});this.emit('updated',this.summary());
  this.queue=this.queue.then(async()=>{try{await privateDirectory(this.folder);while(this.unsaved.length){const next=this.unsaved[0];if(!next)break;const date=new Date(next.ts),month=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}`;await this.writer(join(this.folder,month+'.jsonl'),next);this.unsaved.shift();}this.warning(false);}catch{this.log.error('Usage write failed; will retry on next change');this.warning(true);}});return this.queue;
 }
 summary():UsageSummary{
  const now=this.now(),today=new Date(now.getFullYear(),now.getMonth(),now.getDate()),week=new Date(today);week.setDate(week.getDate()-((week.getDay()+6)%7));const month=new Date(now.getFullYear(),now.getMonth(),1);
  const result:UsageSummary={today:empty(),week:empty(),month:empty()};
  for(const record of this.records){const at=new Date(record.ts);if(at>now)continue;for(const [key,start]of [['today',today],['week',week],['month',month]]as const)if(at>=start){const p=result[key];let provider=p.providers.find(v=>v.provider===record.provider);if(!provider){provider={provider:record.provider,costUsd:0,tokens:0,unknownPrice:false};p.providers.push(provider);}const tokens=record.inputTokens+record.outputTokens;for(const t of [p,provider]){t.tokens+=tokens;t.costUsd+=record.costUsd??0;t.unknownPrice ||= record.costUsd===null;}}}
  return result;
 }
 async flush():Promise<void>{await this.queue;}
}

import type {AgentEngine,KeyProvider,UsageRecord,UsageDiagnostic} from '../shared/protocol.js';
import {isValidModelId} from '../shared/validate.js';
export interface UsageContext {sessionId:string;engine:AgentEngine;provider:KeyProvider;model:string|null}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const list=(v:unknown):unknown[]=>Array.isArray(v)?v:[];
export function numeric(v:unknown):number|null{if(typeof v!=='number'&&!(typeof v==='string'&&/^\d+(?:\.\d+)?$/.test(v)))return null;const n=Number(v);return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:null;}
function stringAttribute(attrs:unknown,key:string):string|null{for(const raw of list(attrs)){const a=object(raw);if(a.key===key){const value=object(a.value).stringValue;return typeof value==='string'?value:null;}}return null;}
function numberAttribute(attrs:unknown,key:string):number|null{for(const raw of list(attrs)){const a=object(raw);if(a.key===key){const v=object(a.value);return numeric(v.intValue??v.doubleValue??v.stringValue);}}return null;}
const tokenNames=['input_token_count','output_token_count','cached_token_count','reasoning_token_count'] as const;
export class UsageParser {
 private seen=new Map<string,number>();private cumulative=new Map<string,number>();
 constructor(private readonly diagnostic:(entry:UsageDiagnostic)=>void,private readonly now=()=>Date.now()){}
 revoke(sessionId:string):void{for(const key of this.seen.keys())if(key.startsWith(sessionId+':'))this.seen.delete(key);for(const key of this.cumulative.keys())if(key.startsWith(sessionId+':'))this.cumulative.delete(key);}
 private duplicate(key:string):boolean{const now=this.now();for(const [id,at]of this.seen)if(now-at>3600000)this.seen.delete(id);if(this.seen.has(key))return true;if(this.seen.size>=10000){const first=this.seen.keys().next().value;if(first)this.seen.delete(first);}this.seen.set(key,now);return false;}
 private model(attrs:unknown,context:UsageContext):string{const model=stringAttribute(attrs,'model');return model&&isValidModelId(model)&&!model.startsWith('sk-')?model:context.model??'unknown';}
 private record(context:UsageContext,model:string):UsageRecord{return {ts:new Date(this.now()).toISOString(),sessionId:context.sessionId,provider:context.provider,model,inputTokens:0,outputTokens:0,costUsd:context.engine==='claude-code'?0:null,costSource:context.engine==='claude-code'?'cli-estimate':'price-table'};}
 parse(route:string,raw:unknown,context:UsageContext):UsageRecord[]{
  const records:UsageRecord[]=[];
  if(route==='/v1/metrics'&&context.engine==='claude-code')for(const resource of list(object(raw).resourceMetrics))for(const scope of list(object(resource).scopeMetrics))for(const metricRaw of list(object(scope).metrics)){
   const metric=object(metricRaw);if(metric.name!=='claude_code.token.usage'&&metric.name!=='claude_code.cost.usage')continue;
   const sum=object(metric.sum);for(const pointRaw of list(sum.dataPoints)){
    const point=object(pointRaw),model=this.model(point.attributes,context),type=metric.name==='claude_code.cost.usage'?'cost':stringAttribute(point.attributes,'type');if(!type||!['input','output','cacheRead','cacheCreation','cost'].includes(type))continue;
    let value=numeric(point.asInt??point.asDouble);if(value===null||type!=='cost'&&!Number.isSafeInteger(value))continue;
    this.diagnostic({sessionId:context.sessionId,at:new Date(this.now()).toISOString(),values:[{name:metric.name+'.'+type,value}]});
    const start=typeof point.startTimeUnixNano==='string'&&/^\d{1,30}$/.test(point.startTimeUnixNano)?point.startTimeUnixNano:'',time=typeof point.timeUnixNano==='string'&&/^\d{1,30}$/.test(point.timeUnixNano)?point.timeUnixNano:'';
    // Missing timestamps cannot be safely deduplicated, so never count that point.
    if(!time||this.duplicate(`${context.sessionId}:${model}:${type}:${start}:${time}`))continue;
    if(sum.aggregationTemporality===2||sum.aggregationTemporality==='AGGREGATION_TEMPORALITY_CUMULATIVE'){
     const key=`${context.sessionId}:${model}:${type}`,before=this.cumulative.get(key);this.cumulative.set(key,value);value=before!==undefined&&value>=before?value-before:value;
    }
    const record=this.record(context,model);if(type==='cost')record.costUsd=value;else if(type==='output')record.outputTokens=value;else {record.inputTokens=value;if(type==='cacheRead')record.cachedTokens=value;}
    if(value>0)records.push(record);
   }
  }
  if(route==='/v1/logs'&&context.engine==='codex')for(const resource of list(object(raw).resourceLogs))for(const scope of list(object(resource).scopeLogs))for(const rawRecord of list(object(scope).logRecords)){
   const log=object(rawRecord),attrs=log.attributes;if(stringAttribute(attrs,'event.name')!=='codex.sse_event'||stringAttribute(attrs,'event.kind')!=='response.completed')continue;
   const values=tokenNames.flatMap(name=>{const value=numberAttribute(attrs,name);return value!==null?[{name,value}]:[];});
   this.diagnostic({sessionId:context.sessionId,at:new Date(this.now()).toISOString(),values});
   const input=numberAttribute(attrs,'input_token_count'),output=numberAttribute(attrs,'output_token_count'),cached=numberAttribute(attrs,'cached_token_count')??0;
   if(input===null||output===null||![input,output,cached].every(Number.isSafeInteger)||cached>input)continue;
   const model=this.model(attrs,context),time=typeof log.timeUnixNano==='string'&&/^\d{1,30}$/.test(log.timeUnixNano)?log.timeUnixNano:'';
   if(!time||this.duplicate(`${context.sessionId}:${model}:codex:${time}`))continue;
   const record=this.record(context,model);record.inputTokens=input;record.outputTokens=output;record.cachedTokens=cached;records.push(record);
  }
  return records;
 }
}

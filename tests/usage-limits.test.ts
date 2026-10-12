import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile,mkdir,truncate} from 'node:fs/promises';
import {join} from 'node:path';
import {UsageParser} from '../src/daemon/usage-parse.js';
import {UsageStore} from '../src/daemon/usage.js';
import {validateUsageSummary} from '../src/shared/validate.js';
// A session's receiver credential lives in the agent's env/argv, so a prompt-injected agent can forge OTLP points.
const context={sessionId:randomUUID(),provider:'anthropic' as const,engine:'claude-code' as const,model:'sonnet'};
const point=(type:string,value:number,time:string)=>({attributes:[{key:'type',value:{stringValue:type}}],asInt:value,timeUnixNano:time});
const body=(points:unknown[],name='claude_code.token.usage')=>({resourceMetrics:[{scopeMetrics:[{metrics:[{name,sum:{aggregationTemporality:1,dataPoints:points}}]}]}]});
it('forged huge token and cost points never make the usage summary invalid',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-limits-');const logs:string[]=[];
 try{const parser=new UsageParser(()=>undefined),store=new UsageStore(root,{error:t=>{logs.push(t);}});await store.load();
  const max=Number.MAX_SAFE_INTEGER;
  for(const record of [...parser.parse('/v1/metrics',body([point('input',max,'1'),point('output',max,'2')]),context),...parser.parse('/v1/metrics',body([point('cost',9e15,'3')],'claude_code.cost.usage'),context)])await store.add(record);
  for(let i=0;i<3;i++)await store.add({ts:new Date().toISOString(),sessionId:context.sessionId,provider:'anthropic',model:'sonnet',inputTokens:900_000_000,outputTokens:900_000_000,costUsd:9000,costSource:'cli-estimate'});
  expect(()=>validateUsageSummary(store.summary())).not.toThrow();
  expect(store.summary().today.costUsd).toBeLessThan(1e5);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('an implausible stored record is skipped on load instead of breaking the summary',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-limits-');
 try{await mkdir(join(root,'usage'),{mode:0o700});const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const line=(n:number)=>JSON.stringify({ts:now.toISOString(),sessionId:context.sessionId,provider:'anthropic',model:'sonnet',inputTokens:n,outputTokens:n,costUsd:0,costSource:'cli-estimate'});
  await writeFile(join(root,'usage',month+'.jsonl'),[line(Number.MAX_SAFE_INTEGER),line(Number.MAX_SAFE_INTEGER),line(5)].join('\n')+'\n',{mode:0o600});
  const store=new UsageStore(root,{error:()=>undefined});await store.load();
  expect(()=>validateUsageSummary(store.summary())).not.toThrow();expect(store.summary().today.tokens).toBe(10);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('one unsafe month file does not hide the other months, and its warning stays until restart',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-limits-');const warnings:boolean[]=[];
 try{await mkdir(join(root,'usage'),{mode:0o700});const now=new Date(),month=`${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  await writeFile(join(root,'usage','2000-01.jsonl'),'',{mode:0o600});await truncate(join(root,'usage','2000-01.jsonl'),64*1024*1024+1);
  await writeFile(join(root,'usage',month+'.jsonl'),JSON.stringify({ts:now.toISOString(),sessionId:context.sessionId,provider:'anthropic',model:'sonnet',inputTokens:7,outputTokens:0,costUsd:0,costSource:'cli-estimate'})+'\n',{mode:0o600});
  const store=new UsageStore(root,{error:()=>undefined});store.on('warning',(on:boolean)=>warnings.push(on));await store.load();
  expect(store.summary().today.tokens).toBe(7);expect(warnings).toEqual([true]);
  await store.add({ts:now.toISOString(),sessionId:context.sessionId,provider:'anthropic',model:'sonnet',inputTokens:1,outputTokens:0,costUsd:0,costSource:'cli-estimate'});
  expect(warnings).toEqual([true]);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('dedupe memory stays bounded however many unique timestamps one session sends',()=>{
 const parser=new UsageParser(()=>undefined);
 for(let batch=0;batch<30;batch++)parser.parse('/v1/metrics',body(Array.from({length:10_000},(_,i)=>point('input',1,String(batch*10_000+i+1)))),context);
 const sizes=parser as unknown as {seen:Set<string>;cumulative:Map<string,number>};
 expect(sizes.seen.size).toBeLessThanOrEqual(100_000);expect(sizes.cumulative.size).toBeLessThanOrEqual(100_000);
});

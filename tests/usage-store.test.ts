import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {UsageStore} from '../src/daemon/usage.js';
const sessionId=randomUUID();const record=(ts:string)=>({ts,sessionId,provider:'openai' as const,model:'test',inputTokens:1000,outputTokens:100,cachedTokens:500,costUsd:0.2,costSource:'price-table' as const});
it('persists private usage records and rebuilds local today Monday-week month sums',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-store-'),now=new Date(2026,9,14,12);const log={error:()=>{}};
 try{const store=new UsageStore(root,log,()=>now);await store.load();await store.add(record(new Date(2026,9,14,10).toISOString()));await store.add(record(new Date(2026,9,12,10).toISOString()));await store.add(record(new Date(2026,9,11,10).toISOString()));await store.add({...record(new Date(2026,9,2,10).toISOString()),costUsd:null});
 expect(store.summary().today).toMatchObject({tokens:1100,costUsd:0.2});expect(store.summary().week).toMatchObject({tokens:2200,costUsd:0.4});expect(store.summary().month).toMatchObject({tokens:4400,costUsd:0.6,unknownPrice:true});
 expect((await lstat(join(root,'usage'))).mode&0o777).toBe(0o700);expect((await lstat(join(root,'usage/2026-10.jsonl'))).mode&0o777).toBe(0o600);
 const loaded=new UsageStore(root,log,()=>now);await loaded.load();expect(loaded.summary()).toEqual(store.summary());expect(await readFile(join(root,'usage/2026-10.jsonl'),'utf8')).not.toContain('credential');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('write failure warns without throwing and next change retries unsaved records',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-fail-');let fail=true,writes=0;const store=new UsageStore(root,{error:()=>{}},()=>new Date(),async()=>{writes++;if(fail)throw Object.assign(new Error('PRIVATE'),{code:'ENOSPC'});});const warnings:boolean[]=[];store.on('warning',value=>warnings.push(value));
 try{await store.load();await expect(store.add(record(new Date().toISOString()))).resolves.toBeUndefined();expect(warnings).toEqual([true]);fail=false;await store.add(record(new Date().toISOString()));expect(warnings).toEqual([true,false]);expect(writes).toBe(3);expect(store.summary().today.tokens).toBe(2200);}finally{await rm(root,{recursive:true,force:true});}
});

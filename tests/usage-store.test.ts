import {expect,it,vi} from 'vitest';
import * as fs from 'node:fs/promises';
vi.mock('node:fs/promises',async()=>{const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');return {...actual,open:vi.fn(actual.open)};});
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,lstat,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {UsageStore} from '../src/daemon/usage.js';
const sessionId=randomUUID();const record=(ts:string)=>({ts,sessionId,provider:'openai' as const,model:'test',inputTokens:1000,outputTokens:100,cachedTokens:500,costUsd:0.2,costSource:'price-table' as const});
it('persists private usage records and rebuilds local today Monday-week month sums',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-store-'),now=new Date(2026,9,14,12);const log={error:()=>{}};
 try{const store=new UsageStore(root,log,()=>now);await store.load();await store.add(record(new Date(2026,9,14,10).toISOString()));await store.add(record(new Date(2026,9,12,10).toISOString()));await store.add(record(new Date(2026,9,11,10).toISOString()));await store.add({...record(new Date(2026,9,2,10).toISOString()),costUsd:null});
 expect(store.summary().today).toMatchObject({tokens:1100,costUsd:0.2});expect(store.summary().week).toMatchObject({tokens:2200,costUsd:0.4});expect(store.summary().month).toMatchObject({tokens:4400,unknownPrice:true});
 expect(store.summary().month.costUsd).toBeCloseTo(0.6);
 expect((await lstat(join(root,'usage'))).mode&0o777).toBe(0o700);expect((await lstat(join(root,'usage/2026-10.jsonl'))).mode&0o777).toBe(0o600);
 const loaded=new UsageStore(root,log,()=>now);await loaded.load();expect(loaded.summary()).toEqual(store.summary());expect(await readFile(join(root,'usage/2026-10.jsonl'),'utf8')).not.toContain('credential');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('write failure warns without throwing and next change retries unsaved records',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-fail-');let fail=true,writes=0;const store=new UsageStore(root,{error:()=>{}},()=>new Date(),async()=>{writes++;if(fail)throw Object.assign(new Error('PRIVATE'),{code:'ENOSPC'});});const warnings:boolean[]=[];store.on('warning',value=>warnings.push(value));
 try{await store.load();await expect(store.add(record(new Date().toISOString()))).resolves.toBeUndefined();expect(warnings).toEqual([true]);fail=false;await store.add(record(new Date().toISOString()));expect(warnings).toEqual([true,false]);expect(writes).toBe(3);expect(store.summary().today.tokens).toBe(2200);}finally{await rm(root,{recursive:true,force:true});}
});
it('summary rolls local day and month boundaries without new telemetry',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-calendar-');let now=new Date(2026,9,31,23,59);const store=new UsageStore(root,{error:()=>{}},()=>now);
 try{await store.load();await store.add(record(new Date(2026,9,31,23,30).toISOString()));expect(store.summary().today.tokens).toBe(1100);now=new Date(2026,10,1,0,1);expect(store.summary().today.tokens).toBe(0);expect(store.summary().month.tokens).toBe(0);expect(store.summary().week.tokens).toBe(1100);}finally{await rm(root,{recursive:true,force:true});}
});
it('a partial append is rolled back before retry so restart keeps every successfully saved record',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-partial-'),real=(await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).open;let fail=true;const spy=vi.spyOn(fs,'open').mockImplementation(async(...args)=>{const file=await real(...args);if(String(args[0]).endsWith('.jsonl')&&fail){fail=false;const write=file.writeFile.bind(file);vi.spyOn(file,'writeFile').mockImplementationOnce(async()=>{await write('{"partial":');throw Object.assign(new Error('private disk detail'),{code:'ENOSPC'});});}return file;});
 try{const store=new UsageStore(root,{error:()=>{}});await store.load();await store.add(record(new Date().toISOString()));await store.add(record(new Date().toISOString()));const loaded=new UsageStore(root,{error:()=>{}});await loaded.load();expect(loaded.summary().today.tokens).toBe(2200);expect(loaded.summary()).toEqual(store.summary());}finally{spy.mockRestore();await rm(root,{recursive:true,force:true});}
});

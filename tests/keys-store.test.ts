import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { KeyStore } from '../src/daemon/keys.js';
const canary='sk-ant-'+'AITERMCANARY0000';
function vault(){const values=new Map<string,string>();return {values,read:async(a:string)=>values.get(a)??null,write:async(a:string,s:string)=>{values.set(a,s);},remove:async(a:string)=>{values.delete(a);}};}
it('stores only metadata and rolls back native entries when metadata cannot save',async()=>{
 const root=await mkdtemp('/tmp/ai-keys-'),native=vault(),store=new KeyStore(root,{vault:native});
 try{const key=await store.add({provider:'anthropic',label:'test',secret:canary});expect(key.last4).toBe('0000');expect(await store.list()).toEqual([key]);expect(await readFile(join(root,'settings.json'),'utf8')).not.toContain('AITERMCANARY');expect(await store.withSecret(key.id,s=>s===canary)).toBe(true);await store.remove(key.id);expect(native.values.size).toBe(0);expect(await store.list()).toEqual([]);
 await rm(join(root,'settings.json'));await writeFile(join(root,'settings.json'),'bad');await expect(store.add({provider:'anthropic',label:'fail',secret:canary})).rejects.toThrow('Key metadata could not be saved');expect(native.values.size).toBe(0);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('refuses unavailable keychain without leaking errors or writing plain secrets',async()=>{
 const root=await mkdtemp('/tmp/ai-key-fail-');try{const native=vault();native.write=async()=>{throw new Error(canary);};const store=new KeyStore(root,{vault:native});await expect(store.add({provider:'anthropic',label:'test',secret:canary})).rejects.toThrow('OS keychain unavailable');expect(await store.list()).toEqual([]);}finally{await rm(root,{recursive:true,force:true});}
});
it('scan/import retains only selected names and never changes env content or mtime',async()=>{
 const root=await mkdtemp('/tmp/ai-env-import-'),native=vault(),store=new KeyStore(root,{vault:native}),path=join(root,'input.env');
 try{await writeFile(path,`# test only\nANTHROPIC_API_KEY='${canary}'\nOPENAI_API_KEY=${canary}\nIGNORED=private\n`,{mode:0o600});const before=await stat(path),content=await readFile(path,'utf8');expect(await store.scanEnvFile(path)).toEqual([{name:'ANTHROPIC_API_KEY',provider:'anthropic'},{name:'OPENAI_API_KEY',provider:'openai'}]);const imported=await store.importEnv(path,['ANTHROPIC_API_KEY']);expect(imported).toHaveLength(1);expect(imported[0]?.provider).toBe('anthropic');expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);expect(await readFile(path,'utf8')).toBe(content);await store.remove(imported[0]?.id??'');expect(native.values.size).toBe(0);}finally{await rm(root,{recursive:true,force:true});}
});
it('native canary add/list/remove uses only a unique test service and removes every created entry',async()=>{
 const root=await mkdtemp('/tmp/ai-native-key-'),store=new KeyStore(root,{service:'ai-term-test-'+randomUUID()});let id:string|undefined;
 try{const key=await store.add({provider:'anthropic',label:'canary',secret:canary});id=key.id;expect(await store.list()).toEqual([key]);expect(await store.withSecret(id,s=>s===canary)).toBe(true);await store.remove(id);expect(await store.hasCredential('anthropic',id)).toBe(false);id=undefined;}finally{if(id)await store.remove(id);await rm(root,{recursive:true,force:true});}
},15000);

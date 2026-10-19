import {expect,it} from 'vitest';
import {mkdtemp,rm,writeFile,readFile,stat} from 'node:fs/promises';
import {join} from 'node:path';
import {KeyStore,KeyError,type KeyVault} from '../src/daemon/keys.js';
import {getPaths,preparePaths} from '../src/shared/paths.js';
async function store(vault?:(values:Map<string,string>)=>KeyVault){const root=await mkdtemp('/tmp/ai-key-edge-');await preparePaths(getPaths(root));const values=new Map<string,string>();
 const keys=new KeyStore(root,{vault:vault?.(values)??{read:async a=>values.get(a)??null,write:async(a,s)=>{values.set(a,s);},remove:async a=>{values.delete(a);}}});return {root,values,keys};}
it('a quoted .env value followed by a comment imports without its quotes, and the file is unchanged',async()=>{
 const {root,values,keys}=await store();
 try{const path=join(root,'creds.env');await writeFile(path,'ANTHROPIC_API_KEY="sk-ant-' + 'quotedvalue1234" # work\nOPENAI_API_KEY=\'sk-openai-single9876\'   # personal\n',{mode:0o600});const before=await stat(path),content=await readFile(path,'utf8');
  const keysOut=await keys.importEnv(path,['ANTHROPIC_API_KEY','OPENAI_API_KEY']);
  expect([...values.values()].sort()).toEqual(['sk-ant' + '-quotedvalue1234','sk-openai-single9876']);expect(keysOut.map(k=>k.last4).sort()).toEqual(['1234','9876']);
  expect(await readFile(path,'utf8')).toBe(content);expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
 }finally{await rm(root,{recursive:true,force:true});}
});
it('a short secret never shows four of its characters',async()=>{
 const {root,keys}=await store();
 try{for(const secret of ['abcde','abcdefghijkl'])expect((await keys.add({provider:'anthropic',label:'short',secret})).last4).toBe('');
  expect((await keys.add({provider:'anthropic',label:'long',secret:'sk-ant-'+'x'.repeat(30)+'WXYZ'})).last4).toBe('WXYZ');
 }finally{await rm(root,{recursive:true,force:true});}
});
it('a failed import keeps its own error and removes every entry it created even when one removal fails',async()=>{
 let writes=0,failRemove=true;
 const {root,values,keys}=await store(values=>({read:async a=>values.get(a)??null,write:async(a,s)=>{if(++writes===3)throw new Error('locked');values.set(a,s);},remove:async a=>{if(failRemove){failRemove=false;throw new Error('locked');}values.delete(a);}}));
 try{const path=join(root,'creds.env');await writeFile(path,'ANTHROPIC_API_KEY=sk-ant-' + 'firstvalue1111\nOPENAI_API_KEY=sk-ope' + 'nai-secondvalue2222\nAZURE_OPENAI_API_KEY=azurevalue33333333333\nAZURE_OPENAI_ENDPOINT=https://x.openai.azure.com/openai/v1\nAZURE_OPENAI_DEPLOYMENT=gpt\n',{mode:0o600});
  const error=await keys.importEnv(path,['ANTHROPIC_API_KEY','OPENAI_API_KEY','AZURE_OPENAI_API_KEY']).catch((e:unknown)=>e);
  expect(error).toBeInstanceOf(KeyError);expect((error as Error).message).toMatch(/could not be removed/);expect((error as Error).message).not.toMatch(/value/);
  // One removal failed; the other created entry is still rolled back.
  expect(values.size).toBe(1);
 }finally{await rm(root,{recursive:true,force:true});}
});

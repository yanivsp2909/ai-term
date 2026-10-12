import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { KeyProvider, KeyView, DeploymentTest } from '../shared/protocol.js';
import { ENV_KEY_NAMES, isEndpoint, isSecret, isUUID, validateKeyView, validateDeploymentTests } from '../shared/validate.js';
import { SettingsStore } from './settings.js';
export class KeyError extends Error {}
export interface KeyVault { read(account:string):Promise<string|null>; write(account:string,secret:string):Promise<void>; remove(account:string):Promise<void> }
function nativeVault(service:string):KeyVault {
 const entry=async(account:string)=>{const {AsyncEntry}=await import('@napi-rs/keyring');return new AsyncEntry(service,account,{linux:{store:'secret-service'}});};
 return {read:async account=>(await entry(account)).getPassword(),write:async(account,secret)=>(await entry(account)).setPassword(secret),remove:async account=>{await(await entry(account)).deletePassword();}};
}
export class KeyStore {
 private readonly settings:SettingsStore;
 private readonly vault:KeyVault;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(root:string,options:{service?:string;vault?:KeyVault}={}){
  if(options.service!==undefined&&!/^ai-term-test-[A-Za-z0-9-]+$/.test(options.service))throw new KeyError('Invalid test keychain service');
  this.settings=new SettingsStore(root);this.vault=options.vault??nativeVault(options.service??'ai-term');
 }
 async list():Promise<KeyView[]>{const keys=(await this.settings.get()).keys??[];if(!Array.isArray(keys)||keys.length>100)throw new KeyError('Invalid key metadata');return keys.map(validateKeyView);}
 async view(id:string):Promise<KeyView>{if(!isUUID(id))throw new KeyError('Invalid key id');const key=(await this.list()).find(k=>k.id===id);if(!key)throw new KeyError('Key not found');return key;}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work);this.queue=next.then(()=>undefined,()=>undefined);return next;}
 async add(request:{provider:KeyProvider;label:string;secret:string;endpoint?:string;deployments?:string[]}):Promise<KeyView>{
  if(!isSecret(request.secret))throw new KeyError('Invalid key details');
  const key=validateKeyView({id:randomUUID(),provider:request.provider,label:request.label,last4:request.secret.slice(-4),...(request.endpoint!==undefined?{endpoint:request.endpoint}:{}),...(request.deployments!==undefined?{deployments:request.deployments}: {})});
  if(key.provider==='foundry'&&(!isEndpoint(key.endpoint)||!key.deployments?.length))throw new KeyError('Foundry needs an endpoint and deployments');
  const account=`${key.provider}:${key.id}`;
  return this.serial(async()=>{
   try{await this.vault.write(account,request.secret);}catch{throw new KeyError('OS keychain unavailable; key was not saved');}
   try{await this.settings.update(async settings=>{const keys=Array.isArray(settings.keys)?settings.keys.map(validateKeyView):[];if(keys.length>=100)throw new Error('Too many keys');return {...settings,keys:[...keys,key]};});}
   catch{try{await this.vault.remove(account);}catch{throw new KeyError('Key metadata failed and keychain cleanup failed; remove the new test entry in Keychain Access');}throw new KeyError('Key metadata could not be saved');}
   return key;
  });
 }
 async remove(id:string):Promise<void>{await this.serial(async()=>{const key=await this.view(id);try{await this.vault.remove(`${key.provider}:${id}`);}catch{throw new KeyError('OS keychain unavailable; key was not removed');}try{await this.settings.update(async s=>({...s,keys:(Array.isArray(s.keys)?s.keys.map(validateKeyView):[]).filter(k=>k.id!==id)}));}catch{throw new KeyError('Key removed from keychain; metadata could not be saved');}});}
 async hasCredential(provider:KeyProvider,id:string):Promise<boolean>{if(!isUUID(id))throw new KeyError('Invalid key id');try{return await this.vault.read(`${provider}:${id}`)!==null;}catch{throw new KeyError('OS keychain unavailable');}}
 async withSecret<T>(id:string,use:(secret:string)=>T|Promise<T>):Promise<T>{
  const key=await this.view(id);let secret:string|null;
  try{secret=await this.vault.read(`${key.provider}:${id}`);}catch{throw new KeyError('OS keychain unavailable');}
  if(!secret||!isSecret(secret))throw new KeyError('Key is missing from the OS keychain');
  try{return await use(secret);}finally{secret=null;}
 }
 async saveTest(id:string,results:DeploymentTest[]):Promise<void>{validateDeploymentTests(results);await this.serial(async()=>{await this.view(id);await this.settings.update(async s=>({...s,keys:(Array.isArray(s.keys)?s.keys.map(validateKeyView):[]).map(k=>k.id===id?{...k,lastTest:results}:k)}));});}
 private async envFile(path:string):Promise<Map<string,string>>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||stat.uid!==process.getuid?.()||stat.size>1024*1024)throw new KeyError('Env file must be a small regular file owned by you');
   const entries=new Map<string,string>();for(const line of (await file.readFile('utf8')).split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(!m)continue;
    const name=m[1]??'';if(!Object.hasOwn(ENV_KEY_NAMES,name)&&!['AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT'].includes(name))continue;
    let value=m[2]??'';if(value.startsWith('"')&&value.endsWith('"')||value.startsWith("'")&&value.endsWith("'"))value=value.slice(1,-1);else value=value.replace(/\s+#.*$/,'');
    if(entries.has(name))throw new KeyError('Env file contains duplicate import fields');entries.set(name,value);
   }return entries;
  }finally{await file.close();}
 }
 async scanEnvFile(path:string):Promise<{name:string;provider:KeyProvider}[]>{const entries=await this.envFile(path);return [...entries.keys()].flatMap(name=>Object.hasOwn(ENV_KEY_NAMES,name)?[{name,provider:ENV_KEY_NAMES[name] as KeyProvider}]:[]);}
 async importEnv(path:string,names:string[]):Promise<KeyView[]>{
  if(!names.length||names.some(n=>!Object.hasOwn(ENV_KEY_NAMES,n))||new Set(names).size!==names.length)throw new KeyError('Invalid env import selection');
  const entries=await this.envFile(path),created:KeyView[]=[];
  try{for(const name of names){const secret=entries.get(name);if(!secret||!isSecret(secret))throw new KeyError('Selected env key is missing or invalid');const provider=ENV_KEY_NAMES[name] as KeyProvider;
   const endpoint=entries.get('AZURE_OPENAI_ENDPOINT'),deployment=entries.get('AZURE_OPENAI_DEPLOYMENT');
   if(provider==='foundry'&&(!endpoint||!deployment))throw new KeyError('Foundry import needs AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT');
   created.push(await this.add({provider,label:name,secret,...(provider==='foundry'?{endpoint,deployments:[deployment??'']}: {})}));
  }return created;}catch(error){for(const key of created)await this.remove(key.id);throw error;}finally{entries.clear();}
 }
}

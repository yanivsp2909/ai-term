import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { Logger } from './log.js';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { KeyProvider, KeyView, DeploymentTest } from '../shared/protocol.js';
import { ENV_KEY_NAMES, isEndpoint, isSecret, isUUID, isValidModelId, validateKeyView, validateDeploymentTests } from '../shared/validate.js';
import { SettingsStore } from './settings.js';
import { isExtensionId } from '../shared/extensions.js';
import { isMcpHash, isMcpEnv, isMcpHeader } from '../shared/validate.js';
import { lastFour } from '../shared/text-cut.js';
import { hasModelList, isBedrockEndpoint, isBoundProvider, isLocalEndpoint } from '../shared/providers.js';
import { ownedByMe } from '../shared/owner.js';
export class KeyError extends Error {}
// One clear line when the system's key store can't be used. Linux (v0.8.1) keeps keys only in the Secret Service
// (GNOME Keyring, KWallet); headless, locked or missing, key features refuse, and there is never a file fallback.
export function keychainUnavailable(platform: NodeJS.Platform = process.platform): string {
 return platform === 'linux' ? 'No Secret Service keyring (none running, or it is locked); API keys need one, and AI Term never stores them in a file' : platform === 'win32' ? 'Windows Credential Manager unavailable' : 'OS keychain unavailable';
}
const UNAVAILABLE = keychainUnavailable(), NOT_SAVED = `${UNAVAILABLE}; key was not saved`, NOT_REMOVED = `${UNAVAILABLE}; key was not removed`;
export const KEYCHAIN_ERRORS: readonly string[] = [UNAVAILABLE, NOT_SAVED, NOT_REMOVED];
// B12: settings.json is writable by anything running as the user, so a Foundry key's endpoint and deployments are
// stored with the secret in its Keychain entry, and only those bound values ever decide where the secret goes.
export interface FoundryBinding { endpoint: string; deployments: string[] }
const FOUNDRY_CHANGED='Foundry key details changed outside AI Term; add the key again',FOUNDRY_UNBOUND='Foundry key must be added again to bind its endpoint';
// v0.6.5: Bedrock's host is its region, bound the same way. Ollama has no key, so no Keychain entry at all.
const BEDROCK_CHANGED='Bedrock key details changed outside AI Term; add the key again',OLLAMA_NO_KEY='Ollama has no key';
function foundryEntry(secret:string,binding:FoundryBinding):string{return JSON.stringify({v:1,secret,endpoint:binding.endpoint,deployments:binding.deployments});}
// A bare secret (saved before binding existed) or anything malformed is unbound: never trusted on first use.
function parseFoundryEntry(raw:string,provider:'foundry'|'bedrock'='foundry'):{secret:string;binding:FoundryBinding}|null{
 let value:unknown;try{value=JSON.parse(raw);}catch{return null;}
 if(!value||typeof value!=='object'||Array.isArray(value))return null;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==4||v.v!==1||!isSecret(v.secret)||typeof v.endpoint!=='string'||!(provider==='bedrock'?isBedrockEndpoint(v.endpoint):isEndpoint(v.endpoint))||!Array.isArray(v.deployments)||!v.deployments.length||v.deployments.length>40||!v.deployments.every(isValidModelId))return null;
 return {secret:v.secret,binding:{endpoint:v.endpoint,deployments:[...v.deployments]}};
}
export interface KeyVault { read(account:string):Promise<string|null>; write(account:string,secret:string):Promise<void>; remove(account:string):Promise<void> }
function nativeVault(service:string):KeyVault {
 const entry=async(account:string)=>{const {AsyncEntry}=await import('@napi-rs/keyring');return new AsyncEntry(service,account,{linux:{store:'secret-service'}});};
 return {read:async account=>(await entry(account)).getPassword(),write:async(account,secret)=>(await entry(account)).setPassword(secret),remove:async account=>{await(await entry(account)).deletePassword();}};
}
export class KeyStore extends EventEmitter {
 private metadataWarning=false;
 private readonly settings:SettingsStore;
 private readonly vault:KeyVault;
 private readonly log:Logger;
 private readonly service:string;
 private queue:Promise<unknown>=Promise.resolve();
 constructor(root:string,options:{service?:string;vault?:KeyVault}={}){
  super();
  if(options.service!==undefined&&!/^ai-term-test-[A-Za-z0-9-]+$/.test(options.service))throw new KeyError('Invalid test keychain service');
  const log=new Logger(join(root,'logs','daemon.log'));this.log=log;this.service=options.service??'ai-term';
  this.settings=new SettingsStore(root,()=>{if(!this.metadataWarning){this.metadataWarning=true;log.error('Invalid key metadata entry skipped');this.emit('warning','Invalid key metadata entry skipped; other keys remain usable.');}});this.vault=options.vault??nativeVault(options.service??'ai-term');
 }
 async list():Promise<KeyView[]>{const keys=(await this.settings.get()).keys??[];if(!Array.isArray(keys)||keys.length>100)throw new KeyError('Invalid key metadata');return keys.map(validateKeyView);}
 // MCP values have their own account kind and a binding to the exact approved configuration, never provider accounts.
 private mcpAccount(server:string,name:string):string{if(!isExtensionId(server)||!isMcpEnv(name)&&!isMcpHeader(name))throw new KeyError('Invalid MCP secret reference');return `mcp:${server}:${name}`;}
 async saveMcp(server:string,name:string,secret:string,hash:string):Promise<string>{
  const account=this.mcpAccount(server,name);if(!isMcpHash(hash)||!secret||Buffer.byteLength(secret)>2048||/[\p{C}]/u.test(secret))throw new KeyError('Invalid MCP secret');
  try{await this.vault.write(account,JSON.stringify({v:1,secret,hash}));}catch{throw new KeyError('MCP keychain write failed');}return lastFour(secret);
 }
 // Every name is tried even after one fails, so one locked entry doesn't leave the rest behind.
 async removeMcp(server:string,names:string[]):Promise<void>{let failed=false;for(const name of names){try{await this.vault.remove(this.mcpAccount(server,name));}catch{failed=true;}}if(failed)throw new KeyError('MCP keychain remove failed');}
 async withMcp<T>(server:string,names:string[],hash:string,use:(values:Record<string,string>)=>Promise<T>):Promise<T>{
  if(!isMcpHash(hash))throw new KeyError('Invalid MCP binding');const values:Record<string,string>={};
  try{for(const name of names){let raw:string|null;try{raw=await this.vault.read(this.mcpAccount(server,name));}catch{throw new KeyError('MCP keychain read failed');}
   let entry:unknown;try{entry=raw?JSON.parse(raw) as unknown:null;}catch{throw new KeyError('MCP secret is unavailable');}
   if(!entry||typeof entry!=='object'||Array.isArray(entry)||!('hash'in entry)||entry.hash!==hash||!('secret'in entry)||typeof entry.secret!=='string'||!entry.secret)throw new KeyError('MCP configuration changed; add or approve it again');values[name]=entry.secret;
  }return await use(values);}finally{for(const name of Object.keys(values))delete values[name];}
 }
 async view(id:string):Promise<KeyView>{if(!isUUID(id))throw new KeyError('Invalid key id');const key=(await this.list()).find(k=>k.id===id);if(!key)throw new KeyError('Key not found');return key;}
 // The key store's own failure, by kind only (its message could carry anything): the user sees the fixed line, the log
 // says which call failed and how (gate: every cause looked like a missing keyring).
 private vaultFailed(call:string,error:unknown):void{const code=error instanceof Error&&'code' in error&&typeof error.code==='string'&&/^[A-Za-z_]{1,32}$/.test(error.code)?error.code:error instanceof Error?error.constructor.name.slice(0,32):'unknown';this.log.error(`Keychain ${call} failed (${code})`);}
 private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work);this.queue=next.then(()=>undefined,()=>undefined);return next;}
 async add(request:{provider:KeyProvider;label:string;secret?:string;endpoint?:string;deployments?:string[]}):Promise<KeyView>{
  if(request.provider==='ollama')return this.addLocal(request);
  const secret=request.secret;
  if(!isSecret(secret))throw new KeyError('Invalid key details');
  if([request.label,request.endpoint,...request.deployments??[]].some(value=>typeof value==='string'&&value.includes(secret)))throw new KeyError('Key details must not contain the secret');
  let key:KeyView;
  try{key=validateKeyView({id:randomUUID(),provider:request.provider,label:request.label,last4:lastFour(secret),...(request.endpoint!==undefined?{endpoint:request.endpoint}:{}),...(request.deployments!==undefined?{deployments:request.deployments}: {})});}
  catch{throw new KeyError(request.provider==='foundry'?'Foundry needs an endpoint and deployments':'Invalid key details');}
  if(key.provider==='foundry'&&(!isEndpoint(key.endpoint)||!key.deployments?.length))throw new KeyError('Foundry needs an endpoint and deployments');
  // A key that carries its own models must name at least one: its test is what offers them (v0.6.5).
  if(hasModelList(key.provider)&&!key.deployments?.length)throw new KeyError('Invalid key details');
  const account=`${key.provider}:${key.id}`;
  return this.serial(async()=>{
   const stored=isBoundProvider(key.provider)?foundryEntry(secret,{endpoint:key.endpoint??'',deployments:key.deployments??[]}):secret;
   try{await this.vault.write(account,stored);}catch(error){this.vaultFailed('write',error);throw new KeyError(NOT_SAVED,{cause:new Error('Keychain write failed')});}
   try{await this.settings.update(async settings=>{const keys=Array.isArray(settings.keys)?settings.keys.map(validateKeyView):[];if(keys.length>=100)throw new Error('Too many keys');return {...settings,keys:[...keys,key]};});}
   catch{try{await this.vault.remove(account);}catch{
    // The account names a provider and a UUID, never the secret: without it the orphaned entry can't be found.
    this.log.error(`Keychain cleanup failed; remove ${this.service} ${account} in Keychain Access`);
    throw new KeyError('Key metadata failed and keychain cleanup failed; remove the new test entry in Keychain Access',{cause:new Error('Keychain cleanup failed')});}throw new KeyError('Key metadata could not be saved');}
   return key;
  });
 }
 // Ollama: metadata only. It has no secret, so nothing goes to the Keychain and nothing is read from it later.
 private addLocal(request:{label:string;secret?:string;endpoint?:string;deployments?:string[]}):Promise<KeyView>{
  if(request.secret!==undefined||!isLocalEndpoint(request.endpoint))throw new KeyError('Invalid key details');
  let key:KeyView;
  try{key=validateKeyView({id:randomUUID(),provider:'ollama',label:request.label,last4:'',endpoint:request.endpoint,...(request.deployments!==undefined?{deployments:request.deployments}: {})});}catch{throw new KeyError('Invalid key details');}
  return this.serial(async()=>{
   try{await this.settings.update(async settings=>{const keys=Array.isArray(settings.keys)?settings.keys.map(validateKeyView):[];if(keys.length>=100)throw new Error('Too many keys');return {...settings,keys:[...keys,key]};});}
   catch{throw new KeyError('Key metadata could not be saved');}
   return key;
  });
 }
 // Ollama's models come from its own listing; each listed model counts as tested (the listing was the check).
 async saveModels(id:string,models:string[]):Promise<KeyView>{
  return this.serial(async()=>{
   const key=await this.view(id);if(key.provider!=='ollama')throw new KeyError('Invalid key details');
   const updated=validateKeyView({...key,deployments:models,lastTest:models.map(model=>({model,status:'ready'}))});
   await this.settings.update(async s=>({...s,keys:(Array.isArray(s.keys)?s.keys.map(validateKeyView):[]).map(k=>k.id===id?updated:k)}));
   return updated;
  });
 }
 async remove(id:string):Promise<void>{await this.serial(async()=>{const key=await this.view(id);if(key.provider!=='ollama')try{await this.vault.remove(`${key.provider}:${id}`);}catch(error){this.vaultFailed('remove',error);throw new KeyError(NOT_REMOVED,{cause:new Error('Keychain remove failed')});}try{await this.settings.update(async s=>({...s,keys:(Array.isArray(s.keys)?s.keys.map(validateKeyView):[]).filter(k=>k.id!==id)}));}catch{throw new KeyError('Key removed from keychain; metadata could not be saved');}});}
 async hasCredential(provider:KeyProvider,id:string):Promise<boolean>{if(!isUUID(id))throw new KeyError('Invalid key id');if(provider==='ollama')return false;try{return await this.vault.read(`${provider}:${id}`)!==null;}catch(error){this.vaultFailed('read',error);throw new KeyError(UNAVAILABLE,{cause:new Error('Keychain read failed')});}}
 // For a Foundry key, use receives the Keychain-bound endpoint and deployments; callers must send the secret only there.
 async withSecret<T>(id:string,use:(secret:string,binding:FoundryBinding|null)=>T|Promise<T>):Promise<T>{
  const key=await this.view(id);let secret:string|null;
  if(key.provider==='ollama')throw new KeyError(OLLAMA_NO_KEY);
  try{secret=await this.vault.read(`${key.provider}:${id}`);}catch(error){this.vaultFailed('read',error);throw new KeyError(UNAVAILABLE,{cause:new Error('Keychain read failed')});}
  if(!secret)throw new KeyError('Key is missing from the OS keychain');
  let binding:FoundryBinding|null=null;
  if(isBoundProvider(key.provider)){
   // Bedrock was bound from its first day, so an unbound entry is as changed as a differing copy.
   const changed=key.provider==='bedrock'?BEDROCK_CHANGED:FOUNDRY_CHANGED;
   const entry=parseFoundryEntry(secret,key.provider);if(!entry)throw new KeyError(key.provider==='bedrock'?BEDROCK_CHANGED:FOUNDRY_UNBOUND);
   if(entry.binding.endpoint!==key.endpoint||entry.binding.deployments.join('\n')!==(key.deployments??[]).join('\n'))throw new KeyError(changed);
   secret=entry.secret;binding=entry.binding;
  }
  if(!isSecret(secret))throw new KeyError('Key is missing from the OS keychain');
  // eslint-disable-next-line no-useless-assignment -- Drop our reference after the one permitted use.
  try{return await use(secret,binding);}finally{secret=null;}
 }
 async saveTest(id:string,results:DeploymentTest[]):Promise<void>{validateDeploymentTests(results);await this.serial(async()=>{await this.view(id);await this.settings.update(async s=>({...s,keys:(Array.isArray(s.keys)?s.keys.map(validateKeyView):[]).map(k=>k.id===id?{...k,lastTest:results}:k)}));});}
 private async envFile(path:string):Promise<Map<string,string>>{
  const file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const stat=await file.stat();if(!stat.isFile()||!ownedByMe(stat)||stat.size>1024*1024)throw new KeyError('Env file must be a small regular file owned by you');
   const entries=new Map<string,string>();for(const line of (await file.readFile('utf8')).split(/\r?\n/)){
    const m=line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);if(!m)continue;
    const name=m[1]??'';if(!Object.hasOwn(ENV_KEY_NAMES,name)&&!['AZURE_OPENAI_ENDPOINT','AZURE_OPENAI_DEPLOYMENT'].includes(name))continue;
    // A quoted value may carry a trailing comment (KEY="v" # note); the quotes must still go.
    const raw=m[2]??'',quoted=raw.match(/^(["'])(.*)\1(?:\s+#.*)?$/),value=quoted?(quoted[2]??''):raw.replace(/\s+#.*$/,'');
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
  }return created;}catch(error){
   // Every created entry gets its own rollback attempt, and a rollback failure never hides why the import failed.
   let orphans=0;for(const key of created){try{await this.remove(key.id);}catch{orphans++;}}
   if(orphans)throw new KeyError(`Import failed and ${orphans} new key${orphans>1?'s':''} could not be removed; remove ${orphans>1?'them':'it'} in /settings or Keychain Access`);
   throw error;
  }finally{entries.clear();}
 }
}
export const FOUNDRY_KEY_ERRORS=[FOUNDRY_CHANGED,FOUNDRY_UNBOUND,BEDROCK_CHANGED,OLLAMA_NO_KEY] as const;

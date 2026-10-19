import { catalogModels } from './model-catalog.js';
import { CLI_KEY_PROVIDERS, PROVIDER_LABELS, isLocalProvider, keyAuthLabel, testedModels } from './providers.js';
import { EXTRA_ENGINES, EXTRA_ENGINE_FACTS, isExtraEngine } from './cli-engines.js';
import type { AgentEngine, AuthRef, KeyView, KeyProvider, KeysRunOn, AuthMethod, EnginesStatus, DeploymentTest } from './protocol.js';
export interface ModelChoice {engine:AgentEngine;model:string|null;label:string;auth?:AuthRef;authLabel?:string;group?:string}
// Claude aliases come from installed --help; Codex id from the v0.1 CLI spike.
export const accountModels:ModelChoice[]=[
 {engine:'claude-code',model:null,label:'CLI default'},
 {engine:'claude-code',model:'opus',label:'opus'},
 {engine:'claude-code',model:'sonnet',label:'sonnet'},
 {engine:'codex',model:null,label:'CLI default'},
 {engine:'codex',model:'gpt-6.1-sol',label:'gpt-6.1-sol'},
 // Part B: each added CLI's default, then the model words its docs list.
 ...EXTRA_ENGINES.flatMap(engine=>[{engine,model:null,label:'CLI default'},...EXTRA_ENGINE_FACTS[engine].models.map(model=>({engine,model,label:model}))]),
];

// Providers AI Term's own agent can talk to: every key AI Term stores (v0.4.2; v0.6.5 and Part A add the providers in
// providers.ts).
export const AGENT_PROVIDERS:readonly KeyProvider[]=Object.keys(PROVIDER_LABELS) as KeyProvider[];
// How AI Term's agent reaches a tested Foundry deployment, from its last test (D30): null means not usable.
export function deploymentWire(test:DeploymentTest|undefined):'responses'|'chat'|null{return test?.status==='ready'?'responses':test?.status==='chat'||test?.status==='not a chat model'?'chat':null;}
// D47: a key runs on AI Term's agent when it supports the key's provider, unless the fallback setting says the CLI.
// Account logins never come here: they always start the official CLIs. The daemon applies this again on create.
export function keyEngine(provider:KeyProvider,keysRunOn:KeysRunOn|undefined):AgentEngine{
 // No CLI can run a v0.6.5 provider's key, so the fallback setting never applies to one.
 if(keysRunOn!=='cli'&&AGENT_PROVIDERS.includes(provider)||!CLI_KEY_PROVIDERS.includes(provider))return 'ai-term';
 return provider==='anthropic'?'claude-code':'codex';
}
// Plain-text engine names (D51: no logos, no provider names in ours).
export function engineLabel(engine:AgentEngine|'shell'):string{return isExtraEngine(engine)?EXTRA_ENGINE_FACTS[engine].label:engine==='codex'?'codex':engine==='ai-term'?'ai term':engine==='shell'?'shell':'claude code';}
export function engineTitle(engine:AgentEngine):string{return isExtraEngine(engine)?EXTRA_ENGINE_FACTS[engine].title:engine==='codex'?'Codex':engine==='ai-term'?'AI Term':'Claude Code';}
// The word an engine goes by in commands and notes (/account add <word>, "<word> not found in PATH"): claude, codex, or a
// Part B CLI's word.
export function engineWord(engine:Exclude<AgentEngine,'ai-term'>):string{return isExtraEngine(engine)?EXTRA_ENGINE_FACTS[engine].word:engine==='codex'?'codex':'claude';}
// A CLI engine's installed/login status from engines.status (Part B's CLIs under `extra`).
export function engineStatus(engines:EnginesStatus|undefined,engine:Exclude<AgentEngine,'ai-term'>):EnginesStatus['claudeCode']|undefined{return isExtraEngine(engine)?engines?.extra?.[engine]:engine==='codex'?engines?.codex:engines?.claudeCode;}
export function ownLoginLabel(method:AuthMethod|undefined):string{return method==='subscription'?'own login · sub':method==='api-key'?'own login · API key':'own login';}
export function modelChoices(keys:KeyView[],engines?:EnginesStatus,keysRunOn?:KeysRunOn):ModelChoice[]{
 // Part B's CLIs come last, after the keys, so the tabs keep their order (ANTHROPIC, OPENAI, then your keys).
 const accountChoice=(c:ModelChoice):ModelChoice=>({...c,auth:{kind:'account'},authLabel:ownLoginLabel(isExtraEngine(c.engine)?engines?.extra?.[c.engine]?.authMethod:c.engine==='codex'?engines?.codex.authMethod:engines?.claudeCode.authMethod),group:isExtraEngine(c.engine)?EXTRA_ENGINE_FACTS[c.engine].title.toUpperCase():c.engine==='codex'?'OPENAI':'ANTHROPIC'});
 const choices:ModelChoice[]=accountModels.filter(c=>!isExtraEngine(c.engine)).map(accountChoice);
 for(const key of keys){
  const auth:AuthRef={kind:'key',keyId:key.id},authLabel=keyAuthLabel(key.provider,key.last4);
  if(key.provider==='foundry'){
   const resource=key.endpoint?new URL(key.endpoint).hostname.split('.')[0]:'Foundry';
   const engine=keyEngine('foundry',keysRunOn);
   // AI Term's agent reaches Responses and Chat Completions deployments; Codex only Responses ones (D30).
   for(const model of key.deployments??[]){const wire=deploymentWire(key.lastTest?.find(r=>r.model===model));if(engine==='ai-term'?wire!==null:wire==='responses')choices.push({engine,model,label:model,auth,authLabel,group:`FOUNDRY · ${resource}`});}
  }else if(key.provider!=='anthropic'&&key.provider!=='openai'){
   // v0.6.5: the key's own models, each only after its tiny test request (or Ollama's listing) succeeded.
   const group=key.provider==='bedrock'&&key.endpoint?`BEDROCK · ${new URL(key.endpoint).hostname.split('.')[1]??''}`:key.provider==='custom'&&key.endpoint?`CUSTOM · ${new URL(key.endpoint).hostname}`:isLocalProvider(key.provider)?`${PROVIDER_LABELS[key.provider].toUpperCase()} · this Mac`:PROVIDER_LABELS[key.provider].toUpperCase();
   for(const model of testedModels(key))choices.push({engine:'ai-term',model,label:model,auth,authLabel,group});
  }else{
   const group=key.provider==='anthropic'?'ANTHROPIC':'OPENAI';
   // On AI Term's agent a key runs a named model from the catalog; on a CLI, the CLI's own aliases and default.
   if(keyEngine(key.provider,keysRunOn)==='ai-term')for(const model of catalogModels(key.provider))choices.push({engine:'ai-term',model,label:model,auth,authLabel,group});
   else for(const model of accountModels.filter(c=>c.engine===(key.provider==='anthropic'?'claude-code':'codex')))choices.push({...model,auth,authLabel,group});
  }
 }return [...choices,...accountModels.filter(c=>isExtraEngine(c.engine)).map(accountChoice)];
}

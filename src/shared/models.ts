import { catalogModels } from './model-catalog.js';
import type { AgentEngine, AuthRef, KeyView, KeyProvider, KeysRunOn, AuthMethod, EnginesStatus, DeploymentTest } from './protocol.js';
export interface ModelChoice {engine:AgentEngine;model:string|null;label:string;auth?:AuthRef;authLabel?:string;group?:string}
// Claude aliases come from installed --help; Codex id from the v0.1 CLI spike.
export const accountModels:ModelChoice[]=[
 {engine:'claude-code',model:null,label:'CLI default'},
 {engine:'claude-code',model:'opus',label:'opus'},
 {engine:'claude-code',model:'sonnet',label:'sonnet'},
 {engine:'codex',model:null,label:'CLI default'},
 {engine:'codex',model:'gpt-6.1-sol',label:'gpt-6.1-sol'},
];

// Providers AI Term's own agent can talk to: every key AI Term stores (v0.4.2).
export const AGENT_PROVIDERS:readonly KeyProvider[]=['foundry','anthropic','openai'];
// How AI Term's agent reaches a tested Foundry deployment, from its last test (D30): null means not usable.
export function deploymentWire(test:DeploymentTest|undefined):'responses'|'chat'|null{return test?.status==='ready'?'responses':test?.status==='chat'||test?.status==='not a chat model'?'chat':null;}
// D47: a key runs on AI Term's agent when it supports the key's provider, unless the fallback setting says the CLI.
// Account logins never come here: they always start the official CLIs. The daemon applies this again on create.
export function keyEngine(provider:KeyProvider,keysRunOn:KeysRunOn|undefined):AgentEngine{
 if(keysRunOn!=='cli'&&AGENT_PROVIDERS.includes(provider))return 'ai-term';
 return provider==='anthropic'?'claude-code':'codex';
}
// Plain-text engine names (D51: no logos, no provider names in ours).
export function engineLabel(engine:AgentEngine|'shell'):string{return engine==='codex'?'codex':engine==='ai-term'?'ai term':engine==='shell'?'shell':'claude code';}
export function engineTitle(engine:AgentEngine):string{return engine==='codex'?'Codex':engine==='ai-term'?'AI Term':'Claude Code';}
export function ownLoginLabel(method:AuthMethod|undefined):string{return method==='subscription'?'own login · sub':method==='api-key'?'own login · API key':'own login';}
export function modelChoices(keys:KeyView[],engines?:EnginesStatus,keysRunOn?:KeysRunOn):ModelChoice[]{
 const choices:ModelChoice[]=accountModels.map(c=>({...c,auth:{kind:'account'},authLabel:ownLoginLabel(c.engine==='codex'?engines?.codex.authMethod:engines?.claudeCode.authMethod),group:c.engine==='codex'?'OPENAI':'ANTHROPIC'}));
 for(const key of keys){
  const auth:AuthRef={kind:'key',keyId:key.id},authLabel=`key ····${key.last4}`;
  if(key.provider==='foundry'){
   const resource=key.endpoint?new URL(key.endpoint).hostname.split('.')[0]:'Foundry';
   const engine=keyEngine('foundry',keysRunOn);
   // AI Term's agent reaches Responses and Chat Completions deployments; Codex only Responses ones (D30).
   for(const model of key.deployments??[]){const wire=deploymentWire(key.lastTest?.find(r=>r.model===model));if(engine==='ai-term'?wire!==null:wire==='responses')choices.push({engine,model,label:model,auth,authLabel,group:`FOUNDRY · ${resource}`});}
  }else{
   const group=key.provider==='anthropic'?'ANTHROPIC':'OPENAI';
   // On AI Term's agent a key runs a named model from the catalog; on a CLI, the CLI's own aliases and default.
   if(keyEngine(key.provider,keysRunOn)==='ai-term')for(const model of catalogModels(key.provider))choices.push({engine:'ai-term',model,label:model,auth,authLabel,group});
   else for(const model of accountModels.filter(c=>c.engine===(key.provider==='anthropic'?'claude-code':'codex')))choices.push({...model,auth,authLabel,group});
  }
 }return choices;
}

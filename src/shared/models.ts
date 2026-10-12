import type { AgentEngine, AuthRef, KeyView, AuthMethod, EnginesStatus } from './protocol.js';
export interface ModelChoice {engine:AgentEngine;model:string|null;label:string;auth?:AuthRef;authLabel?:string;group?:string}
// Claude aliases come from installed --help; Codex id from the v0.1 CLI spike.
export const accountModels:ModelChoice[]=[
 {engine:'claude-code',model:null,label:'CLI default'},
 {engine:'claude-code',model:'opus',label:'opus'},
 {engine:'claude-code',model:'sonnet',label:'sonnet'},
 {engine:'codex',model:null,label:'CLI default'},
 {engine:'codex',model:'gpt-6.1-sol',label:'gpt-6.1-sol'},
];

export function ownLoginLabel(method:AuthMethod|undefined):string{return method==='subscription'?'own login · sub':method==='api-key'?'own login · API key':'own login';}
export function modelChoices(keys:KeyView[],engines?:EnginesStatus):ModelChoice[]{
 const choices:ModelChoice[]=accountModels.map(c=>({...c,auth:{kind:'account'},authLabel:ownLoginLabel(c.engine==='codex'?engines?.codex.authMethod:engines?.claudeCode.authMethod),group:c.engine==='codex'?'OPENAI':'ANTHROPIC'}));
 for(const key of keys){
  const auth:AuthRef={kind:'key',keyId:key.id},authLabel=`key ····${key.last4}`;
  if(key.provider==='foundry'){
   const resource=key.endpoint?new URL(key.endpoint).hostname.split('.')[0]:'Foundry';
   for(const model of key.deployments??[])if(key.lastTest?.some(r=>r.model===model&&r.status==='ready'))choices.push({engine:'codex',model,label:model,auth,authLabel,group:`FOUNDRY · ${resource}`});
  }else for(const model of accountModels.filter(c=>c.engine===(key.provider==='anthropic'?'claude-code':'codex')))choices.push({...model,auth,authLabel,group:key.provider==='anthropic'?'ANTHROPIC':'OPENAI'});
 }return choices;
}

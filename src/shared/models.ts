import type { AgentEngine } from './protocol.js';
export interface ModelChoice {engine:AgentEngine;model:string|null;label:string}
// Claude aliases come from installed --help; Codex id from the v0.1 CLI spike.
export const accountModels:ModelChoice[]=[
 {engine:'claude-code',model:null,label:'CLI default'},
 {engine:'claude-code',model:'opus',label:'opus'},
 {engine:'claude-code',model:'sonnet',label:'sonnet'},
 {engine:'codex',model:null,label:'CLI default'},
 {engine:'codex',model:'gpt-6.1-sol',label:'gpt-6.1-sol'},
];

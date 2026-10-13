import type {ClaudeStatusEvent} from '../shared/protocol.js';
import {capReply} from '../shared/last-reply.js';
export interface CodexUpdate {event:ClaudeStatusEvent;reply?:string}
// Bodies come from ai status-notify. Only the type and the last reply are read; anything else is ignored.
export function parseCodexStatus(raw:unknown,seq:number,at:string):CodexUpdate|null{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!('type'in raw)||raw.type!=='agent-turn-complete')return null;
 const reply='last-assistant-message'in raw&&typeof raw['last-assistant-message']==='string'?capReply(raw['last-assistant-message']):undefined;
 return {event:{seq,at,kind:'done'},...(reply!==undefined?{reply}:{})};
}
export type CodexRun='working'|'action'|'ready'|null;
// tui.terminal_title items are joined with " | " (rust-v0.160.1 status_surfaces.rs); an open approval or question
// replaces the run state with "[ ! ] Action Required". The activity item may put a spinner glyph before the state.
export function codexTitle(title:string):{run:CodexRun;leftPercent:number|null}{
 const parts=title.split(' | ').map(part=>part.trim());
 const run=parts.some(part=>part.startsWith('[ ! ] Action Required'))?'action':parts.some(part=>/^(?:\S\s)?(?:Working|Thinking)\b/u.test(part))?'working':parts.some(part=>/^(?:\S\s)?Ready\b/u.test(part))?'ready':null;
 const match=title.match(/(?:^| )Context (\d{1,3})% left(?: |$)/),left=match?Number(match[1]):null;
 return {run,leftPercent:left!==null&&left<=100?left:null};
}
// Codex's approval-requested notification texts (tui/src/notifications, rust-v0.160.1). Turn-complete OSC 9 carries a reply preview and is left to notify.
export function isCodexApproval(text:string):boolean{return text.startsWith('Approval requested')||text.startsWith('Codex wants to edit');}

import type {ClaudeStatusEvent} from '../shared/protocol.js';
import {isToolName} from '../shared/validate.js';
const MAX_REPLY_BYTES=256*1024;
const ERROR_KINDS=new Set(['rate_limit','overloaded','authentication_failed','billing_error','invalid_request','server_error','max_output_tokens','unknown']);
export interface ClaudeUpdate {event:ClaudeStatusEvent;reply?:string}
export function parseClaudeStatus(raw:unknown,seq:number,at:string):ClaudeUpdate|null {
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const value=raw as Record<string,unknown>;
 const base={seq,at},tool=isToolName(value.tool_name)?value.tool_name:undefined;
 switch(value.hook_event_name){
  case 'UserPromptSubmit':return {event:{...base,kind:'running',phase:'turn-start'}};
  case 'PreToolUse':case 'PostToolUse':case 'PostToolUseFailure':return {event:{...base,kind:'running',phase:value.hook_event_name==='PreToolUse'?'tool-start':'tool-finish',...(tool?{tool}:{})}};
  case 'PermissionRequest':return {event:{...base,kind:'waiting',reason:'permission'}};
  case 'Notification':
   if(value.notification_type==='permission_prompt')return {event:{...base,kind:'waiting',reason:'permission',backup:true}};
   if(['elicitation_dialog','elicitation_url_dialog','agent_needs_input'].includes(String(value.notification_type)))return {event:{...base,kind:'waiting',reason:'question'}};
   return null;
  case 'Stop':{
   let reply:string|undefined;
   if(typeof value.last_assistant_message==='string'){
    const bytes=Buffer.from(value.last_assistant_message);let end=Math.min(bytes.length,MAX_REPLY_BYTES);while(end<bytes.length&&((bytes[end]??0)&0xc0)===0x80)end--;reply=bytes.subarray(0,end).toString('utf8');
   }
   return {event:{...base,kind:'done'},...(reply!==undefined?{reply}:{})};
  }
  case 'StopFailure':return {event:{...base,kind:'waiting',reason:'turn failed',error:typeof value.error==='string'&&ERROR_KINDS.has(value.error)?value.error:'unknown'}};
  case 'AITermContext':return value.used_percentage===null||typeof value.used_percentage==='number'&&Number.isFinite(value.used_percentage)&&value.used_percentage>=0&&value.used_percentage<=100?{event:{...base,kind:'context',percent:value.used_percentage}}:null;
  default:return null;
 }
}

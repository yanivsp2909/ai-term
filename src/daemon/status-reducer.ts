import type {ClaudeStatusEvent,SessionInfo} from '../shared/protocol.js';
export interface StatusState extends Pick<SessionInfo,'status'|'statusDetail'|'statusSince'|'ctxPercent'|'exitCode'> {
 seq:number;lastActivity:{tool:string;at:string}|null;permissionBackupAllowed:boolean;
 // Claude tool calls between PreToolUse and their finish: a permission prompt can only appear while one is in flight
 // (PreToolUse is a blocking hook, so it arrives before the prompt even when PermissionRequest is lost or late).
 // A new turn, done, a failed turn and exit reset it, so a lost finish hook can't hold it up past the turn.
 toolsInFlight:number;
}
export function initialStatus(at:string):StatusState{return {seq:0,status:'starting',statusDetail:'starting',statusSince:at,ctxPercent:null,lastActivity:null,exitCode:null,permissionBackupAllowed:true,toolsInFlight:0};}
export function reduceStatus(state:StatusState,event:ClaudeStatusEvent):StatusState {
 if(state.status==='exited'||state.status==='error')return state;
 if(event.kind!=='exit'&&event.seq<=state.seq&&!(state.status==='starting'&&state.seq===0&&event.seq===0&&event.kind==='running'))return state;
 const next={...state,seq:Math.max(state.seq,event.seq)};
 if(event.kind==='context')return {...next,ctxPercent:event.percent};
 if(event.kind==='waiting'&&event.backup&&!state.permissionBackupAllowed)return next;
 if(event.kind==='running')return {...next,status:'running',statusDetail:'running',statusSince:state.status==='running'?state.statusSince:event.at,lastActivity:event.tool?{tool:event.tool,at:event.at}:state.lastActivity,permissionBackupAllowed:event.phase==='tool-finish'?false:event.phase==='turn-start'||event.phase==='tool-start'?true:state.permissionBackupAllowed,toolsInFlight:event.phase==='turn-start'?0:event.phase==='tool-start'?state.toolsInFlight+1:event.phase==='tool-finish'?Math.max(0,state.toolsInFlight-1):state.toolsInFlight};
 if(event.kind==='waiting')return {...next,status:'waiting',statusDetail:event.reason==='turn failed'?`turn failed: ${event.error??'unknown'}`:event.reason,statusSince:event.at,toolsInFlight:event.reason==='turn failed'?0:state.toolsInFlight};
 if(event.kind==='done')return {...next,status:'done',statusDetail:'done',statusSince:event.at,permissionBackupAllowed:false,toolsInFlight:0};
 return {...next,status:event.status,statusDetail:event.detail,statusSince:event.at,exitCode:event.exitCode,permissionBackupAllowed:false,toolsInFlight:0};
}

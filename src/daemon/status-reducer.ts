import type {ClaudeStatusEvent,SessionInfo} from '../shared/protocol.js';
export interface StatusState extends Pick<SessionInfo,'status'|'statusDetail'|'statusSince'|'ctxPercent'|'exitCode'> {
 seq:number;lastActivity:{tool:string;at:string}|null;permissionBackupAllowed:boolean;
}
export function initialStatus(at:string):StatusState{return {seq:0,status:'starting',statusDetail:'starting',statusSince:at,ctxPercent:null,lastActivity:null,exitCode:null,permissionBackupAllowed:true};}
export function reduceStatus(state:StatusState,event:ClaudeStatusEvent):StatusState {
 if(state.status==='exited'||state.status==='error')return state;
 if(event.kind!=='exit'&&event.seq<=state.seq&&!(state.status==='starting'&&state.seq===0&&event.seq===0&&event.kind==='running'))return state;
 const next={...state,seq:Math.max(state.seq,event.seq)};
 if(event.kind==='context')return {...next,ctxPercent:event.percent};
 if(event.kind==='waiting'&&event.backup&&!state.permissionBackupAllowed)return next;
 if(event.kind==='running')return {...next,status:'running',statusDetail:'running',statusSince:state.status==='running'?state.statusSince:event.at,lastActivity:event.tool?{tool:event.tool,at:event.at}:state.lastActivity,permissionBackupAllowed:event.phase==='tool-finish'?false:event.phase==='turn-start'||event.phase==='tool-start'?true:state.permissionBackupAllowed};
 if(event.kind==='waiting')return {...next,status:'waiting',statusDetail:event.reason==='turn failed'?`turn failed: ${event.error??'unknown'}`:event.reason,statusSince:event.at};
 if(event.kind==='done')return {...next,status:'done',statusDetail:'done',statusSince:event.at,permissionBackupAllowed:false};
 return {...next,status:event.status,statusDetail:event.detail,statusSince:event.at,exitCode:event.exitCode,permissionBackupAllowed:false};
}

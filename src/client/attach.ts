import { EventEmitter } from 'node:events';
import { DaemonRequestError, type RequestBody } from './connection.js';
import type { SuccessResponse } from '../shared/protocol.js';
import { isUUID, isSize, validateModes, validateExitCode } from '../shared/validate.js';
import { HomeKeyFilter } from './input-filter.js';
import { enterModes, RESET_MODES } from './terminal-modes.js';
import type { Logger } from '../daemon/log.js';
import { ClientSignal } from './signals.js';
export type AttachReason='home key'|'session exited'|'daemon gone'|'attach rejected'|'stdin not a TTY'|'error'|'attached elsewhere'|'client interrupted';
export class AttachError extends Error {
  constructor(readonly reason:AttachReason,error:Error){super(error.message,{cause:error});}
}
export interface AttachTTY extends EventEmitter {
  isTTY?:boolean;isRaw?:boolean;columns?:number;rows?:number;
  setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown;
  write(data:string|Buffer):boolean;
}
interface Input extends EventEmitter {isTTY?:boolean;isRaw?:boolean;setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown}
interface Output extends EventEmitter {isTTY?:boolean;columns?:number;rows?:number;write(data:string|Buffer):boolean}
interface AttachConnection extends EventEmitter {request(body:RequestBody):Promise<SuccessResponse>;input(id:string,data:Buffer):void;pauseOutput?():void;resumeOutput?():void}
export async function attach(connection:AttachConnection,id:string,options:{stdin?:Input;stdout?:Output;signals?:EventEmitter;debugLog?:Logger}={}):Promise<AttachReason> {
  const stdin:Input=options.stdin??process.stdin,stdout:Output=options.stdout??process.stdout,signals:EventEmitter=options.signals??process;
  if(!stdin.isTTY){options.debugLog?.info('attach reason=stdin not a TTY inputBytes=0');throw new AttachError('stdin not a TTY',new Error('Attach requires an interactive stdin'));}
  if(!isUUID(id)||!stdout.isTTY){options.debugLog?.info('attach reason=error inputBytes=0');throw new AttachError('error',new Error('Attach requires a session UUID and an interactive terminal'));}
  const originalRaw=stdin.isRaw??false;
  const filter=new HomeKeyFilter();let active=false,ended=false,entered=false,exitCode:number|undefined,failure:Error|undefined;let sessionEnded=false;
  let reason:AttachReason='error';let inputBytes=0,attachAccepted=false;
  const currentReason=():AttachReason=>reason;
  let escapeTimer:ReturnType<typeof setTimeout>|undefined;
  const buffered:Buffer[]=[];let bufferedBytes=0;
  let resolveDone:()=>void=()=>{};const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const end=(error?:Error,nextReason:AttachReason=error?'error':'client interrupted')=>{
    if(ended){if(error&&!failure){failure=error;reason=nextReason;}return;}
    ended=true;active=false;failure=error;reason=nextReason;resolveDone();
  };
  const send=(data:Buffer)=>{if(active&&data.length)connection.input(id,data);};
  const onData=(input:Buffer|string)=>{
    try{
      const data=typeof input==='string'?Buffer.from(input):input;
      inputBytes+=data.length;
      if(!active){if(data.includes(3))end();return;}
      if(escapeTimer)clearTimeout(escapeTimer);
      const result=filter.push(data);send(result.data);
      if(result.home){end(undefined,'home key');return;}
      escapeTimer=setTimeout(()=>{try{send(filter.flush());}catch(error){end(error instanceof Error?error:new Error('Input failed'));}},30);
    }catch(error){end(error instanceof Error?error:new Error('Input failed'));}
  };
  const writeOutput=(data:string|Buffer)=>{if(!stdout.write(data))connection.pauseOutput?.();};
  const onDrain=()=>{if(active)connection.resumeOutput?.();};
  const onOutput=(sessionId:string,data:Buffer)=>{
    if(ended||sessionId!==id)return;
    try{
      if(active)writeOutput(data);
      else{bufferedBytes+=data.length;if(bufferedBytes>4*1024*1024)throw new Error('Attach startup output exceeded limit');buffered.push(data);}
    }catch(error){end(error instanceof Error?error:new Error('Output failed'));}
  };
  const onEvent=(value:unknown)=>{
    if(ended||!value||typeof value!=='object')return;const event=value as Record<string,unknown>;
    if(event.kind==='session.detached'&&event.sessionId===id){end(undefined,'attached elsewhere');return;}
    if(event.kind==='session.updated'&&event.session&&typeof event.session==='object'){
      const session=event.session as Record<string,unknown>;
      if(session.id===id&&(session.status==='exited'||session.status==='error')){
        try{exitCode=validateExitCode(session.exitCode);sessionEnded=true;end(undefined,'session exited');}
        catch(error){end(error instanceof Error?error:new Error('Invalid session exit code'));}
      }
    }
  };
  const onDisconnect=()=>end(new Error('Daemon connection closed'),'daemon gone');
  const onError=(error:Error)=>end(error);
  const onUncaught=(error:Error)=>end(error);
  const onSignal=()=>end();
  const onTerm=()=>end(new ClientSignal(143),'client interrupted');
  const onHup=()=>end(new ClientSignal(129),'client interrupted');
  const onQuit=()=>end(new ClientSignal(131),'client interrupted');
  const size=()=>{const cols=stdout.columns??80,rows=stdout.rows??24;if(!isSize(cols,rows))throw new Error('Terminal size outside supported range');return {cols,rows};};
  const onResize=()=>{if(!active)return;try{void connection.request({kind:'sessions.resize',sessionId:id,...size()}).catch(onError);}catch(error){onError(error instanceof Error?error:new Error('Resize failed'));}};
  connection.on('output',onOutput);connection.on('event',onEvent);connection.on('disconnected',onDisconnect);
  stdin.on('data',onData);stdin.on('error',onError);stdout.on('error',onError);stdout.on('drain',onDrain);
  signals.on('SIGWINCH',onResize);signals.on('SIGINT',onSignal);signals.on('SIGTERM',onTerm);signals.on('SIGHUP',onHup);signals.on('SIGQUIT',onQuit);signals.on('uncaughtException',onUncaught);signals.on('unhandledRejection',onUncaught);
  try{
    entered=true;stdout.write('\x1b[?1049h');stdin.setRawMode(true);stdin.resume();
    const dimensions=size();
    const startup=connection.request({kind:'sessions.attach',sessionId:id,...dimensions});
    const result=await Promise.race([startup,done.then(()=>null)]);
    const response=result??(sessionEnded?await startup:null);
    if(response&&(!ended||sessionEnded)){
      const result=response;
      if(typeof result.snapshot!=='string'||!isSize(result.cols,result.rows))throw new Error('Invalid attach snapshot');
      const modes=validateModes(result.modes);
      attachAccepted=true;
      active=!ended;writeOutput(result.snapshot);writeOutput(enterModes(modes));
      for(const data of buffered)writeOutput(data);buffered.length=0;
      if(result.session&&(result.session.status==='exited'||result.session.status==='error')){exitCode=validateExitCode(result.session.exitCode);end(undefined,'session exited');}
    }
    await done;
  }catch(error){end(error instanceof Error?error:new Error('Attach failed'),error instanceof AttachError?error.reason:error instanceof DaemonRequestError?'attach rejected':'error');}
  finally{
    active=false;ended=true;if(escapeTimer)clearTimeout(escapeTimer);
    connection.off('output',onOutput);connection.off('event',onEvent);connection.off('disconnected',onDisconnect);
    stdin.off('data',onData);stdin.off('error',onError);stdout.off('error',onError);stdout.off('drain',onDrain);connection.resumeOutput?.();
    signals.off('SIGWINCH',onResize);signals.off('SIGINT',onSignal);signals.off('SIGTERM',onTerm);signals.off('SIGHUP',onHup);signals.off('SIGQUIT',onQuit);signals.off('uncaughtException',onUncaught);signals.off('unhandledRejection',onUncaught);
    // Restore locally before waiting for an unreachable daemon.
    try{if(entered)stdout.write(RESET_MODES+'\x1b[?1049l');}catch(error){failure??=error instanceof Error?error:new Error('Terminal reset failed');reason='error';}
    try{stdin.setRawMode(originalRaw);stdin.pause();}catch(error){failure??=error instanceof Error?error:new Error('Raw mode reset failed');reason='error';}
    try{await connection.request({kind:'sessions.detach',sessionId:id});}catch(error){failure??=error instanceof Error?error:new Error('Detach failed');if(currentReason()!=='daemon gone')reason='error';}
  }
  try{options.debugLog?.info(`attach sessionId=${id} reason=${reason} accepted=${attachAccepted} inputBytes=${inputBytes}`);}catch(error){failure??=error instanceof Error?error:new Error('Debug log failed');reason='error';}
  try{if(exitCode!==undefined)stdout.write(`[session exited with code ${exitCode}]\n`);}catch(error){throw new AttachError('error',error instanceof Error?error:new Error('Exit message failed'));}
  if(failure instanceof ClientSignal)throw failure;
  if(failure)throw new AttachError(reason,failure);
  return reason;
}

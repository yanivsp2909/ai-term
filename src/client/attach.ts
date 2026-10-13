import { EventEmitter } from 'node:events';
import { DaemonRequestError, type RequestBody } from './connection.js';
import type { SuccessResponse } from '../shared/protocol.js';
import { isUUID, isSize, validateModes, validateExitCode } from '../shared/validate.js';
import { HomeKeyFilter } from './input-filter.js';
import { enterModes, RESET_MODES } from './terminal-modes.js';
import type { Logger } from '../daemon/log.js';
import { ClientSignal } from './signals.js';
import { terminalProbe } from './terminal-probe.js';
import { SessionScreen } from './session-screen.js';
import { MouseRewriter } from './mouse-rows.js';
import { frameBar } from './tui/frame-bar.js';
import { diffFrame,type Frame } from './tui/grid.js';
import { createTheme } from './tui/theme.js';
import type { SessionInfo,Settings } from '../shared/protocol.js';
export type AttachReason='home key'|'session exited'|'daemon gone'|'attach rejected'|'stdin not a TTY'|'error'|'attached elsewhere'|'client interrupted';
export class AttachError extends Error {
  constructor(readonly reason:AttachReason,error:Error){super(error.message,{cause:error});}
}
export interface AttachTTY extends EventEmitter {
  isTTY?:boolean;isRaw?:boolean;columns?:number;rows?:number;
  setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown;
  write(data:string|Buffer):boolean;
}
export interface Input extends EventEmitter {isTTY?:boolean;isRaw?:boolean;setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown}
export interface Output extends EventEmitter {isTTY?:boolean;columns?:number;rows?:number;write(data:string|Buffer):boolean}
export interface AttachConnection extends EventEmitter {request(body:RequestBody):Promise<SuccessResponse>;input(id:string,data:Buffer):void;pauseOutput?():void;resumeOutput?():void}
export interface AttachOptions {stdin?:Input;stdout?:Output;signals?:EventEmitter;debugLog?:Logger;bar?:'on'|'off';settings?:Settings;fallbackLog?:(text:string)=>void}
export async function attach(connection:AttachConnection,id:string,options:AttachOptions={}):Promise<AttachReason> {
  const stdin:Input=options.stdin??process.stdin,stdout:Output=options.stdout??process.stdout,signals:EventEmitter=options.signals??process;
  if(!stdin.isTTY){options.debugLog?.info('attach reason=stdin not a TTY inputBytes=0');throw new AttachError('stdin not a TTY',new Error('Attach requires an interactive stdin'));}
  if(!isUUID(id)||!stdout.isTTY){options.debugLog?.info('attach reason=error inputBytes=0');throw new AttachError('error',new Error('Attach requires a session UUID and an interactive terminal'));}
  const originalRaw=stdin.isRaw??false;
  const probed=options.bar==='on'&&(stdout.rows??24)>1?await terminalProbe(stdin,stdout):null;
  const probe=probed?.success?probed:null;
  if(options.bar==='on'&&!probe)options.fallbackLog?.('Bar startup probe failed; using raw passthrough for this attach');
  let screen:SessionScreen|undefined;
  let barSession:SessionInfo|undefined;const others=new Map<string,SessionInfo>();
  const theme=createTheme(options.settings?.theme??'graphite');
  let barKey='',barOutput='';
  const barBytes=()=>{
    if(!barSession)return '';
    const cols=screen?.terminal.cols??stdout.columns??80;
    const key=JSON.stringify([cols,barSession.title,barSession.engine,barSession.model,barSession.status,...[...others.values()].map(s=>s.status)]);
    if(key!==barKey){const frame:Frame=frameBar(cols,barSession,[...others.values()],theme);barOutput=diffFrame(frame,[],theme).slice(8,-8);barKey=key;}
    return barOutput;
  };
  const mouse=new MouseRewriter(()=>screen?.passthrough.mouse()??{tracking:false,encoding:'default'});
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
      screen?.input();const result=filter.push(data);send(screen?mouse.push(result.data):result.data);
      if(result.home){end(undefined,'home key');return;}
      escapeTimer=setTimeout(()=>{try{const pending=filter.flush();if(screen){send(mouse.push(pending));send(mouse.flushEscape());}else send(pending);}catch(error){end(error instanceof Error?error:new Error('Input failed'));}},30);
    }catch(error){end(error instanceof Error?error:new Error('Input failed'));}
  };
  const writeOutput=(data:string|Buffer)=>{
    if(screen){void screen.write(data).catch(onError);return;}
    if(!stdout.write(data))connection.pauseOutput?.();
  };
  const onDrain=()=>{if(active){screen?.drain();connection.resumeOutput?.();}};
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
    if(event.kind==='session.removed'&&typeof event.sessionId==='string'){others.delete(event.sessionId);screen?.changed();}
    if(event.kind==='session.updated'&&event.session&&typeof event.session==='object'){
      const session=event.session as Record<string,unknown>;
      if(screen&&session.id!==id&&typeof session.id==='string'){others.set(session.id,event.session as SessionInfo);screen.changed();}
      if(screen&&session.id===id&&barSession){barSession=event.session as SessionInfo;screen.changed();}
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
  const onInputEnd=()=>end(new Error('Terminal input closed'));
  const onTerm=()=>end(new ClientSignal(143),'client interrupted');
  const onHup=()=>end(new ClientSignal(129),'client interrupted');
  const onQuit=()=>end(new ClientSignal(131),'client interrupted');
  const size=()=>{const cols=stdout.columns??80,rows=(stdout.rows??24)-(probe?1:0);if(!isSize(cols,rows))throw new Error('Terminal size outside supported range');return {cols,rows};};
  const onResize=()=>{if(!active)return;try{const dimensions=size();screen?.resize(dimensions.cols,dimensions.rows);void connection.request({kind:'sessions.resize',sessionId:id,...dimensions}).catch(onError);}catch(error){onError(error instanceof Error?error:new Error('Resize failed'));}};
  connection.on('output',onOutput);connection.on('event',onEvent);connection.on('disconnected',onDisconnect);
  stdin.on('data',onData);stdin.on('error',onError);if(probe){stdin.on('end',onInputEnd);stdin.on('close',onInputEnd);}stdout.on('error',onError);stdout.on('drain',onDrain);
  signals.on('SIGWINCH',onResize);signals.on('SIGINT',onSignal);signals.on('SIGTERM',onTerm);signals.on('SIGHUP',onHup);signals.on('SIGQUIT',onQuit);signals.on('uncaughtException',onUncaught);signals.on('unhandledRejection',onUncaught);
  try{
    entered=true;stdout.write('\x1b[?1049h');stdin.setRawMode(true);stdin.resume();
    const dimensions=size();
    if(probe){
      screen=new SessionScreen(dimensions.cols,dimensions.rows,probe.facts,data=>{const ready=stdout.write(data);if(!ready)connection.pauseOutput?.();return ready;},data=>send(Buffer.from(data)),barBytes,onError);
      // This request has no bearing on the agent PTY or keyboard path.
      void connection.request({kind:'sessions.list'}).then(result=>{for(const s of result.sessions??[])if(s.id!==id)others.set(s.id,s);screen?.changed();},onError);
    }
    const startup=connection.request({kind:'sessions.attach',sessionId:id,...dimensions});
    const result=await Promise.race([startup,done.then(()=>null)]);
    const response=result??(sessionEnded?await startup:null);
    if(response&&(!ended||sessionEnded)){
      const result=response;
      if(typeof result.snapshot!=='string'||!isSize(result.cols,result.rows))throw new Error('Invalid attach snapshot');
      const modes=validateModes(result.modes);
      barSession=result.session;
      attachAccepted=true;
      active=!ended;
      if(screen){await screen.write(result.snapshot);await screen.write(enterModes(modes));}else{writeOutput(result.snapshot);writeOutput(enterModes(modes));}
      for(const data of buffered)writeOutput(data);buffered.length=0;
      if(probed?.input.length)onData(probed.input);
      if(result.session&&(result.session.status==='exited'||result.session.status==='error')){exitCode=validateExitCode(result.session.exitCode);end(undefined,'session exited');}
    }
    await done;
  }catch(error){end(error instanceof Error?error:new Error('Attach failed'),error instanceof AttachError?error.reason:error instanceof DaemonRequestError?'attach rejected':'error');}
  finally{
    active=false;ended=true;screen?.dispose();if(escapeTimer)clearTimeout(escapeTimer);
    connection.off('output',onOutput);connection.off('event',onEvent);connection.off('disconnected',onDisconnect);
    stdin.off('data',onData);stdin.off('error',onError);stdin.off('end',onInputEnd);stdin.off('close',onInputEnd);stdout.off('error',onError);stdout.off('drain',onDrain);connection.resumeOutput?.();
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

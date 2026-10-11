import { EventEmitter } from 'node:events';
import type { RequestBody } from './connection.js';
import type { SuccessResponse } from '../shared/protocol.js';
import { isUUID, isSize, validateModes } from '../shared/validate.js';
import { HomeKeyFilter } from './input-filter.js';
import { enterModes, RESET_MODES } from './terminal-modes.js';
export interface AttachTTY extends EventEmitter {
  isTTY?:boolean;isRaw?:boolean;columns?:number;rows?:number;
  setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown;
  write(data:string|Buffer):boolean;
}
interface Input extends EventEmitter {isTTY?:boolean;isRaw?:boolean;setRawMode(raw:boolean):unknown;resume():unknown;pause():unknown}
interface Output extends EventEmitter {isTTY?:boolean;columns?:number;rows?:number;write(data:string|Buffer):boolean}
interface AttachConnection extends EventEmitter {request(body:RequestBody):Promise<SuccessResponse>;input(id:string,data:Buffer):void;pauseOutput?():void;resumeOutput?():void}
export async function attach(connection:AttachConnection,id:string,options:{stdin?:Input;stdout?:Output;signals?:EventEmitter}={}):Promise<void> {
  const stdin:Input=options.stdin??process.stdin,stdout:Output=options.stdout??process.stdout,signals:EventEmitter=options.signals??process;
  if(!isUUID(id)||!stdin.isTTY||!stdout.isTTY)throw new Error('Attach requires a session UUID and an interactive terminal');
  const originalRaw=stdin.isRaw??false;
  const filter=new HomeKeyFilter();let active=false,ended=false,entered=false,exitCode:number|undefined,failure:Error|undefined;
  let escapeTimer:ReturnType<typeof setTimeout>|undefined;
  const buffered:Buffer[]=[];let bufferedBytes=0;
  let resolveDone:()=>void=()=>{};const done=new Promise<void>(resolve=>{resolveDone=resolve;});
  const end=(error?:Error)=>{if(ended)return;ended=true;active=false;failure=error;resolveDone();};
  const send=(data:Buffer)=>{if(active&&data.length)connection.input(id,data);};
  const onData=(input:Buffer|string)=>{
    try{
      const data=typeof input==='string'?Buffer.from(input):input;
      if(!active){if(data.includes(3))end();return;}
      if(escapeTimer)clearTimeout(escapeTimer);
      const result=filter.push(data);send(result.data);
      if(result.home){end();return;}
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
    if(!value||typeof value!=='object')return;const event=value as Record<string,unknown>;
    if(event.kind==='session.detached'&&event.sessionId===id){end();return;}
    if(event.kind==='session.updated'&&event.session&&typeof event.session==='object'){
      const session=event.session as Record<string,unknown>;
      if(session.id===id&&(session.status==='exited'||session.status==='error')){exitCode=typeof session.exitCode==='number'?session.exitCode:undefined;end();}
    }
  };
  const onDisconnect=()=>end(new Error('Daemon connection closed'));
  const onError=(error:Error)=>end(error);
  const onUncaught=(error:Error)=>end(error);
  const onSignal=()=>end();
  const size=()=>{const cols=stdout.columns??80,rows=stdout.rows??24;if(!isSize(cols,rows))throw new Error('Terminal size outside supported range');return {cols,rows};};
  const onResize=()=>{if(!active)return;try{void connection.request({kind:'sessions.resize',sessionId:id,...size()}).catch(onError);}catch(error){onError(error instanceof Error?error:new Error('Resize failed'));}};
  connection.on('output',onOutput);connection.on('event',onEvent);connection.on('disconnected',onDisconnect);
  stdin.on('data',onData);stdin.on('error',onError);stdout.on('error',onError);stdout.on('drain',onDrain);
  signals.on('SIGWINCH',onResize);signals.on('SIGINT',onSignal);signals.on('SIGTERM',onSignal);signals.on('uncaughtException',onUncaught);signals.on('unhandledRejection',onUncaught);
  try{
    entered=true;stdout.write('\x1b[?1049h');stdin.setRawMode(true);stdin.resume();
    const result=await connection.request({kind:'sessions.attach',sessionId:id,...size()});
    if(!ended){
      if(typeof result.snapshot!=='string'||!isSize(result.cols,result.rows))throw new Error('Invalid attach snapshot');
      const modes=validateModes(result.modes);
      active=true;writeOutput(result.snapshot);writeOutput(enterModes(modes));
      for(const data of buffered)writeOutput(data);buffered.length=0;
      if(result.session&&(result.session.status==='exited'||result.session.status==='error')){exitCode=result.session.exitCode??undefined;end();}
    }
    await done;
  }catch(error){end(error instanceof Error?error:new Error('Attach failed'));}
  finally{
    active=false;ended=true;if(escapeTimer)clearTimeout(escapeTimer);
    connection.off('output',onOutput);connection.off('event',onEvent);connection.off('disconnected',onDisconnect);
    stdin.off('data',onData);stdin.off('error',onError);stdout.off('error',onError);stdout.off('drain',onDrain);connection.resumeOutput?.();
    signals.off('SIGWINCH',onResize);signals.off('SIGINT',onSignal);signals.off('SIGTERM',onSignal);signals.off('uncaughtException',onUncaught);signals.off('unhandledRejection',onUncaught);
    // Restore locally before waiting for an unreachable daemon.
    try{if(entered)stdout.write(RESET_MODES+'\x1b[?1049l');}catch(error){failure??=error instanceof Error?error:new Error('Terminal reset failed');}
    try{stdin.setRawMode(originalRaw);stdin.pause();}catch(error){failure??=error instanceof Error?error:new Error('Raw mode reset failed');}
    try{await connection.request({kind:'sessions.detach',sessionId:id});}catch(error){failure??=error instanceof Error?error:new Error('Detach failed');}
  }
  if(exitCode!==undefined)stdout.write(`[session exited with code ${exitCode}]\n`);
  if(failure)throw failure;
}

import type { Input,Output } from './attach.js';
import { OUTER_PROBE,parseProbe,type OuterFacts } from './passthrough.js';
// DA1 is the completion sentinel. Only recognized replies are removed; early typed keys survive.
export async function terminalProbe(stdin:Input,stdout:Output):Promise<{facts:OuterFacts;input:Buffer;success:boolean}>{
 const original=stdin.isRaw??false;
 let timer:ReturnType<typeof setTimeout>|undefined,received=Buffer.alloc(0);
 let complete:(value:{facts:OuterFacts;input:Buffer;success:boolean})=>void=()=>{},fail:(error:Error)=>void=()=>{};
 const promise=new Promise<{facts:OuterFacts;input:Buffer;success:boolean}>((resolve,reject)=>{complete=resolve;fail=reject;});
 const onData=(data:Buffer|string)=>{
  received=Buffer.concat([received,typeof data==='string'?Buffer.from(data):data]);
  if(received.length>64*1024){finish(false);return;}
  const result=parseProbe(received.toString('latin1'));
  if(result.done)finish(true);
 };
 const finish=(success:boolean)=>{const parsed=parseProbe(received.toString('latin1'));complete({facts:parsed.facts,input:Buffer.from(parsed.rest,'latin1'),success});};
 const onEnd=()=>fail(new Error('Terminal input closed during probe'));
 stdin.on('data',onData);stdin.on('error',fail);stdin.on('end',onEnd);stdin.on('close',onEnd);stdout.on('error',fail);
 try{stdin.setRawMode(true);stdin.resume();timer=setTimeout(()=>finish(false),250);stdout.write(OUTER_PROBE);return await promise;}
 finally{if(timer)clearTimeout(timer);stdin.off('data',onData);stdin.off('error',fail);stdin.off('end',onEnd);stdin.off('close',onEnd);stdout.off('error',fail);stdin.setRawMode(original);}
}

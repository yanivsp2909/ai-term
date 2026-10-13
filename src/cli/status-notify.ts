import {request} from 'node:http';
import {capReply} from '../shared/last-reply.js';
// Codex passes the whole notify payload as one argv element; macOS caps argv well below this anyway.
const MAX_PAYLOAD_BYTES=4*1024*1024;
const FORWARDED_TYPES=new Set(['agent-turn-complete']);
// Keeps only the event type and the last reply. input-messages, cwd, thread ids and anything else are never copied.
export function notifyBody(payload:string):string|null{
 if(Buffer.byteLength(payload)>MAX_PAYLOAD_BYTES)return null;
 let raw:unknown;try{raw=JSON.parse(payload);}catch{return null;}
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||!('type'in raw)||typeof raw.type!=='string'||!FORWARDED_TYPES.has(raw.type))return null;
 const reply='last-assistant-message'in raw&&typeof raw['last-assistant-message']==='string'?capReply(raw['last-assistant-message']):undefined;
 return JSON.stringify({type:raw.type,...(reply!==undefined?{'last-assistant-message':reply}:{})});
}
// Codex runs notify for every finished turn and must never hang or break on it: every failure ends quietly.
export async function statusNotify(args:readonly string[],env:NodeJS.ProcessEnv=process.env):Promise<void>{
 const port=Number(env.AITERM_STATUS_PORT),token=env.AITERM_STATUS_TOKEN,payload=args.length===1?args[0]:undefined;
 if(payload===undefined||!Number.isInteger(port)||port<1||port>65535||!token||! /^[a-f0-9]{64}$/.test(token))return;
 const body=notifyBody(payload);if(body===null)return;
 await new Promise<void>(resolve=>{
  const req=request({hostname:'127.0.0.1',port,path:'/v1/status/codex',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-ai-term-session':token}},res=>{res.resume();res.on('end',resolve);res.on('error',()=>resolve());});
  const timer=setTimeout(()=>{req.destroy();resolve();},1000);req.on('close',()=>{clearTimeout(timer);resolve();});req.on('error',()=>resolve());req.end(body);
 });
}

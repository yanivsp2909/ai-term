import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {isUUID} from '../shared/validate.js';
import type {UsageContext} from './usage-parse.js';
import type {AgentEngine} from '../shared/protocol.js';
const MAX_BODY=1024*1024;
export type StatusEngine=Exclude<AgentEngine,'shell'>;
// Claude puts whole files and replies in hook bodies. Codex bodies come only from ai status-notify: a type plus a
// last reply capped at 256 KiB, which JSON escaping can grow up to six times (\u00XX), so 2 MiB always fits it.
// AI Term's agent sends small events plus a last reply capped like Codex's, so the same 2 MiB bound fits.
const STATUS_ROUTES:Record<StatusEngine,{path:string;cap:number}>={'claude-code':{path:'/v1/status/claude',cap:4*MAX_BODY},codex:{path:'/v1/status/codex',cap:2*MAX_BODY},'ai-term':{path:'/v1/status/ai-term',cap:2*MAX_BODY}};
interface StatusContext {id:string;engine:StatusEngine;seq:number;queue:Promise<void>}
// An oversized body is read and thrown away up to this bound before the 413, because closing with unread
// bytes makes the kernel send a reset that destroys the 413 (B10), and OTLP exporters retry a reset but
// not a 413. Past the bound the connection is cut. Nothing beyond MAX_BODY is ever kept.
const MAX_DISCARD=4*MAX_BODY;
const AGENT_QUERY_CAP=4096,AGENT_QUERY_PATH='/v1/agent/ai-term',MCP_QUERY_PATH='/v1/mcp/ai-term';
export class UsageReceiver {
 private readonly server:Server;
 private statusCredentials=new Map<string,StatusContext>();
 private credentials=new Map<string,UsageContext>();
 private agentQuery?:(id:string,body:unknown)=>Promise<unknown>;
 constructor(private readonly consume:(route:string,body:unknown,context:UsageContext)=>Promise<void>,private readonly log:{error(text:string):void},private readonly consumeStatus?:(id:string,body:unknown,seq:number,engine:StatusEngine)=>Promise<void>){
  const serve=(req:IncomingMessage,res:ServerResponse)=>{void this.handle(req,res).catch(()=>{const status=this.isStatusPath(req.url);this.log.error(status?'Status receiver request failed':'Usage receiver request failed');if(!res.headersSent){if(status)this.statusAnswer(res);else this.answer(res,500);}else res.destroy();});};
  this.server=createServer(serve);
  // Node answers an unknown Expect header with 417 by itself; a listener takes that over, so status paths stay 204 (S12).
  this.server.on('checkExpectation',serve);
  this.server.requestTimeout=5000;this.server.headersTimeout=5000;this.server.on('clientError',(_error,socket)=>{socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n',()=>socket.destroy());});
 }
 async listen():Promise<void>{await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',()=>{this.server.off('error',reject);resolve();});});}
 address():AddressInfo{const a=this.server.address();if(!a||typeof a==='string')throw new Error('Usage receiver unavailable');return a;}
 port():number{return this.address().port;}
 register(context:UsageContext):string{const token=randomBytes(32).toString('hex');this.credentials.set(token,{...context});return token;}
 registerStatus(id:string,engine:StatusEngine='claude-code'):string{if(!isUUID(id))throw new Error('Invalid session UUID');if(!Object.hasOwn(STATUS_ROUTES,engine))throw new Error('Invalid status engine');const token=randomBytes(32).toString('hex');this.statusCredentials.set(token,{id,engine,seq:0,queue:Promise.resolve()});return token;}
 // Terminal signals from a session's mirror join its request queue: a status body that arrived first (a notify still being read)
 // is applied first, so a later signal cannot make it stale. The queue never rejects, or every later request would wait forever.
 enqueueStatus(id:string,apply:(seq:number)=>void):boolean{
  for(const context of this.statusCredentials.values())if(context.id===id){const seq=++context.seq;context.queue=context.queue.then(()=>apply(seq)).catch(()=>this.log.error('Status signal failed'));return true;}
  return false;
 }
 // How many status requests and signals this session has queued so far (0 when it has no credential). Read-only; tests
 // wait on it to know a body is being read instead of guessing a delay (B31).
 statusSeq(id:string):number{let seq=0;for(const context of this.statusCredentials.values())if(context.id===id)seq=Math.max(seq,context.seq);return seq;}
 revoke(sessionId:string):void{for(const [token,context]of this.statusCredentials)if(context.id===sessionId)this.statusCredentials.delete(token);for(const [token,context]of this.credentials)if(context.sessionId===sessionId)this.credentials.delete(token);}
 revokeAll():void{this.credentials.clear();this.statusCredentials.clear();}
 private authorize(value:unknown):UsageContext|null{
  if(typeof value!=='string'||value.length!==64)return null;const incoming=Buffer.from(value,'utf8');if(incoming.length!==64)return null;
  for(const [token,context]of this.credentials)if(timingSafeEqual(incoming,Buffer.from(token,'utf8')))return context;
  return null;
 }
 private isStatusPath(path:string|undefined):boolean{return !['/v1/metrics','/v1/logs'].includes(path??'');}
 private statusAnswer(res:ServerResponse):void{res.writeHead(204,{'connection':'close'});res.end();}
 private authorizeStatus(value:unknown):StatusContext|null{
  if(typeof value!=='string'||value.length!==64)return null;const incoming=Buffer.from(value);if(incoming.length!==64)return null;
  for(const [token,context]of this.statusCredentials)if(timingSafeEqual(incoming,Buffer.from(token)))return context;return null;
 }
 setAgentQuery(handler:(id:string,body:unknown)=>Promise<unknown>):void{this.agentQuery=handler;}
 // AI Term's agent asks for its facts here (§12.5): the same credential, Host, Origin and JSON rules as status, engine-bound
 // to 'ai-term'. A 4 KiB body, a one-second read; the answer is 200 JSON, and every refusal or failure is 204 with no body.
 private async handleAgentQuery(req:IncomingMessage,res:ServerResponse):Promise<void>{
  const context=this.authorizeStatus(req.headers['x-ai-term-session']);
  if(!context||context.engine!=='ai-term'||req.method!=='POST'||req.headers.host!==`127.0.0.1:${this.port()}`||Object.hasOwn(req.headers,'origin')||req.headers['content-type']!=='application/json'||!this.agentQuery){this.statusAnswer(res);res.once('finish',()=>req.destroy());req.resume();return;}
  const cap=req.url===MCP_QUERY_PATH?64*1024:AGENT_QUERY_CAP;
  let bytes=0;const chunks:Buffer[]=[];
  const body=await new Promise<Buffer|null>(resolve=>{
   const timer=setTimeout(()=>resolve(null),1000);
   req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes<=cap)chunks.push(chunk);});
   req.on('end',()=>{clearTimeout(timer);resolve(bytes>cap?null:Buffer.concat(chunks));});
   req.on('error',()=>{clearTimeout(timer);resolve(null);});req.on('close',()=>{clearTimeout(timer);if(!req.complete)resolve(null);});
  });
  let answer:unknown=null;
  if(body&&this.authorizeStatus(req.headers['x-ai-term-session'])===context){try{answer=await this.agentQuery(context.id,JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body)));}catch{this.log.error('Agent query failed');}}
  if(res.headersSent)return;
  if(answer===null||answer===undefined){this.statusAnswer(res);res.once('finish',()=>req.destroy());return;}
  const text=JSON.stringify(answer);res.writeHead(200,{'content-type':'application/json','content-length':Buffer.byteLength(text),'connection':'close'});res.end(text);
 }
 private async handleStatus(req:IncomingMessage,res:ServerResponse):Promise<void>{
  const context=this.authorizeStatus(req.headers['x-ai-term-session']);
  if(!context||req.url!==STATUS_ROUTES[context.engine].path||req.method!=='POST'||req.headers.host!==`127.0.0.1:${this.port()}`||Object.hasOwn(req.headers,'origin')||req.headers['content-type']!=='application/json'){this.statusAnswer(res);res.once('finish',()=>req.destroy());req.resume();return;}
  const seq=++context.seq,previous=context.queue,cap=STATUS_ROUTES[context.engine].cap;let release=()=>{};context.queue=new Promise<void>(resolve=>{release=resolve;});let bytes=0;const chunks:Buffer[]=[];
  try{
  const body=await new Promise<Buffer|null>((resolve,reject)=>{
   req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>cap){chunks.length=0;}else chunks.push(chunk);});
   // Keep the queue bounded by the hook's two-second timeout. Send the bodyless reply before cutting a half-open sender.
   const timer=setTimeout(()=>{chunks.length=0;this.statusAnswer(res);res.once('finish',()=>req.destroy());resolve(null);},1000);
   req.on('end',()=>{clearTimeout(timer);resolve(bytes>cap?null:Buffer.concat(chunks));});req.on('error',error=>{clearTimeout(timer);reject(error);});
   req.on('close',()=>{clearTimeout(timer);if(!req.complete)resolve(null);});
  });
  await previous;
  if(body&&this.authorizeStatus(req.headers['x-ai-term-session'])===context){
   let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{this.statusAnswer(res);return;}
   await this.consumeStatus?.(context.id,raw,seq,context.engine);
  }
  if(!res.headersSent)this.statusAnswer(res);
  }finally{await previous;release();}
 }
 private answer(res:ServerResponse,status:number):void{res.writeHead(status,{'content-type':'application/json','connection':'close'});res.end(status===200?'{}':'');}
 private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
  if((req.url===AGENT_QUERY_PATH||req.url===MCP_QUERY_PATH)){await this.handleAgentQuery(req,res);return;}
  if(this.isStatusPath(req.url)){await this.handleStatus(req,res);return;}
  if(req.headers.host!==`127.0.0.1:${this.port()}`){this.answer(res,421);req.resume();return;}
  if(Object.hasOwn(req.headers,'origin')){this.answer(res,403);req.resume();return;}
  if(req.method!=='POST'||!['/v1/metrics','/v1/logs'].includes(req.url??'')){this.answer(res,404);req.resume();return;}
  if(req.headers['content-type']!=='application/json'){this.answer(res,415);req.resume();return;}
  const context=this.authorize(req.headers['x-ai-term-session']);if(!context){this.answer(res,401);req.resume();return;}
  const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>MAX_DISCARD){this.answer(res,413);req.pause();return;}
  let bytes=0;const chunks:Buffer[]=[];
  const body=await new Promise<Buffer|'too large'|'cut'>((resolve,reject)=>{
   req.on('data',(chunk:Buffer)=>{
    bytes+=chunk.length;
    if(bytes>MAX_DISCARD){req.destroy();resolve('cut');return;}
    if(bytes>MAX_BODY){chunks.length=0;return;}
    chunks.push(chunk);
   });
   req.on('end',()=>resolve(bytes>MAX_BODY?'too large':Buffer.concat(chunks)));req.on('error',reject);
  });
  if(body==='cut')return;
  if(body==='too large'){this.answer(res,413);return;}let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{this.answer(res,400);return;}
  // Credential may have been revoked while this body was being received.
  if(this.authorize(req.headers['x-ai-term-session'])!==context){this.answer(res,401);return;}
  await this.consume(req.url??'',raw,context);this.answer(res,200);
 }
 async close():Promise<void>{this.revokeAll();if(this.server.listening)await new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve()));}
}

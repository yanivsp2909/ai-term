import {createServer,type IncomingMessage,type ServerResponse,type Server} from 'node:http';
import {randomBytes,timingSafeEqual} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import type {UsageContext} from './usage-parse.js';
const MAX_BODY=1024*1024;
export class UsageReceiver {
 private readonly server:Server;
 private credentials=new Map<string,UsageContext>();
 constructor(private readonly consume:(route:string,body:unknown,context:UsageContext)=>Promise<void>,private readonly log:{error(text:string):void}){
  this.server=createServer((req,res)=>{void this.handle(req,res).catch(()=>{this.log.error('Usage receiver request failed');if(!res.headersSent)this.answer(res,500);else res.destroy();});});
  this.server.requestTimeout=5000;this.server.headersTimeout=5000;this.server.on('clientError',(_error,socket)=>{socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');});
 }
 async listen():Promise<void>{await new Promise<void>((resolve,reject)=>{this.server.once('error',reject);this.server.listen(0,'127.0.0.1',()=>{this.server.off('error',reject);resolve();});});}
 address():AddressInfo{const a=this.server.address();if(!a||typeof a==='string')throw new Error('Usage receiver unavailable');return a;}
 port():number{return this.address().port;}
 register(context:UsageContext):string{const token=randomBytes(32).toString('hex');this.credentials.set(token,{...context});return token;}
 revoke(sessionId:string):void{for(const [token,context]of this.credentials)if(context.sessionId===sessionId)this.credentials.delete(token);}
 revokeAll():void{this.credentials.clear();}
 private authorize(value:unknown):UsageContext|null{
  if(typeof value!=='string'||value.length!==64)return null;const incoming=Buffer.from(value,'utf8');
  for(const [token,context]of this.credentials)if(timingSafeEqual(incoming,Buffer.from(token,'utf8')))return context;
  return null;
 }
 private answer(res:ServerResponse,status:number):void{res.writeHead(status,{'content-type':'application/json','connection':'close'});res.end(status===200?'{}':'');}
 private async handle(req:IncomingMessage,res:ServerResponse):Promise<void>{
  if(req.headers.host!==`127.0.0.1:${this.port()}`){this.answer(res,421);req.resume();return;}
  if(Object.hasOwn(req.headers,'origin')){this.answer(res,403);req.resume();return;}
  if(req.method!=='POST'||!['/v1/metrics','/v1/logs'].includes(req.url??'')){this.answer(res,404);req.resume();return;}
  if(req.headers['content-type']!=='application/json'){this.answer(res,415);req.resume();return;}
  const context=this.authorize(req.headers['x-ai-term-session']);if(!context){this.answer(res,401);req.resume();return;}
  const length=Number(req.headers['content-length']);if(Number.isFinite(length)&&length>MAX_BODY){this.answer(res,413);req.pause();return;}
  let bytes=0;const chunks:Buffer[]=[];
  const body=await new Promise<Buffer|null>((resolve,reject)=>{
   req.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes>MAX_BODY){this.answer(res,413);req.pause();chunks.length=0;resolve(null);return;}chunks.push(chunk);});
   req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);
  });
  if(body===null)return;let raw:unknown;try{raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(body));}catch{this.answer(res,400);return;}
  // Credential may have been revoked while this body was being received.
  if(this.authorize(req.headers['x-ai-term-session'])!==context){this.answer(res,401);return;}
  await this.consume(req.url??'',raw,context);this.answer(res,200);
 }
 async close():Promise<void>{this.revokeAll();if(this.server.listening)await new Promise<void>((resolve,reject)=>this.server.close(error=>error?reject(error):resolve()));}
}

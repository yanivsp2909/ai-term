import {request} from 'node:http';
import {isValidModelId} from '../shared/validate.js';
export async function statusLine(options:{input?:AsyncIterable<string|Buffer>;env?:NodeJS.ProcessEnv;write?:(text:string)=>void}={}):Promise<void>{
 const input=options.input??process.stdin,env=options.env??process.env,write=options.write??(text=>{process.stdout.write(text);});
 let model='Claude',percent:number|null=null;
 try{
  const chunks:Buffer[]=[];let bytes=0;
  for await(const chunk of input){const data=Buffer.from(chunk);bytes+=data.length;if(bytes>1024*1024){chunks.length=0;break;}chunks.push(data);}
  if(bytes<=1024*1024){
   const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   if(raw&&typeof raw==='object'){
    if('model'in raw&&raw.model&&typeof raw.model==='object'&&'id'in raw.model&&typeof raw.model.id==='string'&&isValidModelId(raw.model.id)&&!raw.model.id.includes('sk-'))model=raw.model.id;
    if('context_window'in raw&&raw.context_window&&typeof raw.context_window==='object'&&'used_percentage'in raw.context_window){const value=raw.context_window.used_percentage;if(typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100)percent=value;}
   }
  }
 }catch{model='Claude';percent=null;}
 write(`${model} · ctx ${percent===null?'?':Math.round(percent)+'%'}\n`);
 const port=Number(env.AITERM_STATUS_PORT),token=env.AITERM_STATUS_TOKEN;
 if(percent===null||!Number.isInteger(port)||port<1||port>65535||!token||! /^[a-f0-9]{64}$/.test(token))return;
 const body=JSON.stringify({hook_event_name:'AITermContext',used_percentage:percent});
 // A status line must remain useful when the daemon is gone; failures never print headers/body/raw errors.
 await new Promise<void>(resolve=>{
  const req=request({hostname:'127.0.0.1',port,path:'/v1/status/claude',method:'POST',headers:{'content-type':'application/json','content-length':Buffer.byteLength(body),'x-ai-term-session':token}},res=>{res.resume();res.on('end',resolve);res.on('error',()=>resolve());});
  const timer=setTimeout(()=>{req.destroy();resolve();},1000);req.on('close',()=>clearTimeout(timer));req.on('error',()=>resolve());req.end(body);
 });
}

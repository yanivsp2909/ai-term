import { request, type Agent } from 'node:https';
import type { DeploymentTest } from '../../shared/protocol.js';
import { isEndpoint, isSecret, isValidModelId } from '../../shared/validate.js';
export interface ProviderRequest {url:URL;path:string;model:string;headers:Record<string,string>;body:Record<string,unknown>;timeout:number}
export interface ProviderReply {status:number;errorCode:string|null}
export type ProviderTransport=(request:ProviderRequest)=>Promise<ProviderReply>;
// No redirects: an auth header must never follow a server to another host.
export const providerTransportWithAgent=(agent?:Agent):ProviderTransport=>options=>new Promise((resolve,reject)=>{
 const req=request(options.url,{method:'POST',headers:options.headers,agent},res=>{
  let bytes=0,body='';res.setEncoding('utf8');res.on('data',(chunk:string)=>{bytes+=Buffer.byteLength(chunk);if(bytes>65536){req.destroy(new Error('Provider reply too large'));return;}body+=chunk;});
  res.on('error',reject);res.on('end',()=>{let code:string|null=null;if((res.statusCode??500)>=400){try{const value:unknown=JSON.parse(body);if(value&&typeof value==='object'&&'error'in value&&value.error&&typeof value.error==='object'&&'code'in value.error&&typeof value.error.code==='string')code=value.error.code;}catch{code=null;}}resolve({status:res.statusCode??500,errorCode:code});});
 });
 const timer=setTimeout(()=>req.destroy(new Error('Provider test timed out')),options.timeout);req.on('error',reject);req.on('close',()=>clearTimeout(timer));req.end(JSON.stringify(options.body));
});
export const providerTransport=providerTransportWithAgent();
export async function testFoundry(endpoint:string,deployments:string[],secret:string,transport:ProviderTransport=providerTransport):Promise<DeploymentTest[]>{
 if(!isEndpoint(endpoint)||!isSecret(secret)||!deployments.length||deployments.length>40||deployments.some(m=>!isValidModelId(m)))throw new Error('Invalid Foundry test details');
 const results:DeploymentTest[]=[];
 for(const model of deployments){
  const send=(route:string)=>{const url=new URL(endpoint.replace(/\/$/,'')+'/'+route);return transport({url,path:url.pathname,model,headers:{'api-key':secret,'content-type':'application/json'},body:route==='responses'?{model,input:'ping',max_output_tokens:16}:{model,messages:[{role:'user',content:'ping'}],max_tokens:16},timeout:15000});};
  try{let reply=await send('responses');if(reply.status>=200&&reply.status<300){results.push({model,status:'ready'});continue;}
   if(reply.status===400||reply.status===404){const chat=await send('chat/completions');if(chat.status>=200&&chat.status<300){results.push({model,status:'not a chat model'});continue;}reply=chat;}
   const code=reply.errorCode&&/^[A-Za-z0-9_.-]{1,80}$/.test(reply.errorCode)&&!reply.errorCode.includes(secret)&&!reply.errorCode.startsWith('sk-')?reply.errorCode:null;
   results.push({model,status:'error',httpStatus:reply.status,...(code?{errorCode:code}: {})});
  }catch{results.push({model,status:'error'});}
 }return results;
}

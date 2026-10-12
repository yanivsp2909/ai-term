import { expect, it } from 'vitest';
import { testFoundry, type ProviderRequest } from '../src/daemon/providers/foundry.js';
const secret='sk-ant-'+'AITERMCANARY0000';
it('returns ready, not a chat model and error using only the configured https host and api-key header',async()=>{
 const calls:ProviderRequest[]=[];const results=await testFoundry('https://example.com/openai/v1',['ready','chat','bad'],secret,async request=>{calls.push(request);return request.model==='ready'?{status:200,errorCode:null}:request.model==='chat'?{status:request.path.endsWith('/responses')?404:200,errorCode:null}:{status:401,errorCode:'Unauthorized'};});
 expect(results.map(r=>r.status)).toEqual(['ready','not a chat model','error']);expect(results[2]).toMatchObject({httpStatus:401,errorCode:'Unauthorized'});
 for(const call of calls){expect(call.url.origin).toBe('https://example.com');expect(call.headers).toEqual({'api-key':secret,'content-type':'application/json'});expect(call.timeout).toBe(15000);expect(JSON.stringify(call.body)).not.toContain(secret);}
 expect(JSON.stringify(results)).not.toContain('AITERMCANARY');
 await expect(testFoundry('http://example.com',['ready'],secret)).rejects.toThrow();
});
it('redacts provider error codes and rejects redirect/body content instead of exposing it',async()=>{
 const results=await testFoundry('https://example.com',['test'],secret,async()=>({status:302,errorCode:secret}));expect(results).toEqual([{model:'test',status:'error',httpStatus:302}]);
});
it('live local https stub exercises ready chat-only error and redirect paths without forwarding secrets',async()=>{
 const {mkdtemp,readFile,rm}=await import('node:fs/promises');const {join}=await import('node:path');const {execFile}=await import('node:child_process');const {createServer}=await import('node:https');const {providerTransportWithAgent}=await import('../src/daemon/providers/foundry.js');
 const root=await mkdtemp('/tmp/ai-https-');let server:ReturnType<typeof createServer>|undefined;
 try{
  await new Promise<void>((resolve,reject)=>execFile('/usr/bin/openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',join(root,'key.pem'),'-out',join(root,'cert.pem'),'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1'],{timeout:5000},error=>error?reject(new Error('Test certificate setup failed')):resolve()));
  const cert=await readFile(join(root,'cert.pem'));let requests=0;
  server=createServer({key:await readFile(join(root,'key.pem')),cert},(req,res)=>{let body='';req.on('data',d=>{body+=d;});req.on('end',()=>{requests++;expect(req.headers['api-key']).toBe(secret);const {model}=JSON.parse(body);if(model==='ready'){res.writeHead(200);res.end('{}');}else if(model==='chat'){res.writeHead(req.url?.endsWith('/responses')?404:200);res.end('{}');}else if(model==='redirect'){res.writeHead(302,{location:'https://other.example.com'});res.end();}else{res.writeHead(401);res.end(JSON.stringify({error:{code:'Unauthorized',message:secret}}));}});});
  await new Promise<void>(r=>server?.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('No address');
  const {Agent}=await import('node:https');const agent=new Agent({ca:cert});
  const transport=providerTransportWithAgent(agent);
  const result=await testFoundry(`https://127.0.0.1:${address.port}/openai/v1`,['ready','chat','bad','redirect'],secret,transport);
  expect(result.map(r=>r.status)).toEqual(['ready','not a chat model','error','error']);expect(requests).toBe(5);expect(JSON.stringify(result)).not.toContain(secret);agent.destroy();
 }finally{if(server)await new Promise<void>(r=>server?.close(()=>r()));await rm(root,{recursive:true,force:true});}
},10000);

import { expect,it } from 'vitest';
import { createServer } from 'node:net';
import { mkdtemp,chmod,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Connection,DaemonRequestError } from '../src/client/connection.js';
import { getPaths,preparePaths } from '../src/shared/paths.js';
import { FrameDecoder,decodeControl,encodeControl } from '../src/shared/protocol.js';

it.each([{},{ok:'invalid'},{ok:false,error:{message:'missing code'}}])('rejects malformed daemon response %j as an error, not an explicit rejection',async(fields)=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-connection-')),paths=getPaths(root);await preparePaths(paths);
 const server=createServer(socket=>{const decoder=new FrameDecoder();socket.on('data',data=>{for(const frame of decoder.push(data)){const request=decodeControl(frame) as {id:string};socket.end(encodeControl({id:request.id,...fields}));}});});
 try{
  await new Promise<void>(r=>server.listen(paths.socket,r));await chmod(paths.socket,0o600);
  const error:unknown=await Connection.connect(paths,{entry:resolve('src/cli/index.ts'),autoStart:false}).catch((error:unknown)=>error);
  expect(error).toBeInstanceOf(Error);expect(error).not.toBeInstanceOf(DaemonRequestError);expect((error as Error).message).toBe('Invalid daemon response');
 }finally{await new Promise<void>((r,reject)=>server.close(error=>error?reject(error):r()));await rm(root,{recursive:true,force:true});}
});
it('Foundry test waits for the bounded deployment probe budget, not the ordinary five-second timeout',async()=>{
 const {vi}=await import('vitest');const root=await mkdtemp('/tmp/ai-connection-budget-'),paths=getPaths(root);await preparePaths(paths);let reply:()=>void=()=>{};
 const server=createServer(socket=>{const decoder=new FrameDecoder();socket.on('data',data=>{for(const frame of decoder.push(data)){const r=decodeControl(frame) as {id:string;kind:string};if(r.kind==='hello')socket.write(encodeControl({id:r.id,ok:true,kind:'hello',protocol:1,version:'test',daemonPid:process.pid}));else reply=()=>socket.write(encodeControl({id:r.id,ok:true,results:[]}));}});});let client:Connection|undefined;
 try{await new Promise<void>(r=>server.listen(paths.socket,r));await chmod(paths.socket,0o600);client=await Connection.connect(paths,{entry:'/unused',autoStart:false});vi.useFakeTimers({toFake:['setTimeout','clearTimeout']});const pending=client.request({kind:'keys.test',keyId:'550e8400-e29b-41d4-a716-446655440000'});let failed=false;void pending.catch(()=>{failed=true;});await new Promise(r=>setImmediate(r));await vi.advanceTimersByTimeAsync(5001);expect(failed).toBe(false);reply();await pending;}finally{vi.useRealTimers();client?.close();await new Promise<void>(r=>server.close(()=>r()));await rm(root,{recursive:true,force:true});}
});

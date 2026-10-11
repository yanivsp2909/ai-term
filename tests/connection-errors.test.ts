import { expect,it,vi } from 'vitest';
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

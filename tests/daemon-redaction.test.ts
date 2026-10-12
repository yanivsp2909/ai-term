import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,lstat} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {resolve,join} from 'node:path';
it.each(['uncaughtException','unhandledRejection'])('%s routes canary error through logger and shuts down cleanly',async event=>{
 const root=await mkdtemp('/tmp/ai-daemon-redact-'),canary='sk-ant-'+'AITERMCANARY0000';
 const source=`import {runDaemon} from ${JSON.stringify(resolve('src/daemon/main.ts'))};const task=runDaemon();setTimeout(()=>process.emit(${JSON.stringify(event)},new Error(${JSON.stringify(canary)})),250);await task;`;
 const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',source],{cwd:resolve('.'),env:{PATH:'/usr/bin:/bin',HOME:root,AI_TERM_HOME:root},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',d=>{output+=d;});child.stderr.on('data',d=>{output+=d;});
 try{const code=await new Promise<number|null>(r=>child.on('exit',r));expect(code).toBe(1);const log=await readFile(join(root,'logs/daemon.log'),'utf8');expect(log).toContain('[REDACTED]');expect(log+output).not.toContain('AITERMCANARY');await expect(lstat(join(root,'run/daemon.pid'))).rejects.toMatchObject({code:'ENOENT'});}finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGTERM');await rm(root,{recursive:true,force:true});}
});

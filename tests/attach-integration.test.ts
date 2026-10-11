import { expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtemp, lstat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { Connection } from '../src/client/connection.js';
import { getPaths, isFsError } from '../src/shared/paths.js';
import { attach, type AttachTTY } from '../src/client/attach.js';
class TTY extends EventEmitter implements AttachTTY {
 isTTY=true;isRaw=false;columns=80;rows=24;output='';setRawMode(raw:boolean){this.isRaw=raw;}resume(){}pause(){}write(data:string|Buffer){this.output+=data.toString();return true;}
}
it('real daemon shell: fake TTY echo, home, confirmed detach, reattach snapshot and session exit',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-attach-int-')),paths=getPaths(root),entry=resolve('src/cli/index.ts');
 const daemon=spawn(process.execPath,['--import','tsx',entry,'daemon'],{env:{PATH:'/usr/bin:/bin',SHELL:'/bin/sh',AI_TERM_HOME:root},stdio:'ignore'});
 let client:Connection|undefined;const exited=new Promise<void>(r=>daemon.once('exit',()=>r()));
 try{
  await expect.poll(async()=>{try{return (await lstat(paths.socket)).isSocket();}catch(e){if(isFsError(e,'ENOENT'))return false;throw e;}},{timeout:5000}).toBe(true);
  client=await Connection.connect(paths,{entry,autoStart:false});const created=await client.request({kind:'sessions.create',engine:'shell',cwd:root});const id=created.session?.id;if(!id)throw new Error('No shell ID');
  const tty=new TTY(),signals=new EventEmitter();const home=attach(client,id,{stdin:tty,stdout:tty,signals});
  await expect.poll(()=>tty.output).toContain('\x1b[?25h');tty.emit('data',Buffer.from('echo hi\r'));await expect.poll(()=>tty.output).toContain('hi');tty.emit('data',Buffer.from([5]));await home;expect(tty.isRaw).toBe(false);
  const detached=await client.request({kind:'sessions.preview',sessionId:id});expect(detached).toMatchObject({cols:85,rows:30});expect(detached.snapshot).toContain('hi');await client.request({kind:'sessions.preview',sessionId:null});
  const again=new TTY(),completed=attach(client,id,{stdin:again,stdout:again,signals});await expect.poll(()=>again.output).toContain('hi');again.emit('data',Buffer.from('exit\r'));await completed;expect(again.output).toContain('[session exited with code 0]');expect(again.isRaw).toBe(false);
  const closed=new TTY();expect(await attach(client,id,{stdin:closed,stdout:closed,signals})).toBe('session exited');expect(closed.output).toContain('[session exited with code 0]');expect(closed.isRaw).toBe(false);
 }finally{client?.close();if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill('SIGTERM');await exited;await rm(root,{recursive:true,force:true});}
},15000);

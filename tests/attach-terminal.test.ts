import { expect,it } from 'vitest';
import { mkdtemp,lstat,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { Connection } from '../src/client/connection.js';
import { getPaths,isFsError } from '../src/shared/paths.js';
import { RESET_MODES } from '../src/client/terminal-modes.js';

it('real terminal query replies and startup noise stay attached; Ctrl+E detaches from live vim and reattach preserves text',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-terminal-')),paths=getPaths(root),entry=resolve('src/cli/index.ts');
 const env={PATH:'/usr/bin:/bin',HOME:root,SHELL:'/bin/sh',AI_TERM_HOME:root,TERM:'xterm-256color',TERM_PROGRAM:'Apple_Terminal',COLORTERM:'truecolor'};
 const daemon=spawn(process.execPath,['--import','tsx',entry,'daemon'],{env,stdio:'ignore'}),exited=new Promise<void>(r=>daemon.once('exit',()=>r()));
 let client:Connection|undefined;const terminals:headless.Terminal[]=[],children:{child:pty.IPty;exit:Promise<number>;finished:()=>boolean}[]=[];
 const open=(id:string)=>{
  const terminal=new headless.Terminal({cols:80,rows:24,allowProposedApi:true});terminals.push(terminal);
  const child=pty.spawn(process.execPath,['--import','tsx',entry,'debug','attach',id],{env,cwd:resolve('.'),cols:80,rows:24,name:'xterm-256color'});
  let output='',finished=false;const exit=new Promise<number>(r=>child.onExit(event=>{finished=true;r(event.exitCode);}));
  children.push({child,exit,finished:()=>finished});
  terminal.onData(data=>{if(!finished)child.write(data);});child.onData(data=>{output+=data;terminal.write(data);});
  return {child,exit,output:()=>output,finished:()=>finished};
 };
 try{
  await expect.poll(async()=>{try{return (await lstat(paths.socket)).isSocket();}catch(error){if(isFsError(error,'ENOENT'))return false;throw error;}},{timeout:5000}).toBe(true);
  client=await Connection.connect(paths,{entry,autoStart:false});const created=await client.request({kind:'sessions.create',engine:'shell',cwd:root});const id=created.session?.id;if(!id)throw new Error('No shell ID');
  const first=open(id);await expect.poll(first.output).toContain('\x1b[?1049h');
  const noise='\x1b[?1;2c\x1b[>0;276;0c\x1b[1;1R\x1b]10;rgb:ffff/ffff/ffff\x07\x1b]11;rgb:0000/0000/0000\x1b\\\x1b[?0u\x1b[I\x1b[O\x1b[?2004h\x1b=';
  first.child.write(noise.slice(0,18));first.child.write(noise.slice(18));await new Promise(r=>setTimeout(r,150));expect(first.finished()).toBe(false);first.child.write('\x15');
  first.child.write('/usr/bin/vim -u NONE -U NONE -i NONE -n\r');await expect.poll(first.output).toContain('VIM');first.child.write('iB1_VIM_TEXT');await expect.poll(first.output).toContain('B1_VIM_TEXT');
  first.child.resize(100,35);first.child.write('\x05');expect(await first.exit).toBe(0);expect(first.output()).toContain('back in your shell (home key)');expect(first.output()).toContain(RESET_MODES+'\x1b[?1049l');
  const again=open(id);await expect.poll(again.output).toContain('B1_VIM_TEXT');again.child.write('\x1b:qa!\r');await new Promise(r=>setTimeout(r,100));again.child.write('exit\r');expect(await again.exit).toBe(0);expect(again.output()).toContain('[session exited with code 0]');expect(again.output()).toContain('back in your shell (session exited)');
 }finally{
  for(const child of children){if(!child.finished())child.child.kill();await child.exit;}
  client?.close();if(daemon.exitCode===null&&daemon.signalCode===null)daemon.kill('SIGTERM');await exited;for(const terminal of terminals)terminal.dispose();await rm(root,{recursive:true,force:true});
 }
},15000);

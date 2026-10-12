import { expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

it.each(['EPIPE', 'EBADF'])('B20 handles asynchronous stdout %s with fixed diagnostics', async code => {
  const root = await mkdtemp('/tmp/ai-b20-'), home = join(root, 'unused');
  try {
    const script = `process.argv=[process.execPath,'ai','--version'];process.stdout.write=()=>{queueMicrotask(()=>process.stdout.emit('error',Object.assign(new Error('AITERMCANARY'),{code:${JSON.stringify(code)}})));return false;};await import(${JSON.stringify(pathToFileURL(resolve('src/cli/index.ts')).href)});`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, AI_TERM_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = ''; child.stdout.on('data', data => { output += String(data); }); child.stderr.on('data', data => { output += String(data); });
    const exit = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve); });
    expect(exit).toBe(code === 'EPIPE' ? 0 : 1); expect(output).toBe(code === 'EPIPE' ? '' : 'Standard output failed\n');
    expect(output).not.toContain('AITERMCANARY'); await expect(lstat(home)).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('B20 stats pipe handling does not bypass interactive attach terminal cleanup', async () => {
  const root = await mkdtemp('/tmp/ai-b20-attach-');
  try {
    const script = `import {EventEmitter} from 'node:events';
process.argv=[process.execPath,'ai','--version'];await import(${JSON.stringify(pathToFileURL(resolve('src/cli/index.ts')).href)});
const {attach}=await import(${JSON.stringify(pathToFileURL(resolve('src/client/attach.ts')).href)});
const tty=new EventEmitter();let raw=false,output='';tty.isTTY=true;tty.isRaw=false;tty.setRawMode=value=>{raw=value;};tty.resume=()=>{};tty.pause=()=>{};
Object.defineProperty(process.stdout,'isTTY',{value:true});process.stdout.columns=80;process.stdout.rows=24;process.stdout.write=data=>{output+=String(data);return true;};
const client=new EventEmitter();client.input=()=>{};client.request=async()=>({id:'00000000-0000-4000-8000-000000000001',ok:true,snapshot:'',cols:80,rows:24,modes:{applicationCursorKeys:false,applicationKeypad:false,bracketedPaste:false,mouseTracking:'none',mouseEncoding:'default',focusEvents:false,cursorVisible:true}});
const done=attach(client,'00000000-0000-4000-8000-000000000001',{stdin:tty,stdout:process.stdout,signals:new EventEmitter()}).catch(()=>{});
setImmediate(()=>process.stdout.emit('error',Object.assign(new Error('AITERMCANARY'),{code:'EPIPE'})));await done;process.stderr.write(JSON.stringify({raw,restored:output.includes('\\x1b[?1049l')})+'\\n');`;
    const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script], { env: { PATH: process.env.PATH, AI_TERM_HOME: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = ''; child.stderr.on('data', data => { stderr += String(data); });
    expect(await new Promise(resolve => child.on('close', resolve))).toBe(0);
    expect(stderr).toBe('{"raw":false,"restored":true}\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});

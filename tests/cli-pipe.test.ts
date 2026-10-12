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

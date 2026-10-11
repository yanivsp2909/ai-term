import { expect,it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp,mkdir,writeFile,readFile,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

it('debug attach preserves an unsafe-home error and never logs through the rejected symlink',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-diagnostic-'));
 try{
  const target=join(root,'target'),home=join(root,'home');
  await mkdir(target);await mkdir(join(target,'logs'));const log=join(target,'logs/daemon.log');await writeFile(log,'original\n');await symlink(target,home);
  const result=await promisify(execFile)(process.execPath,['--import','tsx',resolve('src/cli/index.ts'),'debug','attach',randomUUID()],{env:{PATH:'/usr/bin:/bin',AI_TERM_HOME:home,AI_TERM_DEBUG:'1'},timeout:5000}).catch((error:unknown)=>{
   if(!(error instanceof Error)||!('stdout' in error)||!('stderr' in error))throw error;
   return {stdout:String(error.stdout),stderr:String(error.stderr)};
  });
  expect(result.stdout).toContain('back in your shell (error)');expect(result.stderr).toContain('Private directory must be a real directory');expect(await readFile(log,'utf8')).toBe('original\n');
 }finally{await rm(root,{recursive:true,force:true});}
});

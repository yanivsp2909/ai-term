import {expect,it} from 'vitest';
import {mkdtemp,readFile,rm,stat,symlink,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildClaudeSettings,writeClaudeSettings,removeClaudeSettings} from '../src/daemon/claude-settings.js';
import {buildStatusEnv,buildStatusArgs,buildShellEnv} from '../src/daemon/env.js';
const token='a'.repeat(64),port=12345;
it('settings use literal env interpolation and safe absolute command paths; args never carry token',()=>{
 const settings=buildClaudeSettings(port,'/usr/bin/node','/repo/dist/cli/index.js');
 for(const hooks of Object.values(settings.hooks))for(const entry of hooks)for(const hook of entry.hooks)expect(hook).toEqual({type:'http',url:'http://127.0.0.1:12345/v1/status/claude',headers:{'x-ai-term-session':'$AITERM_STATUS_TOKEN'},allowedEnvVars:['AITERM_STATUS_TOKEN'],timeout:2});
 expect(settings.statusLine).toEqual({type:'command',command:'/usr/bin/node /repo/dist/cli/index.js status-line'});expect(JSON.stringify(settings)).not.toContain(token);
 for(const path of ['/repo/a b','/repo/a;touch','relative','/repo/../cli','/repo/cli\n','/repo/$(id)'])expect(buildClaudeSettings(port,'/usr/bin/node',path)).not.toHaveProperty('statusLine');
 expect(buildStatusEnv({port,credential:token})).toEqual({AITERM_STATUS_TOKEN:token,AITERM_STATUS_PORT:String(port)});expect(buildStatusArgs('/tmp/claude-settings.json')).toEqual(['--settings=/tmp/claude-settings.json']);
 expect(buildShellEnv({AITERM_STATUS_TOKEN:token,AITERM_STATUS_PORT:'5',PATH:'/bin'})).not.toHaveProperty('AITERM_STATUS_TOKEN');
});
it('creates 0700/0600 session settings without token and removes only the generated file',async()=>{
 const root=await mkdtemp('/tmp/ai-claude-settings-'),id=randomUUID();
 try{const file=await writeClaudeSettings(root,id,port,'/usr/bin/node','/repo/cli.js');expect((await stat(join(root,'sessions',id))).mode&0o777).toBe(0o700);expect((await stat(file)).mode&0o777).toBe(0o600);expect(await readFile(file,'utf8')).not.toContain(token);await removeClaudeSettings(root,id);await expect(stat(file)).rejects.toMatchObject({code:'ENOENT'});
 await rm(join(root,'sessions'),{recursive:true});const outside=join(root,'outside');await mkdir(outside);await symlink(outside,join(root,'sessions'));await expect(writeClaudeSettings(root,randomUUID(),port,'/usr/bin/node','/repo/cli.js')).rejects.toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
it('source status-line command includes a safe absolute loader and executes without touching a daemon home',async()=>{
 const {createRequire}=await import('node:module'),{resolve}=await import('node:path'),{spawn}=await import('node:child_process');
 const root=await mkdtemp('/tmp/ai-source-statusline-'),loader=createRequire(import.meta.url).resolve('tsx');
 try{
  const settings=buildClaudeSettings(port,process.execPath,resolve('src/cli/index.ts'),loader);expect(settings.statusLine?.command).toContain(`--import ${loader}`);
  const parts=settings.statusLine?.command.split(' ');if(!parts)throw new Error('fixture');
  const child=spawn(parts[0]??'',parts.slice(1),{env:{PATH:'/usr/bin:/bin',AI_TERM_HOME:join(root,'unused')},stdio:['pipe','pipe','pipe']});let stdout='',stderr='';child.stdout.on('data',d=>{stdout+=String(d);});child.stderr.on('data',d=>{stderr+=String(d);});child.stdin.end('{"model":{"id":"sonnet"},"context_window":{"used_percentage":20}}');
  expect(await new Promise(r=>child.on('close',r))).toBe(0);expect(stdout).toBe('sonnet · ctx 20%\n');expect(stderr).toBe('');await expect(stat(join(root,'unused'))).rejects.toMatchObject({code:'ENOENT'});
  expect(buildClaudeSettings(port,process.execPath,resolve('src/cli/index.ts'),'/bad loader')).not.toHaveProperty('statusLine');
 }finally{await rm(root,{recursive:true,force:true});}
});

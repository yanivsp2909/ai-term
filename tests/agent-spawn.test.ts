import { expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { Connection } from '../src/client/connection.js';
import { PtyHost } from '../src/daemon/pty-host.js';
const canary='sk-ant-AITERMCANARY0000';
it('creates account agents with fresh recipes, sanitized metadata, preview, and no canary in handlers/state/logs',async()=>{
 const root=await mkdtemp('/tmp/ai-spawn-'),paths=getPaths(root);await preparePaths(paths);
 const script='#!/bin/sh\nif [ "$1" = "--version" ]; then printf "2.1.295"; exit; fi\nif [ "$1" = "auth" ]; then printf \'{"loggedIn":true,"authMethod":"claude.ai","email":"PRIVATE"}\'; exit; fi\nif [ "$1" = "login" ]; then printf "Logged in using an API key - PRIVATE" >&2; exit; fi\nprintf AGENT_READY\nread answer\n';
 for(const name of ['claude','codex'])await writeFile(join(root,name),script,{mode:0o700});
 const oldPath=process.env.PATH,oldClaude=process.env.ANTHROPIC_API_KEY,oldCodex=process.env.OPENAI_API_KEY;
 process.env.PATH=root+':/usr/bin:/bin';process.env.ANTHROPIC_API_KEY=canary;process.env.OPENAI_API_KEY=canary;
 const recipes:unknown[]=[];const spawn=vi.spyOn(PtyHost.prototype,'write');
 const log=new Logger(paths.log),manager=new SessionManager(paths,log),server=new DaemonServer(paths,manager,log);let client:Connection|undefined;
 try{
  await manager.load();await server.listen();client=await Connection.connect(paths,{entry:'/unused',autoStart:false});const events:unknown[]=[];client.on('event',e=>events.push(e));
  const engines=await client.request({kind:'engines.status'});expect(engines.engines?.claudeCode.authMethod).toBe('subscription');
  for(const engine of ['claude-code','codex'] as const){
   const response=await client.request({kind:'sessions.create',engine,model:null,auth:{kind:'account'},cwd:root,permission:'ask',title:'agent',firstMessage:'reply with ok'});recipes.push(response);
   const id=response.session?.id;if(!id)throw new Error('No session');await expect.poll(()=>manager.get(id).status).toBe('running');
   expect(manager.get(id)).toMatchObject({engine,model:null,authMethod:engine==='claude-code'?'subscription':'api-key'});
   const preview=await client.request({kind:'sessions.preview',sessionId:id});expect(preview.snapshot).toContain('AGENT_READY');recipes.push(preview);
   recipes.push(await client.request({kind:'sessions.list'}));recipes.push(await client.request({kind:'sessions.rename',sessionId:id,title:'renamed'}));
   recipes.push(await client.request({kind:'sessions.stop',sessionId:id}));recipes.push(await client.request({kind:'sessions.remove',sessionId:id}));
  }
  recipes.push(await client.request({kind:'settings.get'}));recipes.push(await client.request({kind:'settings.set',patch:{theme:'slate'}}));recipes.push(engines);
  expect(JSON.stringify([...recipes,...events])).not.toMatch(/AITERMCANARY|PRIVATE/);
  for(const file of [paths.state,paths.log]){let data='';try{data=await readFile(file,'utf8');}catch(error){if(!(error instanceof Error&&'code' in error&&error.code==='ENOENT'))throw error;}expect(data).not.toContain('AITERMCANARY');}
  expect(spawn.mock.calls.some(([data])=>String(data).includes(canary))).toBe(false);
 }finally{client?.close();await server.close();await manager.shutdown();spawn.mockRestore();if(oldPath===undefined)delete process.env.PATH;else process.env.PATH=oldPath;if(oldClaude===undefined)delete process.env.ANTHROPIC_API_KEY;else process.env.ANTHROPIC_API_KEY=oldClaude;if(oldCodex===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=oldCodex;await rm(root,{recursive:true,force:true});}
});

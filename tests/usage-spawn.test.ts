import {expect,it,vi} from 'vitest';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import pty from 'node-pty';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {Logger} from '../src/daemon/log.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {UsageService} from '../src/daemon/usage-service.js';
import {buildUsageArgs,buildUsageEnv} from '../src/daemon/env.js';
import * as engines from '../src/daemon/engines.js';
const telemetry={port:12345,credential:'a'.repeat(64)};
it('usage additions affect only eligible engine telemetry without changing base argv/env',()=>{
 expect(buildUsageArgs('claude-code',telemetry)).toEqual([]);expect(buildUsageEnv('codex',telemetry)).toEqual({});const env=buildUsageEnv('claude-code',telemetry);expect(env).toMatchObject({CLAUDE_CODE_ENABLE_TELEMETRY:'1',OTEL_METRICS_EXPORTER:'otlp',OTEL_LOGS_EXPORTER:'none',OTEL_EXPORTER_OTLP_PROTOCOL:'http/json',OTEL_EXPORTER_OTLP_METRICS_ENDPOINT:'http://127.0.0.1:12345/v1/metrics',OTEL_EXPORTER_OTLP_METRICS_HEADERS:'x-ai-term-session='+telemetry.credential,OTEL_METRIC_EXPORT_INTERVAL:'10000'});const args=buildUsageArgs('codex',telemetry);expect(args).toContain('otel.log_user_prompt=false');expect(args).toContain('otel.exporter={otlp-http={endpoint="http://127.0.0.1:12345/v1/logs",protocol="json",headers={"x-ai-term-session"="'+telemetry.credential+'"}}}');expect(args.filter(a=>a==='-c')).toHaveLength(2);
});
it('own API-key login gets telemetry; subscription unknown and login sessions never do; credential revoked and not persisted',async()=>{
 const root=await mkdtemp('/tmp/ai-usage-spawn-'),p=getPaths(root);await preparePaths(p);const log=new Logger(p.log),usage=new UsageService(root,log),m=new SessionManager(p,log,undefined,undefined,undefined,undefined,usage);const status=vi.spyOn(engines,'checkEngine');const real=pty.spawn;let argv:string[]=[];let env:NodeJS.ProcessEnv={};const spy=vi.spyOn(pty,'spawn').mockImplementation((_exe,args,opts)=>{argv=Array.isArray(args)?args:[];env=opts?.env??{};return real('/bin/sh',['-c','printf up; read done'],{...opts,env:{PATH:'/usr/bin:/bin'}});});
 try{await usage.start();await m.load();for(const authMethod of ['api-key','subscription','unknown']as const){status.mockResolvedValue({installed:true,path:'/bin/sh',version:'1',loggedIn:true,authMethod});const session=await m.create({engine:'codex',model:'gpt-6.1-sol',auth:{kind:'account'},cwd:root,permission:'ask'});const config=argv.find(a=>a.startsWith('otel.exporter='));expect(Boolean(config)).toBe(authMethod==='api-key');expect(env.OTEL_METRICS_EXPORTER).toBeUndefined();await expect.poll(()=>m.get(session.id).status).toBe('running');await m.stop(session.id);if(config){const credential=config.match(/x-ai-term-session"="([a-f0-9]+)"/)?.[1];if(!credential)throw new Error('Missing credential');expect(await readFile(p.state,'utf8')).not.toContain(credential);expect((await fetch('http://127.0.0.1:'+usage.diagnostics().port+'/v1/logs',{method:'POST',headers:{'content-type':'application/json','x-ai-term-session':credential},body:'{}'})).status).toBe(401);}}
 status.mockResolvedValue({installed:true,path:'/bin/sh',version:'1',loggedIn:true,authMethod:'api-key'});const login=await m.create({engine:'codex',model:null,auth:{kind:'account'},cwd:root,permission:'ask',login:true});expect(argv.join(' ')).not.toContain('otel.');await m.stop(login.id);
 }finally{await m.shutdown();await usage.close();spy.mockRestore();status.mockRestore();await rm(root,{recursive:true,force:true});}
});

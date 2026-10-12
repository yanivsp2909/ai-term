import {expect,it,vi} from 'vitest';
// ai doctor must ask each CLI about its login with the same provider cleanup the daemon uses (§7.3), or an exported
// ANTHROPIC_API_KEY / OPENAI_API_KEY makes doctor report "API key" for an account sessions really use as a subscription.
const calls:{file:string;env:NodeJS.ProcessEnv|undefined}[]=[];
vi.mock('node:child_process',()=>({execFile:(file:string,args:string[],options:{env?:NodeJS.ProcessEnv},callback:(error:null,stdout:string,stderr:string)=>void)=>{calls.push({file,env:options.env});callback(null,args[0]==='--version'?'1.0.0':file.endsWith('claude')?'{"loggedIn":true,"authMethod":"claude.ai"}':'Logged in using ChatGPT','');}}));
import {doctor} from '../src/cli/doctor.js';
it('doctor checks each CLI login without its own provider credential variables',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'ai-term-doctor-env-'));
 vi.stubEnv('AI_TERM_HOME',root);vi.stubEnv('PATH',root);vi.stubEnv('ANTHROPIC_API_KEY','sk-ant-AITERMCANARY0000');vi.stubEnv('CLAUDE_CODE_OAUTH_TOKEN','oauth-canary');vi.stubEnv('OPENAI_API_KEY','sk-AITERMCANARY1111');
 const print=vi.spyOn(process.stdout,'write').mockImplementation(()=>true);
 try{for(const name of ['claude','codex'])await writeFile(join(root,name),'fake',{mode:0o700});
  await doctor(resolve('src/cli/index.ts'));
  const claude=calls.filter(c=>c.file.endsWith('claude')),codex=calls.filter(c=>c.file.endsWith('codex'));
  expect(claude.length).toBeGreaterThan(0);expect(codex.length).toBeGreaterThan(0);
  for(const c of claude){expect(c.env).toBeDefined();expect(c.env?.ANTHROPIC_API_KEY).toBeUndefined();expect(c.env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();}
  for(const c of codex){expect(c.env).toBeDefined();expect(c.env?.OPENAI_API_KEY).toBeUndefined();}
 }finally{print.mockRestore();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

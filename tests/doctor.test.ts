vi.mock('node:child_process',()=>({execFile:(file:string,args:string[],_options:unknown,callback:(error:null,stdout:string,stderr:string)=>void)=>callback(null,args[0]==='--version'?'2.1.114 PRIVATE':file.endsWith('claude')?JSON.stringify({loggedIn:true,authMethod:'claude.ai',email:'PRIVATE'}):'Logged in using ChatGPT PRIVATE','')}));
import { expect, it, vi } from 'vitest';
import { claudeAuth, codexAuth, versionNumber, doctor } from '../src/cli/doctor.js';
it('keeps only auth state and method from potentially sensitive CLI output', () => {
    expect(claudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', email: 'PRIVATE', organization: 'PRIVATE' }))).toBe('logged in yes; subscription');
    expect(claudeAuth(JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiKey: 'PRIVATE' }))).toBe('logged in yes; API key');
    expect(claudeAuth('{bad')).toBe('status unavailable (invalid JSON)');
    expect(claudeAuth('{"loggedIn":false}')).toBe('logged in no');
    expect(codexAuth(0, 'Logged in using ChatGPT')).toBe('exit 0; ChatGPT');
    expect(codexAuth(0, 'Logged in using an API key - PRIVATE')).toBe('exit 0; API key');
    expect(codexAuth(1, 'Not logged in PRIVATE')).toBe('exit 1; logged in no');
    expect(versionNumber('2.1.114 (Claude Code) PRIVATE')).toBe('2.1.114');
    expect(versionNumber('PRIVATE')).toBe('unavailable');
});

it('doctor prints paths and allowlisted facts with fake CLIs and leaves a missing daemon stopped',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,resolve}=await import('node:path');
 const root=await mkdtemp(join(tmpdir(),'ai-term-doctor-'));
 vi.stubEnv('AI_TERM_HOME',root);vi.stubEnv('PATH',root);
 const output:string[]=[];const print=vi.spyOn(process.stdout,'write').mockImplementation(value=>{output.push(String(value));return true;});
 try{
  for(const name of ['claude','codex'])await writeFile(join(root,name),'fake',{mode:0o700});
  await doctor(resolve('src/cli/index.ts'));expect(output.join('')).toContain('Daemon: not running');expect(output.join('')).toContain('subscription');expect(output.join('')).toContain('ChatGPT');expect(output.join('')).not.toContain('PRIVATE');
  await rm(join(root,'claude'));await rm(join(root,'codex'));output.length=0;await doctor(resolve('src/cli/index.ts'));expect(output.join('')).toContain('not found');
 }finally{print.mockRestore();vi.unstubAllEnvs();await rm(root,{recursive:true,force:true});}
});

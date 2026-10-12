import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {buildArgs} from '../src/daemon/env.js';
import {EFFORT_LEVELS} from '../src/shared/validate.js';
it('builds exact documented engine modes and rejects unsupported Codex auto',()=>{
 const prefix=['--no-daemon','-c','check_for_update_on_startup=false'];
 expect(buildArgs({engine:'claude-code',model:null,permission:'ask'})).toEqual(['--permission-mode=default']);expect(buildArgs({engine:'claude-code',model:null,permission:'auto'} as never)).toEqual(['--permission-mode=auto']);expect(buildArgs({engine:'claude-code',model:null,permission:'dontAsk'})).toEqual(['--permission-mode=bypassPermissions']);
 expect(buildArgs({engine:'codex',model:null,permission:'ask'})).toEqual([...prefix,'--ask-for-approval=on-request','--sandbox=workspace-write']);expect(buildArgs({engine:'codex',model:null,permission:'dontAsk'})).toEqual([...prefix,'--ask-for-approval=never','--sandbox=workspace-write']);expect(()=>buildArgs({engine:'codex',model:null,permission:'auto'} as never)).toThrow();
});
it('engine effort values are argv elements and CLI default adds nothing',()=>{
 for(const engine of ['claude-code','codex']as const){for(const effort of EFFORT_LEVELS[engine]){const args=buildArgs({engine,model:'test',permission:'ask',effort,firstMessage:'$(no shell)'} as never);expect(args).toContain(engine==='codex'?`model_reasoning_effort="${effort}"`:`--effort=${effort}`);expect(args.slice(-2)).toEqual(['--','$(no shell)']);}expect(buildArgs({engine,model:null,permission:'ask',effort:null} as never)).toEqual(buildArgs({engine,model:null,permission:'ask'}));for(const effort of ['-high','high x','"high"'])expect(()=>buildArgs({engine,model:null,permission:'ask',effort}as never)).toThrow();}
});
it('Claude new and resumed conversation IDs are validated single argv elements and Codex uses its picker',()=>{
 const conversationId=randomUUID();expect(buildArgs({engine:'claude-code',model:'sonnet',permission:'ask',conversationId}as never)).toContain('--session-id='+conversationId);const resumed=buildArgs({engine:'claude-code',model:'sonnet',permission:'ask',conversationId,resume:true}as never);expect(resumed).toContain('--resume='+conversationId);expect(resumed.some(a=>a.startsWith('--session-id'))).toBe(false);
 const codex=buildArgs({engine:'codex',model:'test',permission:'ask',resume:true}as never);expect(codex[0]).toBe('--no-daemon');expect(codex).toContain('resume');expect(()=>buildArgs({engine:'claude-code',model:null,permission:'ask',conversationId:'--bad'}as never)).toThrow();expect(()=>buildArgs({engine:'claude-code',model:null,permission:'ask',resume:true}as never)).toThrow();
});

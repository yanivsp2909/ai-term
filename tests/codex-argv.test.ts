import {expect,it} from 'vitest';
import {buildArgs} from '../src/daemon/env.js';
const TUI=['-c','tui.notifications=["agent-turn-complete","approval-requested"]','-c','tui.notification_method="osc9"','-c','tui.notification_condition="always"','-c','tui.terminal_title=["activity","run-state","context-remaining"]'];
const ASK=['--ask-for-approval=on-request','--sandbox=workspace-write'];
const HEAD=['--no-daemon','-c','check_for_update_on_startup=false'];
it('app paths with spaces are preserved as single notify argv elements',()=>{
 const node='/Applications/AI Term.app/Contents/MacOS/ai-node',entry='/Applications/AI Term.app/Contents/Resources/app/dist/cli/index.js';
 expect(buildArgs({engine:'codex',model:null,permission:'ask',codexStatus:{node,entry}})).toContain(`notify=${JSON.stringify([node,entry,'status-notify'])}`);
});
it('Codex status argv adds notify and terminal signals as single -c elements after the one --no-daemon',()=>{
 const args=buildArgs({engine:'codex',model:null,permission:'ask',codexStatus:{node:'/usr/local/bin/node',entry:'/opt/ai-term/dist/cli/index.js'},firstMessage:'hi'});
 expect(args).toEqual([...HEAD,'-c','notify=["/usr/local/bin/node","/opt/ai-term/dist/cli/index.js","status-notify"]',...TUI,...ASK,'--','hi']);
 expect(args.filter(a=>a==='--no-daemon')).toHaveLength(1);
});
it('source sessions put the validated tsx loader in the notify array; resume keeps status before the subcommand',()=>{
 const codexStatus={node:'/n/node',entry:'/repo/src/cli/index.ts',loader:'/repo/node_modules/tsx/dist/loader.mjs'};
 expect(buildArgs({engine:'codex',model:'gpt-5',permission:'dontAsk',codexStatus})).toEqual([...HEAD,'-c','notify=["/usr/bin/env","TSX_TSCONFIG_PATH=/repo/tsconfig.json","/n/node","--import","/repo/node_modules/tsx/dist/loader.mjs","/repo/src/cli/index.ts","status-notify"]',...TUI,'--model=gpt-5','--ask-for-approval=never','--sandbox=workspace-write']);
 const resumed=buildArgs({engine:'codex',model:null,permission:'ask',resume:true,codexStatus});expect(resumed.indexOf('resume')).toBeGreaterThan(resumed.indexOf('tui.terminal_title=["activity","run-state","context-remaining"]'));
});
it('any unsafe notify path leaves notify off but keeps the terminal signals',()=>{
 for(const codexStatus of [{node:'node',entry:'/a/index.js'},{node:'/n/node',entry:'/a/"],x=["/index.js'},{node:'/n/node',entry:'/a/../index.js'},{node:'/n/node',entry:'/a/index.ts'},{node:'/n/node',entry:'/a/index.ts',loader:'rel/loader.mjs'},{node:'/n/no\nde',entry:'/a/index.js'}]){
  const args=buildArgs({engine:'codex',model:null,permission:'ask',codexStatus});
  expect(args.some(a=>a.startsWith('notify='))).toBe(false);expect(args).toEqual([...HEAD,...TUI,...ASK]);
 }
});
it('Codex status argv is Codex-only and carries no credential or forbidden flag',()=>{
 expect(()=>buildArgs({engine:'claude-code',model:null,permission:'ask',codexStatus:{node:'/n/node',entry:'/a/index.js'}})).toThrow('Invalid spawn arguments');
 const args=buildArgs({engine:'codex',model:null,permission:'dontAsk',codexStatus:{node:'/n/node',entry:'/a/index.js'}}).join(' ');
 for(const flag of ['--dangerously-bypass-approvals-and-sandbox','--yolo','--full-auto','danger-full-access','AITERM_STATUS_TOKEN','x-ai-term-session'])expect(args).not.toContain(flag);
 expect(buildArgs({engine:'codex',model:null,permission:'ask'})).toEqual([...HEAD,...ASK]);
});

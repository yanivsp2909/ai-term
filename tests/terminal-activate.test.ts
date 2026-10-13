import {expect,it,vi} from 'vitest';
import {terminalBundle} from '../src/shared/terminal-app.js';
import {isTerminalBundle,validateRequest} from '../src/shared/validate.js';
import {activateTerminal} from '../src/daemon/terminal-activate.js';
import {randomUUID} from 'node:crypto';
it('maps only known TERM_PROGRAM values to fixed bundle ids',()=>{
 for(const [program,bundle]of [['Apple_Terminal','com.apple.Terminal'],['iTerm.app','com.googlecode.iterm2'],['ghostty','com.mitchellh.ghostty'],['WezTerm','com.github.wez.wezterm']])expect(terminalBundle(program)).toBe(bundle);
 for(const unknown of [undefined,'other','com.apple.Terminal','__proto__','constructor','-x'])expect(terminalBundle(unknown)).toBeUndefined();
});
it('validates subscriptions against the fixed bundle allowlist',async()=>{
 expect(isTerminalBundle('com.apple.Terminal')).toBe(true);
 for(const terminal of ['free.app','-x',null,42])await expect(validateRequest({id:randomUUID(),kind:'clicks.subscribe',on:true,terminal})).rejects.toThrow('Invalid click subscription');
 await expect(validateRequest({id:randomUUID(),kind:'clicks.subscribe',on:true,terminal:'com.apple.Terminal'})).resolves.toMatchObject({terminal:'com.apple.Terminal'});
});
it('activates with the exact executable, argv, minimal PATH and timeout',async()=>{
 const launch=vi.fn().mockResolvedValue(undefined);await activateTerminal('com.apple.Terminal',launch);
 expect(launch).toHaveBeenCalledExactlyOnceWith('/usr/bin/open',['-b','com.apple.Terminal'],{env:{PATH:'/usr/bin:/bin'},timeout:5000});
 await expect(activateTerminal('free.app' as 'com.apple.Terminal',launch)).rejects.toThrow('Invalid terminal app');expect(launch).toHaveBeenCalledTimes(1);
});

import { expect,it } from 'vitest';
import { validateSettings,validateSettingsPatch } from '../src/shared/validate.js';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
it('bar accepts only on/off and missing means off',()=>{
 expect(validateSettingsPatch({bar:'on'},true)).toEqual({bar:'on'});expect(validateSettings({theme:'graphite'}).bar??'off').toBe('off');
 for(const bar of [true,'bad',3])expect(()=>validateSettings({theme:'graphite',bar})).toThrow();
});
it('settings toggles bar with a keyboard shortcut and shows default off',async()=>{
 let settings:import('../src/shared/protocol.js').Settings={theme:'graphite' as const,bar:'off' as 'on'|'off'};
 const panel=new CredentialsPanel('settings',{request:async body=>{if(body.kind==='settings.set')settings={...settings,...body.patch};return {id:'unused',ok:true,settings};},changed(){},close(){},login:async()=>{},defaults(){},theme:async()=>{}});
 await panel.load();expect(panel.lines().join('\n')).toContain('bar: off');await panel.key('h');expect(panel.lines().join('\n')).toContain('bar: on');await panel.key('h');expect(settings.bar).toBe('off');
});

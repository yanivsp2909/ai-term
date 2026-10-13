import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {CredentialsPanel} from '../src/client/tui/credentials.js';
import {SettingsStore} from '../src/daemon/settings.js';
import {validateSettings,validateSettingsPatch,validateSuccess} from '../src/shared/validate.js';
import type {RequestBody} from '../src/client/connection.js';
import type {NotifierState,Settings,SuccessResponse} from '../src/shared/protocol.js';
const engine={installed:true,path:'/stub/x',version:'1',loggedIn:true,authMethod:'subscription' as const};
function panel(notifier:NotifierState|undefined,stored:Settings={theme:'graphite'}){
 const requests:RequestBody[]=[];let settings={...stored};
 const p=new CredentialsPanel('settings',{changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{},
  request:async body=>{requests.push(body);const result:SuccessResponse={id:randomUUID(),ok:true};
   if(body.kind==='keys.list')result.keys=[];
   if(body.kind==='engines.status'){result.engines={claudeCode:engine,codex:engine};if(notifier)result.notifier=notifier;}
   if(body.kind==='settings.get')result.settings=settings;
   if(body.kind==='settings.set'){settings={...settings,...body.patch};result.settings=settings;}
   return validateSuccess(result);}});
 return {p,requests};
}
it('notifications is a stored on/off setting, on unless turned off',async()=>{
 expect(validateSettingsPatch({notifications:false},true)).toEqual({notifications:false});
 for(const bad of ['off',0,null])expect(()=>validateSettingsPatch({notifications:bad},true)).toThrow();
 expect(validateSettings({theme:'graphite',notifications:true}).notifications).toBe(true);
 const root=await mkdtemp('/tmp/ai-notify-setting-');
 try{const store=new SettingsStore(root);expect((await store.get()).notifications).toBeUndefined();await store.set({notifications:false});expect((await store.get()).notifications).toBe(false);await store.set({theme:'slate'});expect(await store.get()).toEqual({theme:'slate',notifications:false});}
 finally{await rm(root,{recursive:true,force:true});}
});
it('/settings shows notifications on, n or Enter on its row turns it off and on, and saves it',async()=>{
 const {p,requests}=panel('ready');await p.load();
 expect(p.lines()).toContain('  notifications: on · permission unknown (n)');expect(p.lines().join('\n')).not.toContain('unavailable');
 await p.key('n');expect(requests.filter(r=>r.kind==='settings.set').at(-1)).toMatchObject({patch:{notifications:false}});expect(p.lines()).toContain('  notifications: off (n)');
 for(let i=0;i<8;i++)await p.key('down');expect(p.lines()).toContain('› notifications: off (n)');
 await p.key('enter');expect(requests.filter(r=>r.kind==='settings.set').at(-1)).toMatchObject({patch:{notifications:true}});expect(p.lines()).toContain('› notifications: on · permission unknown (n)');
});
it('/settings says why notifications are unavailable, with fixed text only',async()=>{
 const missing=panel('not built');await missing.p.load();expect(missing.p.lines()).toContain('notifications unavailable: helper not built · run npm run build:notifier');
 const failed=panel('launch failed',{theme:'graphite',notifications:false});await failed.p.load();
 expect(failed.p.lines()).toContain('  notifications: off (n)');expect(failed.p.lines()).toContain('notifications unavailable: helper failed to launch');
 expect(()=>validateSuccess({id:randomUUID(),ok:true,notifier:'AITERMCANARY'})).toThrow();
});

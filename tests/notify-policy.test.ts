import {expect,it} from 'vitest';
import {notificationFor,notificationBody} from '../src/daemon/notify-policy.js';
import type {Status} from '../src/shared/protocol.js';
const s=(status:Status,statusDetail:string=status)=>({status,statusDetail});
const running=s('running');
it.each([
 ['permission',s('waiting','permission'),{kind:'waiting',reason:'permission'}],
 ['a question',s('waiting','question'),{kind:'waiting',reason:'question'}],
 ['a failed turn',s('waiting','turn failed: rate_limit'),{kind:'waiting',reason:'turn failed'}],
] as const)('into waiting for %s always notifies, attached or not',(_name,next,alert)=>{
 for(const attached of [false,true])expect(notificationFor(running,next,attached,true)).toEqual(alert);
 expect(notificationFor(s('done'),next,true,true)).toEqual(alert);
});
it('into done notifies only when no client is attached to that agent',()=>{
 expect(notificationFor(running,s('done'),false,true)).toEqual({kind:'done'});
 expect(notificationFor(running,s('done'),true,true)).toBeNull();
 expect(notificationFor(s('waiting','permission'),s('done'),false,true)).toEqual({kind:'done'});
});
it('starting, running, exited and failed exits never notify',()=>{
 for(const next of [s('starting'),running,s('exited','exit 0'),s('error','exit 1')])for(const attached of [false,true])
  for(const previous of [s('starting'),running,s('waiting','permission'),s('done')])expect(notificationFor(previous,next,attached,true)).toBeNull();
});
it('one notification per transition: the same status and reason again is not a new one, a new reason is',()=>{
 expect(notificationFor(s('waiting','permission'),s('waiting','permission'),false,true)).toBeNull();
 expect(notificationFor(s('done'),s('done'),false,true)).toBeNull();
 expect(notificationFor(s('waiting','permission'),s('waiting','question'),false,true)).toEqual({kind:'waiting',reason:'question'});
 // Leaving and coming back is a new transition.
 expect(notificationFor(running,s('waiting','permission'),false,true)).toEqual({kind:'waiting',reason:'permission'});
});
it('nothing at all when the setting is off',()=>{
 for(const next of [s('waiting','permission'),s('waiting','question'),s('waiting','turn failed: x'),s('done')])for(const attached of [false,true])expect(notificationFor(running,next,attached,false)).toBeNull();
});
it('the body is the agent name and the change only, never the failure text',()=>{
 expect(notificationBody('fix-login',{kind:'waiting',reason:'permission'})).toBe('fix-login · waiting: permission');
 expect(notificationBody('fix-login',{kind:'waiting',reason:'question'})).toBe('fix-login · waiting: question');
 expect(notificationBody('fix-login',{kind:'waiting',reason:'turn failed'})).toBe('fix-login · waiting: turn failed');
 expect(notificationBody('fix-login',{kind:'waiting',reason:null})).toBe('fix-login · waiting');
 expect(notificationBody('fix-login',{kind:'done'})).toBe('fix-login · done');
});
it('the agent name is cleaned and capped so the helper never rejects it',()=>{
 expect(notificationBody('a\u0007b\u202ec\u200bd\ne\tf',{kind:'done'})).toBe('abcd e f · done');
 expect(notificationBody('  spaced   out  ',{kind:'done'})).toBe('spaced out · done');
 expect(notificationBody('\u0000\u202e',{kind:'done'})).toBe('agent · done');
 const long=notificationBody('x'.repeat(300),{kind:'waiting',reason:'turn failed'});
 expect([...long].length).toBeLessThanOrEqual(200);expect(long).toBe('x'.repeat(59)+'… · waiting: turn failed');
 const emoji=notificationBody('😀'.repeat(100),{kind:'done'});expect([...emoji.split(' · ')[0]??''].length).toBe(60);
});

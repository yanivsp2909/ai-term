import {expect,it,vi} from 'vitest';
import type {IPty} from 'node-pty';
import {PtyLifecycle} from '../app/main/pty-lifecycle.js';
function child(){
 let finish:()=>void=()=>{throw new Error('PTY was not observed');};
 const kill=vi.fn();
 const pty:Pick<IPty,'kill'|'onExit'>={kill,onExit:listener=>{finish=()=>listener({exitCode:0,signal:0});return{dispose:()=>{finish=()=>{throw new Error('PTY observer disposed');};}};}};
 return{pty,kill,exit:()=>finish()};
}
it('quit waits for every PTY, including a previously closed window, before Node cleanup',async()=>{
 const old=child(),current=child(),lifecycle=new PtyLifecycle(vi.fn());
 lifecycle.track(old.pty);lifecycle.stop(old.pty);lifecycle.track(current.pty);
 let finished=false;const done=lifecycle.finish().then(()=>{finished=true;});
 await Promise.resolve();expect(finished).toBe(false);expect(current.kill).toHaveBeenCalled();
 old.exit();await Promise.resolve();expect(finished).toBe(false);
 current.exit();await done;expect(finished).toBe(true);
});
it('forces only its tracked clients after a grace period and reports kill errors',async()=>{
 vi.useFakeTimers();
 try{
  const owned=child(),failure=vi.fn(),lifecycle=new PtyLifecycle(failure);
  owned.kill.mockImplementationOnce(()=>{throw new Error('kill failed');});
  lifecycle.track(owned.pty);const done=lifecycle.finish();
  expect(failure).toHaveBeenCalledOnce();await vi.advanceTimersByTimeAsync(1000);
  expect(owned.kill).toHaveBeenLastCalledWith('SIGKILL');owned.exit();await vi.runAllTimersAsync();await done;
 }finally{vi.useRealTimers();}
});
it('defers final quit to the next loop turn even when no PTY remains',async()=>{
 const lifecycle=new PtyLifecycle(vi.fn());let finished=false;
 const done=lifecycle.finish().then(()=>{finished=true;});
 await Promise.resolve();expect(finished).toBe(false);await done;expect(finished).toBe(true);
});

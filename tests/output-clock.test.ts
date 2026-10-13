import {expect,it} from 'vitest';
import {OutputClock,OUTPUT_EVENT_MS} from '../src/daemon/output-clock.js';
function fake(){
 let now=0;const timers:{at:number;run:()=>void;id:number}[]=[];let next=1;
 return {
  now:()=>now,
  schedule:(run:()=>void,ms:number)=>{const id=next++;timers.push({at:now+ms,run,id});return id;},
  cancel:(id:unknown)=>{const i=timers.findIndex(t=>t.id===id);if(i>=0)timers.splice(i,1);},
  advance(ms:number){now+=ms;for(;;){const due=timers.filter(t=>t.at<=now).sort((a,b)=>a.at-b.at)[0];if(!due)break;timers.splice(timers.indexOf(due),1);due.run();}},
  pending:()=>timers.length,
 };
}
it('publishes the first output at once, then at most once per interval with a trailing publish of the newest output',()=>{
 const clock=fake(),published:number[]=[],output=new OutputClock(()=>published.push(clock.now()),OUTPUT_EVENT_MS,clock.now,clock.schedule,clock.cancel);
 expect(OUTPUT_EVENT_MS).toBe(5000);
 output.output();expect(published).toEqual([0]);
 clock.advance(1000);output.output();clock.advance(1000);output.output();expect(published).toEqual([0]);
 // The trailing publish carries output that arrived inside the interval, so a quiet card never starts early.
 clock.advance(3000);expect(published).toEqual([0,5000]);
 clock.advance(20000);expect(published).toEqual([0,5000]);expect(clock.pending()).toBe(0);
 output.output();expect(published).toEqual([0,5000,25000]);
});
it('an external publish (a status event) restarts the interval, and dispose cancels the trailing publish',()=>{
 const clock=fake(),published:number[]=[],output=new OutputClock(()=>published.push(clock.now()),OUTPUT_EVENT_MS,clock.now,clock.schedule,clock.cancel);
 output.sent();output.output();expect(published).toEqual([]);expect(clock.pending()).toBe(1);
 // A status event carries the newest output time, so a pending trailing publish is redundant and is dropped.
 clock.advance(2000);output.sent();expect(clock.pending()).toBe(0);clock.advance(4000);expect(published).toEqual([]);
 output.output();expect(published).toEqual([]);expect(clock.pending()).toBe(1);
 output.dispose();clock.advance(10000);expect(published).toEqual([]);
 output.output();expect(published).toEqual([]);
});

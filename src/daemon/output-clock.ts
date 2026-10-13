// The homepage shows "quiet Ns" from an agent's last output time, but output arrives many times a second. Publishing
// at most once per interval, plus one trailing publish of the newest output, keeps that time accurate to the interval
// without flooding clients. Display data only: callers never persist on these publishes.
export const OUTPUT_EVENT_MS=5000;
type Schedule=(run:()=>void,ms:number)=>unknown;
type Cancel=(timer:unknown)=>void;
const defaultSchedule:Schedule=(run,ms)=>{const timer=setTimeout(run,ms);timer.unref();return timer;};
const defaultCancel:Cancel=timer=>{clearTimeout(timer as ReturnType<typeof setTimeout>);};
export class OutputClock {
 private last=-Infinity;
 private timer:unknown;
 private disposed=false;
 constructor(private readonly publish:()=>void,private readonly interval=OUTPUT_EVENT_MS,private readonly now:()=>number=Date.now,private readonly schedule:Schedule=defaultSchedule,private readonly cancel:Cancel=defaultCancel){}
 output():void{
  if(this.disposed)return;const now=this.now();
  if(now-this.last>=this.interval&&this.timer===undefined){this.last=now;this.publish();return;}
  this.timer??=this.schedule(()=>{this.timer=undefined;if(this.disposed)return;this.last=this.now();this.publish();},Math.max(0,this.last+this.interval-now));
 }
 // A status event already carried the newest output time: the interval restarts from it and a pending trailing publish is redundant.
 sent():void{this.last=this.now();if(this.timer!==undefined)this.cancel(this.timer);this.timer=undefined;}
 dispose():void{this.disposed=true;if(this.timer!==undefined)this.cancel(this.timer);this.timer=undefined;}
}

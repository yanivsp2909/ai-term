import type {IPty} from 'node-pty';
type Child=Pick<IPty,'kill'|'onExit'>;
const QUIT_DEADLINE_MS=3000;
export class PtyLifecycle {
 private readonly children=new Map<Child,Promise<void>>();
 constructor(private readonly failure:()=>void){}
 track(child:Child):void {
  let complete:(()=>void)|undefined;
  const exited=new Promise<void>(resolve=>{complete=resolve;});
  this.children.set(child,exited);
  child.onExit(()=>{this.children.delete(child);complete?.();});
 }
 stop(child:Child,signal?:string):void {
  if(!this.children.has(child))return;
  try{child.kill(signal);}catch{this.failure();}
 }
 async finish():Promise<void> {
  for(const child of this.children.keys())this.stop(child);
  // Only outer CLI clients are owned here; detached daemon agents survive.
  const force=setTimeout(()=>{for(const child of this.children.keys())this.stop(child,'SIGKILL');},1000);
  // A client that never reports its exit even after SIGKILL must not make Cmd+Q a no-op forever: report it and quit.
  let deadline:ReturnType<typeof setTimeout>|undefined;
  const stuck=new Promise<void>(resolve=>{deadline=setTimeout(()=>{this.failure();resolve();},QUIT_DEADLINE_MS);});
  try{
   await Promise.race([Promise.all(this.children.values()),stuck]);
   // node-pty's native callback must return before Electron frees its Node env.
   await new Promise<void>(resolve=>setImmediate(resolve));
  }finally{clearTimeout(force);clearTimeout(deadline);}
 }
}

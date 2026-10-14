import type {IPty} from 'node-pty';
type Child=Pick<IPty,'kill'|'onExit'>;
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
  try{
   await Promise.all(this.children.values());
   // node-pty's native callback must return before Electron frees its Node env.
   await new Promise<void>(resolve=>setImmediate(resolve));
  }finally{clearTimeout(force);}
 }
}

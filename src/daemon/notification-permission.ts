import { execFile } from 'node:child_process';
import { join } from 'node:path';
import type { NotificationAuthorization } from '../shared/protocol.js';
export type PermissionRunner=(file:string,args:readonly string[],options:{timeout:number;maxBuffer:number;env:Record<string,string>},done:(error:Error|null,stdout:string)=>void)=>void;
const run:PermissionRunner=(file,args,options,done)=>{execFile(file,[...args],options,(error,stdout)=>done(error,stdout));};
const words:readonly string[]=['allowed','denied','not-asked','unknown'];
// Verified on Yaniv's Mac: direct --status and open -W -n -g --stdout --args --status
// both returned denied, exit 0, from the signed bundle at its fixed path (2026-10-13).
export const DIRECT_PERMISSION_VERIFIED=true;
export class NotificationPermission {
 private cached:NotificationAuthorization='unknown';
 private checked=-Infinity;
 private pending:Promise<NotificationAuthorization>|undefined;
 private timer:ReturnType<typeof setInterval>|undefined;
 constructor(private readonly app:string|null,private readonly log:(text:string)=>void,private readonly runner:PermissionRunner=run,private readonly now:()=>number=Date.now,private readonly verified=DIRECT_PERMISSION_VERIFIED){}
 value():NotificationAuthorization{return this.cached;}
 start():void{void this.refresh();this.timer??=setInterval(()=>{void this.refresh();},60_000);this.timer.unref();}
 close():void{if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 refresh():Promise<NotificationAuthorization>{
  if(this.pending)return this.pending;
  if(this.now()-this.checked<60_000)return Promise.resolve(this.cached);
  this.checked=this.now();
  const operation=new Promise<NotificationAuthorization>(resolve=>{
   if(!this.app){resolve('unknown');return;}
   try{this.runner(join(this.app,'Contents/MacOS/AITermNotifier'),['--status'],{timeout:3000,maxBuffer:128,env:{PATH:'/usr/bin:/bin'}},(error,stdout)=>{
    if(error){this.log('Notification permission check failed');resolve('unknown');return;}
    const word=stdout.endsWith('\n')?stdout.slice(0,-1):stdout;
    resolve(this.verified&&words.includes(word)?word as NotificationAuthorization:'unknown');
   });}catch{this.log('Notification permission check failed');resolve('unknown');}
  });
  this.pending=operation.then(value=>{this.cached=value;this.pending=undefined;return value;});return this.pending;
 }
}

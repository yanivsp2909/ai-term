import headless from '@xterm/headless';
import { performance } from 'node:perf_hooks';
import { useUnicode11 } from '../shared/unicode-width.js';
import { BodyRenderer } from './mirror-render.js';
import { installPassthrough,type OuterFacts,type Passthrough } from './passthrough.js';
export class SessionScreen {
 readonly terminal:headless.Terminal;
 readonly passthrough:Passthrough;
 private readonly renderer:BodyRenderer;
 private frameTimer:ReturnType<typeof setTimeout>|undefined;
 private syncExpired=false;
 private syncTimer:ReturnType<typeof setTimeout>|undefined;
 private lastFrame=-Infinity;
 private blocked=false;
 private dirty=false;
 private disposed=false;
 private full=true;
 private barPrevious='';
 private queuedBytes=0;
 constructor(cols:number,rows:number,facts:OuterFacts,private readonly out:(data:string)=>boolean|void,reply:(data:string)=>void,private readonly bar:()=>string,private readonly failed:(error:Error)=>void){
  this.terminal=new headless.Terminal({cols,rows,scrollback:0,allowProposedApi:true,windowOptions:{getWinSizeChars:true,pushTitle:true,popTitle:true}});useUnicode11(this.terminal);
  this.passthrough=installPassthrough(this.terminal,facts,data=>this.send(data),reply);
  this.terminal.onData(reply);this.renderer=new BodyRenderer(this.terminal,1);
 }
 private send(data:string):void{if(data&&this.out(data)===false)this.blocked=true;}
 write(data:string|Buffer):Promise<void>{
  if(this.disposed)return Promise.resolve();const bytes=Buffer.byteLength(data);
  if(this.queuedBytes+bytes>8*1024*1024)return Promise.reject(new Error('Session screen queue exceeded'));
  this.queuedBytes+=bytes;
  return new Promise(resolve=>this.terminal.write(data,()=>{this.queuedBytes-=bytes;this.changed();resolve();}));
 }
 input():void{this.terminal.input('',true);}
 changed():void{this.dirty=true;this.request();}
 drain():void{this.blocked=false;this.request();}
 resize(cols:number,rows:number):void{this.terminal.resize(cols,rows);this.renderer.invalidate();this.full=true;this.changed();}
 private request(expired=false):void{
  if(this.disposed||this.blocked||this.frameTimer||!this.dirty)return;
  if(this.terminal.modes.synchronizedOutputMode&&!expired){this.syncTimer??=setTimeout(()=>{this.syncTimer=undefined;this.syncExpired=true;this.request(true);},150);return;}
  if(this.syncTimer){clearTimeout(this.syncTimer);this.syncTimer=undefined;}
  const wait=8-(performance.now()-this.lastFrame);
  if(wait>0)this.frameTimer=setTimeout(()=>{this.frameTimer=undefined;this.draw();},wait);else this.draw();
 }
 private draw():void{
  if(this.disposed||this.blocked)return;
  if(this.terminal.modes.synchronizedOutputMode&&!this.syncExpired){this.request();return;}
  this.syncExpired=false;
  try{
   this.dirty=false;this.renderer.cursorVisible=this.passthrough.cursorVisible();
   const bar=this.bar();let output=this.full?'\x1b[0m\x1b[H\x1b[2J':'';
   const barChanged=this.full||bar!==this.barPrevious;
   if(barChanged){output+=bar;this.barPrevious=bar;}
   this.full=false;output+=this.renderer.frame(barChanged);
   if(output)this.send('\x1b[?2026h'+output+'\x1b[?2026l');
   this.lastFrame=performance.now();
  }catch(error){this.failed(error instanceof Error?error:new Error('Session render failed'));}
 }
 dispose():void{this.disposed=true;if(this.frameTimer)clearTimeout(this.frameTimer);if(this.syncTimer)clearTimeout(this.syncTimer);this.terminal.dispose();}
}

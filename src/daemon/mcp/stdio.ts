import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JSONRPCMessage, MCPTransport } from '@ai-sdk/mcp';
import { MCP_MESSAGE_BYTES } from '../../shared/mcp.js';
import { killGroup } from '../../shared/kill-tree.js';
import { windowsTestCommand } from '../win-launch.js';

export function mcpMessage(value:unknown):JSONRPCMessage{
 if(!value||typeof value!=='object'||Array.isArray(value)||!('jsonrpc'in value)||value.jsonrpc!=='2.0'||!('method'in value)&&!('result'in value)&&!('error'in value))throw new Error('MCP transport failed');return value as JSONRPCMessage;
}
// SDK stdio inherits ambient variables and stderr. This transport never does, and owns the whole process group.
export class McpStdio implements MCPTransport {
 private child?:ChildProcessWithoutNullStreams;private group?:number;private buffer=Buffer.alloc(0);private closed=false;
 onclose?:()=>void;onerror?:(error:Error)=>void;onmessage?:(message:JSONRPCMessage)=>void;
 constructor(private command:string,private args:string[],private cwd:string,private env:Record<string,string>){}
 // Windows (v0.8.2): npx and uvx are .cmd launchers Node won't spawn; npm's is read and run with node (win-launch.ts),
 // anything else of that kind is refused rather than handed to cmd.exe.
 async start():Promise<void>{
  const [command,...args]=process.platform==='win32'?await windowsTestCommand([this.command,...this.args],this.env.PATH??this.env.Path??''):[this.command,...this.args];
  return this.launch(command??this.command,args);
 }
 private launch(command:string,args:string[]):Promise<void>{return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd:this.cwd,env:this.env,detached:true,windowsHide:true,stdio:['pipe','pipe','pipe']});this.child=child;this.group=child.pid;
  child.stderr.resume();child.once('spawn',()=>{this.group=child.pid;if(this.closed)void this.close();resolve();});child.on('error',()=>{reject(new Error('MCP transport failed'));this.fail();});child.once('close',()=>{if(!this.closed)void this.close();});
  child.stdin.on('error',()=>this.fail());child.stdout.on('error',()=>this.fail());
  child.stdout.on('data',(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>MCP_MESSAGE_BYTES){this.fail();return;}
   let messages=0,index:number;while((index=this.buffer.indexOf(10))>=0){if(++messages>128){this.fail();return;}const line=this.buffer.subarray(0,index);this.buffer=this.buffer.subarray(index+1);
    try{this.onmessage?.(mcpMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)) as unknown));}catch{this.fail();return;}
   }
  });
 });}
 private fail():void{this.onerror?.(new Error('MCP transport failed'));void this.close();}
 send(message:JSONRPCMessage):Promise<void>{const child=this.child;if(!child||this.closed)return Promise.reject(new Error('MCP transport failed'));return new Promise((resolve,reject)=>{child.stdin.write(JSON.stringify(message)+'\n',error=>error?reject(new Error('MCP transport failed')):resolve());});}
 async close():Promise<void>{const wasClosed=this.closed;this.closed=true;const child=this.child;this.child=undefined;this.buffer=Buffer.alloc(0);this.env={};
  if(this.group){try{killGroup(this.group,'SIGKILL',()=>this.onerror?.(new Error('MCP stop failed')));}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ESRCH'))this.onerror?.(new Error('MCP stop failed'));}this.group=undefined;}child?.stdin.destroy();child?.stdout.destroy();child?.stderr.destroy();
  if(!wasClosed)this.onclose?.();
 }
}

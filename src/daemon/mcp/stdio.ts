import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { JSONRPCMessage, MCPTransport } from '@ai-sdk/mcp';
import { MCP_MESSAGE_BYTES } from '../../shared/mcp.js';

export function mcpMessage(value:unknown):JSONRPCMessage{
 if(!value||typeof value!=='object'||Array.isArray(value)||!('jsonrpc'in value)||value.jsonrpc!=='2.0'||!('method'in value)&&!('result'in value)&&!('error'in value))throw new Error('MCP transport failed');return value as JSONRPCMessage;
}
// SDK stdio inherits ambient variables and stderr. This transport never does, and owns the whole process group.
export class McpStdio implements MCPTransport {
 private child?:ChildProcessWithoutNullStreams;private group?:number;private buffer=Buffer.alloc(0);private closed=false;
 onclose?:()=>void;onerror?:(error:Error)=>void;onmessage?:(message:JSONRPCMessage)=>void;
 constructor(private command:string,private args:string[],private cwd:string,private env:Record<string,string>){}
 start():Promise<void>{return new Promise((resolve,reject)=>{
  const child=spawn(this.command,this.args,{cwd:this.cwd,env:this.env,detached:true,stdio:['pipe','pipe','pipe']});this.child=child;
  child.stderr.resume();child.once('spawn',()=>{this.group=child.pid;resolve();});child.on('error',()=>{reject(new Error('MCP transport failed'));this.fail();});child.once('close',()=>{if(!this.closed)void this.close();});
  child.stdin.on('error',()=>this.fail());child.stdout.on('error',()=>this.fail());
  child.stdout.on('data',(chunk:Buffer)=>{this.buffer=Buffer.concat([this.buffer,chunk]);if(this.buffer.length>MCP_MESSAGE_BYTES){this.fail();return;}
   let messages=0,index:number;while((index=this.buffer.indexOf(10))>=0){if(++messages>128){this.fail();return;}const line=this.buffer.subarray(0,index);this.buffer=this.buffer.subarray(index+1);
    try{this.onmessage?.(mcpMessage(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(line)) as unknown));}catch{this.fail();return;}
   }
  });
 });}
 private fail():void{this.onerror?.(new Error('MCP transport failed'));void this.close();}
 send(message:JSONRPCMessage):Promise<void>{const child=this.child;if(!child||this.closed)return Promise.reject(new Error('MCP transport failed'));return new Promise((resolve,reject)=>{child.stdin.write(JSON.stringify(message)+'\n',error=>error?reject(new Error('MCP transport failed')):resolve());});}
 async close():Promise<void>{if(this.closed)return;this.closed=true;const child=this.child;this.child=undefined;this.buffer=Buffer.alloc(0);this.env={};
  if(this.group){try{process.kill(-this.group,'SIGKILL');}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ESRCH'))this.onerror?.(new Error('MCP stop failed'));}this.group=undefined;}child?.stdin.destroy();child?.stdout.destroy();child?.stderr.destroy();
  this.onclose?.();
 }
}

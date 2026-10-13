import {expect,it} from 'vitest';
import {Readable} from 'node:stream';
import {request} from 'node:http';
import {createServer} from 'node:http';
import {statusLine} from '../src/cli/status-line.js';
it('status-line prints safe model/context and sends only numeric context with env token',async()=>{
 const calls:unknown[]=[],server=createServer((req,res)=>{let body='';req.on('data',d=>{body+=String(d);});req.on('end',()=>{calls.push({url:req.url,token:req.headers['x-ai-term-session'],body:JSON.parse(body)});res.writeHead(204);res.end();});});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture');const output:string[]=[];
 try{await statusLine({input:Readable.from([JSON.stringify({model:{id:'claude-sonnet-4-6',display_name:'Sonnet AITERMCANARY'},context_window:{used_percentage:12.7},tool_input:'AITERMCANARY'})]),env:{AITERM_STATUS_TOKEN:'a'.repeat(64),AITERM_STATUS_PORT:String(address.port)},write:text=>output.push(text)});expect(output).toEqual(['claude-sonnet-4-6 · ctx 13%\n']);expect(calls).toEqual([{url:'/v1/status/claude',token:'a'.repeat(64),body:{hook_event_name:'AITermContext',used_percentage:12.7}}]);}finally{await new Promise<void>(r=>server.close(()=>r()));}
});
it('status-line safely handles malformed/oversize input, unsafe model and unavailable endpoint',async()=>{
 for(const text of ['{AITERMCANARY','x'.repeat(1024*1024+1),JSON.stringify({model:{id:'\x1bAITERMCANARY'},context_window:{used_percentage:101}})]){
  const output:string[]=[];await statusLine({input:Readable.from([text]),env:{},write:t=>output.push(t)});expect(output).toEqual(['Claude · ctx ?\n']);
 }
 const output:string[]=[];await statusLine({input:Readable.from(['{"model":{"id":"sonnet"},"context_window":{"used_percentage":0}}']),env:{AITERM_STATUS_TOKEN:'bad',AITERM_STATUS_PORT:'123'},write:t=>output.push(t)});expect(output).toEqual(['sonnet · ctx 0%\n']);
});

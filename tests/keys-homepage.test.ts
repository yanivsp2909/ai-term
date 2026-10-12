import {expect,it} from 'vitest';
import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import {Homepage} from '../src/client/tui/homepage.js';
import headless from '@xterm/headless';
import type {RequestBody} from '../src/client/connection.js';
class TTY extends EventEmitter{isTTY=true;isRaw=false;columns=130;rows=45;output='';setRawMode(v:boolean){this.isRaw=v;}pause(){}resume(){}write(v:string|Buffer){this.output+=v.toString();return true;}}
it('first run opens login and routes masked input away from the command bar',async()=>{
 const tty=new TTY(),client=new EventEmitter() as EventEmitter&{request:(body:RequestBody)=>Promise<unknown>};client.request=async body=>({id:randomUUID(),ok:true,...(body.kind==='settings.get'?{settings:{theme:'graphite'}}:body.kind==='sessions.list'?{sessions:[]}:body.kind==='keys.list'?{keys:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:false,authMethod:'unknown'},codex:{installed:false,path:null,version:null,loggedIn:null,authMethod:'unknown'}}}:{snapshot:'',cols:88,rows:27})});
 const home=new Homepage(client as never,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});const terminal=new headless.Terminal({cols:130,rows:45,allowProposedApi:true});
 try{await home.start();await new Promise<void>(r=>terminal.write(tty.output,r));const screen=Array.from({length:45},(_,y)=>terminal.buffer.active.getLine(y)?.translateToString()??'').join('\n');expect(screen).toContain('Connect a provider');expect(screen).toContain('Microsoft Foundry');}finally{await home.stop();terminal.dispose();}
});
it('key model choices only offer successful Foundry deployments with masked metadata',async()=>{
 const {modelChoices}=await import('../src/shared/models.js');const id=randomUUID();const choices=modelChoices([{id,provider:'foundry',label:'Azure',last4:'0000',endpoint:'https://narvis-resource.openai.azure.com/openai/v1',deployments:['ready','bad'],lastTest:[{model:'ready',status:'ready'},{model:'bad',status:'error'}]}]);expect(choices.some(c=>c.model==='bad')).toBe(false);expect(choices.find(c=>c.model==='ready')).toMatchObject({auth:{kind:'key',keyId:id},group:'FOUNDRY · narvis-resource'});
});
it('Enter and key paste in one read advance to masked field before processing the paste',async()=>{
 const tty=new TTY(),client=new EventEmitter() as EventEmitter&{request:(body:RequestBody)=>Promise<unknown>};client.request=async body=>({id:randomUUID(),ok:true,...(body.kind==='settings.get'?{settings:{theme:'graphite'}}:body.kind==='sessions.list'?{sessions:[]}:body.kind==='keys.list'?{keys:[]}:body.kind==='engines.status'?{engines:{claudeCode:{installed:false,path:null,version:null,loggedIn:false,authMethod:'unknown'},codex:{installed:false,path:null,version:null,loggedIn:false,authMethod:'unknown'}}}:{snapshot:'',cols:88,rows:27})});
 const home=new Homepage(client as never,{stdin:tty,stdout:tty,signals:new EventEmitter(),cwd:'/tmp'});
 try{await home.start();tty.emit('data',Buffer.from('\r\x1b[B\r'));await new Promise(r=>setTimeout(r,30));const before=tty.output.length;tty.emit('data',Buffer.from('\r\x1b[200~sk-ant-AITERMCANARY0000\x1b[201~'));await new Promise(r=>setTimeout(r,30));expect(tty.output.slice(before)).not.toContain('AITERMCANARY');expect(tty.output.slice(before)).toContain('•');}finally{await home.stop();}
});

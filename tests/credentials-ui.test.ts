import { expect,it } from 'vitest';
import { CredentialsPanel } from '../src/client/tui/credentials.js';
import type { RequestBody } from '../src/client/connection.js';
import { randomUUID } from 'node:crypto';
const secret='sk-ant-'+'AITERMCANARY0000';
it('masked key entry clears the client secret before sending and shows metadata-only success',async()=>{
 const requests:RequestBody[]=[];
 const panel=new CredentialsPanel('login',{request:async body=>{requests.push(body);if(body.kind==='keys.add'){expect(panel.containsSecret()).toBe(false);return {id:randomUUID(),ok:true,key:{id:randomUUID(),provider:body.provider,label:body.label,last4:'0000'}};}return {id:randomUUID(),ok:true,keys:[]};},changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});
 await panel.key('enter');await panel.key('down');await panel.key('enter'); // Anthropic API key
 await panel.key('enter'); // label
 panel.paste(secret);expect(panel.lines().join('\n')).not.toContain(secret);expect(panel.containsSecret()).toBe(true);
 await panel.key('enter');expect(panel.containsSecret()).toBe(false);expect(panel.lines().join('\n')).toContain('saved to the OS keychain');expect(requests.filter(r=>r.kind==='keys.add')).toHaveLength(1);
});
it('settings has keys engines defaults and imports names only',async()=>{
 const panel=new CredentialsPanel('settings',{request:async body=>({id:randomUUID(),ok:true,...(body.kind==='keys.list'?{keys:[]}:{found:[{name:'ANTHROPIC_API_KEY',provider:'anthropic'}]})}),changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});await panel.load();const text=panel.lines().join('\n');for(const label of ['KEYS','ENGINES','DEFAULTS','keys are never shown in full'])expect(text).toContain(label);
 await panel.key('i');panel.paste('/tmp/input.env');await panel.key('enter');expect(panel.lines().join('\n')).toContain('ANTHROPIC_API_KEY');
});
it('cancelling clears secret and validation refuses oversized secret without truncating it into another key',async()=>{
 const requests:RequestBody[]=[];const panel=new CredentialsPanel('login',{request:async body=>{requests.push(body);return {id:randomUUID(),ok:true};},changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});
 await panel.key('enter');await panel.key('down');await panel.key('enter');await panel.key('enter');panel.paste('x'.repeat(513));await panel.key('enter');expect(requests).toEqual([]);await panel.key('escape');expect(panel.containsSecret()).toBe(false);
});
it('settings shows actual defaults and provides separate model and folder controls',async()=>{
 const defaults:string[]=[];const panel=new CredentialsPanel('settings',{request:async body=>({id:randomUUID(),ok:true,...(body.kind==='settings.get'?{settings:{theme:'slate',defaultEngine:'codex',defaultModel:'gpt-6.1-sol',defaultCwd:'/tmp/project',permission:'ask'}}:body.kind==='keys.list'?{keys:[]}:{})}),changed:()=>{},close:()=>{},login:async()=>{},defaults:kind=>{defaults.push(kind);},theme:async()=>{}});
 await panel.load();expect(panel.lines().join('\n')).toContain('gpt-6.1-sol');expect(panel.lines().join('\n')).toContain('/tmp/project');await panel.key('d');await panel.key('f');expect(defaults).toEqual(['model','folder']);
});
it('queued input after disposal cannot restore a cancelled secret',async()=>{
 const panel=new CredentialsPanel('login',{request:async()=>({id:randomUUID(),ok:true}),changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});await panel.key('enter');await panel.key('down');await panel.key('enter');await panel.key('enter');panel.dispose();await panel.key('s');panel.paste(secret);expect(panel.containsSecret()).toBe(false);
});
it('settings keeps its selected key and defaults visible with many saved keys',async()=>{
 const keys=Array.from({length:20},(_,i)=>({id:randomUUID(),provider:'anthropic' as const,label:'key-'+i,last4:'0000'}));
 const panel=new CredentialsPanel('settings',{request:async body=>({id:randomUUID(),ok:true,...(body.kind==='keys.list'?{keys}:body.kind==='settings.get'?{settings:{theme:'graphite'}}:{})}),changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});await panel.load();for(let i=0;i<19;i++)await panel.key('down');const lines=panel.lines();
 // v0.4.1-v0.4.2 add the keys-run-on, caps and context-warning rows; the popup scrolls to the selected row, so a short
 // terminal still shows it.
 expect(lines.length).toBeLessThan(33); // v0.6.1 cost per task, v0.6.2 presets, v0.6.3 handoff, v0.7.2 checkpoints, v0.7.3 secret scan, v0.7.4 auto-test and auto-review rows, v0.9.1 queue
 const {Grid,plainText}=await import('../src/client/tui/grid.js'),{createTheme}=await import('../src/client/tui/theme.js');
 expect(plainText(panel.draw(new Grid(100,24,createTheme('graphite')).cells,createTheme('graphite')))).toContain('› key-19');expect(lines.join('\n')).toContain('› key-19');expect(lines.join('\n')).toContain('DEFAULTS');
});
it('settings arrows and Enter reach action and defaults rows without letter shortcuts',async()=>{
 const defaults:string[]=[];let closed=false;const panel=new CredentialsPanel('settings',{request:async body=>({id:randomUUID(),ok:true,...(body.kind==='keys.list'?{keys:[]}:body.kind==='settings.get'?{settings:{theme:'graphite'}}:{})}),changed:()=>{},close:()=>{closed=true;},login:async()=>{},defaults:kind=>{defaults.push(kind);},theme:async()=>{}});
 await panel.load();await panel.key('down');await panel.key('down');await panel.key('down');await panel.key('enter');expect(defaults).toEqual(['model']);await panel.key('escape');expect(closed).toBe(true);
});
it('login method rows identify the CLI-owned auth without calling it account',async()=>{
 const panel=new CredentialsPanel('login',{request:async body=>({id:randomUUID(),ok:true,...(body.kind==='keys.list'?{keys:[]}:body.kind==='settings.get'?{settings:{theme:'graphite'}}:{engines:{claudeCode:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/stub',version:'1',loggedIn:true,authMethod:'api-key'}}})}),changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});
 await panel.load();await panel.key('down');await panel.key('enter');expect(panel.lines().join('\n')).toContain('own login · API key');expect(panel.lines().join('\n')).not.toContain('ChatGPT account');
});

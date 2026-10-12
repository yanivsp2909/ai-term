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

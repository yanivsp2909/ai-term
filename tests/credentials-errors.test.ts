import {expect,it} from 'vitest';
import {randomUUID} from 'node:crypto';
import {CredentialsPanel} from '../src/client/tui/credentials.js';
import {DaemonRequestError,type RequestBody} from '../src/client/connection.js';
import type {SuccessResponse} from '../src/shared/protocol.js';
type Handler=(body:RequestBody)=>Partial<SuccessResponse>|Error;
function panel(kind:'login'|'settings',handle:Handler){const requests:RequestBody[]=[];const p=new CredentialsPanel(kind,{request:async body=>{requests.push(body);const r=handle(body);if(r instanceof Error)throw r;return {id:randomUUID(),ok:true,...r} as SuccessResponse;},changed:()=>{},close:()=>{},login:async()=>{},defaults:()=>{},theme:async()=>{}});return {p,requests,text:()=>p.lines().join('\n')};}
const key=(id=randomUUID())=>({id,provider:'foundry' as const,label:'Foundry',last4:'0000',endpoint:'https://x.openai.azure.com/openai/v1',deployments:['gpt']});
async function foundryForm(p:CredentialsPanel){await p.key('down');await p.key('down');await p.key('enter');await p.key('enter');p.paste('https://x.openai.azure.com/openai/v1');await p.key('enter');p.paste('k'.repeat(32));await p.key('enter');p.paste('gpt');await p.key('enter');}
it('a saved key whose follow-up test fails still says it was saved, so nobody saves it twice',async()=>{
 const {p,text}=panel('login',body=>body.kind==='keys.add'?{key:key()}:body.kind==='keys.test'?new DaemonRequestError('Key operation timed out'):{keys:[]});
 await foundryForm(p);expect(text()).toContain('✓ saved to the OS keychain');expect(text()).toContain('test failed');expect(text()).not.toContain('could not be saved');
});
it('a refused save shows the daemon reason, including an orphaned Keychain entry',async()=>{
 const reason='Key metadata failed and keychain cleanup failed; remove the new test entry in Keychain Access';
 const {p,text}=panel('login',body=>body.kind==='keys.add'?new DaemonRequestError(reason):{keys:[]});
 await foundryForm(p);expect(text()).toContain(reason);
});
it('a removed key whose list refresh fails is reported removed and leaves the list',async()=>{
 const k=key();let removed=false;
 const {p,text}=panel('settings',body=>body.kind==='keys.list'?(removed?new DaemonRequestError('OS keychain unavailable'):{keys:[k]}):body.kind==='keys.remove'?(removed=true,{}):body.kind==='engines.status'?{engines:{claudeCode:{installed:true,path:'/x',version:'1',loggedIn:true,authMethod:'subscription'},codex:{installed:true,path:'/y',version:'1',loggedIn:true,authMethod:'subscription'}}}:{settings:{theme:'graphite' as const}});
 await p.load();expect(text()).toContain('key ····0000');await p.key('x');expect(text()).toContain('Key removed from the OS keychain');expect(text()).not.toContain('key ····0000');
});
it('a failed import shows the daemon reason',async()=>{
 const {p,text}=panel('settings',body=>body.kind==='keys.scanEnvFile'?{found:[{name:'ANTHROPIC_API_KEY',provider:'anthropic'}]}:body.kind==='keys.importEnv'?new DaemonRequestError('OS keychain unavailable; key was not saved'):{keys:[]});
 await p.key('i');p.paste('/tmp/x.env');await p.key('enter');await p.key('enter');expect(text()).toContain('OS keychain unavailable; key was not saved');
});
it('engine status failure does not claim the engines are missing, and keys still load',async()=>{
 const {p,text}=panel('settings',body=>body.kind==='engines.status'?new DaemonRequestError('Engine login status unavailable'):body.kind==='keys.list'?{keys:[key()]}:{settings:{theme:'graphite' as const}});
 await p.load();expect(text()).toContain('key ····0000');expect(text()).not.toContain('✗ not installed');expect(text()).toContain('status unavailable');
});

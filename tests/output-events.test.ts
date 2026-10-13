import {afterEach,expect,it} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {getPaths,preparePaths} from '../src/shared/paths.js';
import {Logger} from '../src/daemon/log.js';
import {SessionManager} from '../src/daemon/session-manager.js';
import {atomicWrite} from '../src/daemon/store.js';
import type {SessionEvent} from '../src/shared/protocol.js';
const cleanup:(()=>Promise<void>)[]=[];
afterEach(async()=>{for(const step of cleanup.splice(0).reverse())await step();});
it('output keeps lastOutputAt fresh for the homepage through throttled, unsaved session events',async()=>{
 const root=await mkdtemp(join(tmpdir(),'ai-term-output-'));cleanup.push(()=>rm(root,{recursive:true,force:true}));const paths=getPaths(root);await preparePaths(paths);
 let writes=0;const writer:typeof atomicWrite=async(file,data)=>{writes++;await atomicWrite(file,data);};
 // First output at once, a second burst shortly after, then silence: the trailing event must carry the second burst's time.
 const m=new SessionManager(paths,new Logger(paths.log),{executable:'/bin/sh',args:['-c','printf one; sleep 0.4; printf two; sleep 30'],env:{PATH:'/usr/bin:/bin'}},undefined,writer);cleanup.push(()=>m.shutdown());await m.load();
 const events:SessionEvent[]=[];m.on('event',(event:SessionEvent)=>events.push(event));
 const session=await m.create({cwd:root});
 await expect.poll(()=>m.get(session.id).status).toBe('running');
 const updates=()=>events.flatMap(e=>e.kind==='session.updated'&&e.session.id===session.id&&e.session.status==='running'?[e.session.lastOutputAt]:[]);
 // create() and the starting→running promotion may both report the first output; count from there.
 await new Promise(r=>setTimeout(r,150));const base=updates().length,first=updates().at(-1);expect(base).toBeGreaterThan(0);
 await new Promise(r=>setTimeout(r,600));expect(updates()).toHaveLength(base);const savedWrites=writes;
 await expect.poll(()=>updates().length,{timeout:6000}).toBe(base+1);
 expect(Date.parse(updates().at(-1)??'')).toBeGreaterThan(Date.parse(first??''));expect(m.get(session.id).lastOutputAt).toBe(updates().at(-1));
 // Output timing is display data only: it never causes a state write.
 expect(writes).toBe(savedWrites);
},12000);

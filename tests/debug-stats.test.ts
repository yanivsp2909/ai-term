import { expect,it } from 'vitest';
import { parseMemoryParts, parseTopCpu } from '../src/daemon/sysstats.js';
import { debugStats } from '../src/cli/debug-stats.js';
const vm=`Mach Virtual Memory Statistics: (page size of 16384 bytes)
Anonymous pages: 100000.
Pages purgeable: 65536.
Pages wired down: 200000.
Pages occupied by compressor: 300000.
File-backed pages: 40000.
Pages free: 50000.
`;
it('memory diagnostics expose both candidate totals and all numeric parts',()=>{
 expect(parseMemoryParts(vm)).toEqual({anonymousBytes:100000*16384,purgeableBytes:65536*16384,appBytes:(100000-65536)*16384,wiredBytes:200000*16384,compressedBytes:300000*16384,cachedBytes:40000*16384,freeBytes:50000*16384,appWiredCompressedBytes:(600000-65536)*16384,anonymousWiredCompressedBytes:600000*16384});
 expect(parseMemoryParts(vm.replace('100000.','1e5.'))).toBeNull();expect(parseMemoryParts(vm.replace(/Pages free:.*\n/,''))).toBeNull();
});
it('top parser keeps only the last valid numeric CPU usage line, never names or commands',()=>{
 const top='Processes: PRIVATE\nCPU usage: 2.0% user, 3.0% sys, 95.0% idle\nPID COMMAND PRIVATE\nCPU usage: 12.3% user, 4.5% sys, 83.2% idle\n';
 expect(parseTopCpu(top)).toEqual({userPercent:12.3,systemPercent:4.5,idlePercent:83.2,busyPercent:16.8});
 expect(parseTopCpu('CPU usage: NaN% user, 3% sys, 97% idle')).toBeNull();expect(parseTopCpu('CPU usage: 101% user, 0% sys, 0% idle')).toBeNull();
});
it('debug stats prints ten JSON number-only samples without socket or process-list data',async()=>{
 const output:string[]=[];let samples=0;const memory=parseMemoryParts(vm);if(!memory)throw new Error('fixture');
 await debugStats({sample:async()=>{samples++;return {...memory,cpuPercent:25,top:{userPercent:20,systemPercent:5,idlePercent:75,busyPercent:25}};},write:text=>{output.push(text);}});
 expect(samples).toBe(10);expect(output).toHaveLength(10);for(const [i,line]of output.entries()){const value=JSON.parse(line);expect(value.sample).toBe(i+1);expect(Object.values(value).every(v=>typeof v==='number'&&Number.isFinite(v))).toBe(true);expect(line).not.toMatch(/PRIVATE|Processes|PID|COMMAND/);}
});
it('debug stats failures print no raw command output',async()=>{
 const output:string[]=[];await expect(debugStats({sample:async()=>{throw new Error('PRIVATE raw stderr');},write:text=>{output.push(text);}})).rejects.toThrow('Stats diagnostic failed');expect(output).toEqual([]);
});
it('diagnostic CLI reads counters without creating an AI Term home or connecting a daemon',async()=>{
 const {mkdtemp,rm,lstat}=await import('node:fs/promises');const {execFile}=await import('node:child_process');const {resolve,join}=await import('node:path');
 const root=await mkdtemp('/tmp/ai-debug-stats-'),home=join(root,'unused');
 try{const stdout=await new Promise<string>((resolveDone,reject)=>execFile(process.execPath,['--import','tsx',resolve('src/cli/index.ts'),'debug','stats'],{cwd:resolve('.'),timeout:20000,maxBuffer:65536,env:{PATH:'/usr/bin:/bin',HOME:root,AI_TERM_HOME:home}},(error,stdout)=>error?reject(new Error('Diagnostic CLI failed')):resolveDone(stdout)));
 const lines=stdout.trim().split('\n');expect(lines).toHaveLength(10);for(const line of lines)expect(Object.values(JSON.parse(line)).every(value=>typeof value==='number'&&Number.isFinite(value))).toBe(true);await expect(lstat(home)).rejects.toMatchObject({code:'ENOENT'});
 }finally{await rm(root,{recursive:true,force:true});}
},20000);
it('starts ten bounded diagnostic pairs one second apart instead of waiting for top startup each time',async()=>{
 const {vi}=await import('vitest');vi.useFakeTimers();const starts:number[]=[],output:string[]=[];const memory=parseMemoryParts(vm);if(!memory)throw new Error('fixture');
 try{const done=debugStats({sample:async()=>{starts.push(Date.now());await new Promise(r=>setTimeout(r,1500));return {...memory,cpuPercent:25,top:{userPercent:20,systemPercent:5,idlePercent:75,busyPercent:25}};},write:line=>{output.push(line);}});await vi.advanceTimersByTimeAsync(10500);expect(starts).toHaveLength(10);expect(starts.map((at,i)=>i?at-(starts[i-1]??at):0)).toEqual([0,1000,1000,1000,1000,1000,1000,1000,1000,1000]);expect(output).toHaveLength(10);await done;}finally{vi.useRealTimers();}
});

import { compareCpuWithTop, parseMemoryParts, runCommand, SAMPLE_COMMANDS, type MemoryParts, type TopCpu } from '../daemon/sysstats.js';
export interface DiagnosticSample extends MemoryParts {cpuPercent:number;top:TopCpu}
async function sample():Promise<DiagnosticSample>{
  const cpu=await compareCpuWithTop();
  const memory=parseMemoryParts(await runCommand(SAMPLE_COMMANDS.vmStat.file,[...SAMPLE_COMMANDS.vmStat.args]));
  if(!memory)throw new Error('Memory diagnostic unavailable');
  return {...memory,...cpu};
}
// Independent of the daemon/socket: reading these OS counters never starts or stops a session.
export async function debugStats(options:{sample?:()=>Promise<DiagnosticSample>;write?:(text:string)=>void}={}):Promise<void>{
  const take=options.sample??sample,write=options.write??(text=>{process.stdout.write(text);});
  for(let index=0;index<10;index++){
    let value:DiagnosticSample;try{value=await take();}catch{throw new Error('Stats diagnostic failed');}
    write(JSON.stringify({sample:index+1,anonymousBytes:value.anonymousBytes,purgeableBytes:value.purgeableBytes,appBytes:value.appBytes,wiredBytes:value.wiredBytes,compressedBytes:value.compressedBytes,cachedBytes:value.cachedBytes,freeBytes:value.freeBytes,appWiredCompressedBytes:value.appWiredCompressedBytes,anonymousWiredCompressedBytes:value.anonymousWiredCompressedBytes,cpuPercent:value.cpuPercent,topUserPercent:value.top.userPercent,topSystemPercent:value.top.systemPercent,topIdlePercent:value.top.idlePercent,topBusyPercent:value.top.busyPercent})+'\n');
  }
}

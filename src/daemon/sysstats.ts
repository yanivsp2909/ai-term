import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { cpus, totalmem, type CpuInfo } from 'node:os';
import type { SessionStats, SystemStats } from '../shared/protocol.js';
import { validateSystemStats } from '../shared/validate.js';
// This machine (architecture §10): macOS, and Linux from v0.8.1. Samples run only while a client subscribes.
export interface ProcRow { pid: number; ppid: number; rssKb: number; cpu: number }
export interface NetCounter { rx: number; tx: number }
export interface SessionRoot { sessionId: string; pid: number }
export interface SamplerDeps {
  run(file: string, args: string[]): Promise<string>;
  cpus(): CpuInfo[];
  totalmem(): number;
  now(): number;
  sessions(): SessionRoot[];
  log: { info(message: string): void; error(message: string): void };
  platform?: NodeJS.Platform;
}
// Absolute paths: the daemon's PATH comes from whatever shell started it.
export const SAMPLE_COMMANDS = {
  // Only numeric columns: no command, user or name column is ever asked for. -A (every process) reads the same on macOS
  // and Linux, where -ax is a BSD spelling procps only half accepts.
  ps: { file: '/bin/ps', args: ['-Ao', 'pid=,ppid=,rss=,%cpu='] },
  vmStat: { file: '/usr/bin/vm_stat', args: [] as string[] },
  netstat: { file: '/usr/sbin/netstat', args: ['-ibn'] },
} as const;
// Linux (v0.8.1): memory and network come from /proc, read by cat so the sampler's one way of running things stays.
export interface SampleCommands { ps: { file: string; args: readonly string[] }; memory: { file: string; args: readonly string[] }; net: { file: string; args: readonly string[] } }
export function sampleCommands(platform: NodeJS.Platform = process.platform): SampleCommands {
  if (platform === 'linux') return { ps: { file: '/bin/ps', args: ['-Ao', 'pid=,ppid=,rss=,times='] }, memory: { file: '/bin/cat', args: ['/proc/meminfo'] }, net: { file: '/bin/cat', args: ['/proc/net/dev'] } };
  return { ps: SAMPLE_COMMANDS.ps, memory: SAMPLE_COMMANDS.vmStat, net: SAMPLE_COMMANDS.netstat };
}
// Linux: procps' %cpu is a lifetime average, so an agent idle after an hour of work would still look busy (TS review).
// times= is cumulative CPU seconds; the share is its change between two looks.
export interface PsTimes { pid: number; ppid: number; rssKb: number; seconds: number }
export function parsePsTimes(text: string): PsTimes[] {
  const rows: PsTimes[] = [];
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), seconds: Number(match[4]) });
  }
  return rows;
}
// cpu: percent of one core over the interval (ps's scale on macOS); a process not seen last time counts 0 this time.
export function psCpuShares(rows: readonly PsTimes[], before: ReadonlyMap<number, number>, seconds: number): ProcRow[] {
  return rows.map(row => { const then = before.get(row.pid); return { pid: row.pid, ppid: row.ppid, rssKb: row.rssKb, cpu: then === undefined || !(seconds > 0) || row.seconds < then ? 0 : (row.seconds - then) / seconds * 100 }; });
}
// Used = MemTotal − MemAvailable (what `free` calls used plus what the kernel can't reclaim quickly).
export function parseMeminfo(text: string): number | null {
  const field = (name: string) => { const value = text.match(new RegExp(`^${name}:\\s+(\\d+) kB$`, 'm'))?.[1]; return value === undefined ? null : Number(value) * 1024; };
  const total = field('MemTotal'), available = field('MemAvailable');
  if (total === null || available === null || !Number.isSafeInteger(total) || available > total) return null;
  return total - available;
}
// Virtual interfaces carry bytes the physical one also counts (containers, bridges, VPN tunnels): left out (TS review).
const VIRTUAL = /^(?:lo|veth|docker|br-|virbr|vnet|cni|flannel|cali|kube|podman|lxc|lxd|tun|tap|wg|tailscale|zt)/;
// /proc/net/dev: two header lines, then `name: rx-bytes ×8 fields, tx-bytes ×8 fields`. Loopback doesn't count.
export function parseProcNetDev(text: string): Map<string, NetCounter> | null {
  const lines = text.split('\n');
  if (!/\|\s*Receive/.test(lines[0] ?? '') || !/bytes/.test(lines[1] ?? '')) return null;
  const counters = new Map<string, NetCounter>();
  for (const line of lines.slice(2)) {
    const match = line.match(/^\s*([^:\s]+):\s*(.*)$/); if (!match) continue;
    const name = match[1] ?? '', fields = (match[2] ?? '').trim().split(/\s+/);
    if (VIRTUAL.test(name) || fields.length < 16 || !fields.every(field => /^\d+$/.test(field))) continue;
    counters.set(name, { rx: Number(fields[0]), tx: Number(fields[8]) });
  }
  return counters;
}
export const SAMPLE_INTERVAL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000, MAX_OUTPUT_BYTES = 1024 * 1024;
export interface MemoryParts {
  anonymousBytes:number;purgeableBytes:number;appBytes:number;wiredBytes:number;compressedBytes:number;
  cachedBytes:number;freeBytes:number;appWiredCompressedBytes:number;anonymousWiredCompressedBytes:number;
}
function vmCounts(text:string,labels:string[]):number[]|null {
  const pageSize=Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if(!Number.isSafeInteger(pageSize)||pageSize<=0)return null;
  const result:number[]=[];
  for(const label of labels){const value=text.match(new RegExp(`^${label}:\\s+(\\d+)\\.$`,'m'))?.[1];if(value===undefined)return null;const bytes=Number(value)*pageSize;if(!Number.isSafeInteger(bytes))return null;result.push(bytes);}
  return result;
}
export function parseMemoryParts(text:string):MemoryParts|null {
  const counts=vmCounts(text,['Anonymous pages','Pages purgeable','Pages wired down','Pages occupied by compressor','File-backed pages','Pages free']);
  if(!counts)return null;
  const [anonymousBytes=0,purgeableBytes=0,wiredBytes=0,compressedBytes=0,cachedBytes=0,freeBytes=0]=counts;
  if(purgeableBytes>anonymousBytes)return null;
  const appBytes=anonymousBytes-purgeableBytes,appWiredCompressedBytes=appBytes+wiredBytes+compressedBytes,anonymousWiredCompressedBytes=anonymousBytes+wiredBytes+compressedBytes;
  if(!Number.isSafeInteger(anonymousWiredCompressedBytes))return null;
  return {anonymousBytes,purgeableBytes,appBytes,wiredBytes,compressedBytes,cachedBytes,freeBytes,appWiredCompressedBytes,anonymousWiredCompressedBytes};
}
export interface TopCpu {userPercent:number;systemPercent:number;idlePercent:number;busyPercent:number}
export function parseTopCpu(text:string):TopCpu|null {
  let result:TopCpu|null=null;
  for(const line of text.split('\n')){
    const match=line.match(/^CPU usage:\s*([\d.]+)% user,\s*([\d.]+)% sys,\s*([\d.]+)% idle\s*$/);
    if(!match)continue;
    const userPercent=Number(match[1]),systemPercent=Number(match[2]),idlePercent=Number(match[3]),busyPercent=userPercent+systemPercent;
    if([userPercent,systemPercent,idlePercent,busyPercent].some(v=>!Number.isFinite(v)||v<0||v>100))return null;
    result={userPercent,systemPercent,idlePercent,busyPercent};
  }
  return result;
}
// Capture os.cpus() at top's two CPU lines so both rates cover the same sampling interval.
// top -n 0 suppresses its process table; only the parsed CPU numbers survive this boundary.
export function compareCpuWithTop():Promise<{cpuPercent:number;top:TopCpu;seconds:number}> {
  return new Promise((resolve,reject)=>{
    let pending='',before:CpuInfo[]|undefined,after:CpuInfo[]|undefined,top:TopCpu|null=null,start=0,end=0;
    const child=execFile('/usr/bin/top',['-l','2','-n','0','-s','1'],{timeout:5000,maxBuffer:MAX_OUTPUT_BYTES,encoding:'utf8',env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}},error=>{
      const value=before&&after?cpuPercent(before,after):null;
      if(error||value===null||!top){reject(new Error('CPU comparison unavailable'));return;}
      resolve({cpuPercent:value,top,seconds:(end-start)/1000});
    });
    child.stdout?.on('data',(chunk:string)=>{
      pending+=chunk;let boundary:number;
      while((boundary=pending.indexOf('\n'))>=0){const line=pending.slice(0,boundary);pending=pending.slice(boundary+1);const parsed=parseTopCpu(line);if(!parsed)continue;
        if(!before){before=cpus();start=performance.now();}else {after=cpus();end=performance.now();top=parsed;}
      }
    });
  });
}

export function parsePs(text: string): ProcRow[] {
  const rows: ProcRow[] = [];
  for (const line of text.split('\n')) {
    // Exactly four numbers. A fifth field would be a command line; such a line is dropped whole.
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s*$/);
    if (match) rows.push({ pid: Number(match[1]), ppid: Number(match[2]), rssKb: Number(match[3]), cpu: Number(match[4]) });
  }
  return rows;
}
// Activity Monitor's App Memory includes inactive anonymous pages too; purgeable pages are reclaimable.
export function parseVmStat(text: string): number | null {
  const pageSize = Number(text.match(/page size of (\d+) bytes/)?.[1]);
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) return null;
  const counts: number[] = [];
  for (const label of ['Anonymous pages', 'Pages purgeable', 'Pages wired down', 'Pages occupied by compressor']) {
    const value = text.match(new RegExp(`^${label}:\\s+(\\d+)\\.$`, 'm'))?.[1];
    if (value === undefined) return null;
    const count = Number(value);
    if (!Number.isSafeInteger(count)) return null;
    counts.push(count);
  }
  const [anonymous = 0, purgeable = 0, wired = 0, compressed = 0] = counts;
  if (purgeable > anonymous) return null;
  const bytes = (anonymous - purgeable + wired + compressed) * pageSize;
  return Number.isSafeInteger(bytes) ? bytes : null;
}
// Link-layer rows (`<Link#N>`) carry each interface's totals once; address rows repeat them.
// Rows without a hardware address have 10 fields instead of 11, so the byte columns are read from the end.
export function parseNetstat(text: string): Map<string, NetCounter> | null {
  const lines = text.split('\n');
  if (!/^Name\s+Mtu\s+Network\s+Address\s+Ipkts\s+Ierrs\s+Ibytes\s+Opkts\s+Oerrs\s+Obytes/.test(lines[0] ?? '')) return null;
  const counters = new Map<string, NetCounter>();
  for (const line of lines.slice(1)) {
    const fields = line.trim().split(/\s+/), name = fields[0]?.replace(/\*$/, '') ?? '';
    if (!fields[2]?.startsWith('<Link#') || (fields.length !== 10 && fields.length !== 11) || !name || /^lo\d*$/.test(name)) continue;
    const rx = fields[fields.length - 5] ?? '', tx = fields[fields.length - 2] ?? '';
    if (/^\d+$/.test(rx) && /^\d+$/.test(tx)) counters.set(name, { rx: Number(rx), tx: Number(tx) });
  }
  return counters;
}
// Only interfaces present in both samples count. A counter that went backwards (reset) voids the sample.
export function netRates(before: Map<string, NetCounter>, after: Map<string, NetCounter>, seconds: number): NetCounter | null {
  if (!(seconds > 0)) return null;
  let rx = 0, tx = 0;
  for (const [name, now] of after) {
    const then = before.get(name);
    if (!then) continue;
    if (now.rx < then.rx || now.tx < then.tx) return null;
    rx += now.rx - then.rx; tx += now.tx - then.tx;
  }
  return { rx: rx / seconds, tx: tx / seconds };
}
function cpuTotals(list: CpuInfo[]): { busy: number; total: number } {
  let busy = 0, total = 0;
  for (const { times } of list) { const all = times.user + times.nice + times.sys + times.idle + times.irq; total += all; busy += all - times.idle; }
  return { busy, total };
}
export function cpuPercent(before: CpuInfo[], after: CpuInfo[]): number | null {
  if (before.length !== after.length || !after.length) return null;
  const a = cpuTotals(before), b = cpuTotals(after), total = b.total - a.total;
  return total > 0 ? clampShare(((b.busy - a.busy) / total) * 100) : null;
}
function clampShare(value: number): number { return Math.min(100, Math.max(0, value)); }
// ps reports %cpu per core (one busy thread = 100); dividing by the core count makes it a machine share.
export function sessionUsage(rows: ProcRow[], roots: SessionRoot[], cpuCount: number): SessionStats[] {
  const byPid = new Map(rows.map(row => [row.pid, row])), children = new Map<number, number[]>();
  for (const row of rows) if (row.pid !== row.ppid) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row.pid]);
  const result: SessionStats[] = [];
  for (const { sessionId, pid } of roots) {
    if (!byPid.has(pid)) continue;
    let cpu = 0, rssKb = 0;
    const seen = new Set<number>(), stack = [pid];
    for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
      const row = byPid.get(next);
      if (seen.has(next) || !row) continue;
      seen.add(next); cpu += row.cpu; rssKb += row.rssKb; stack.push(...(children.get(next) ?? []));
    }
    result.push({ sessionId, cpuPercent: clampShare(cpu / Math.max(1, cpuCount)), rssBytes: rssKb * 1024 });
  }
  return result;
}

class SampleError extends Error {}
function reason(error: unknown): string {
  // Fixed words only: an exec error's message can carry the child's stderr.
  if (error instanceof SampleError) return error.message;
  if (error && typeof error === 'object') {
    if ('killed' in error && error.killed) return 'timed out';
    if ('code' in error && error.code === 'ENOENT') return 'command missing';
    if ('code' in error && error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output too large';
    if ('code' in error && typeof error.code === 'number') return `exit ${error.code}`;
  }
  return 'failed';
}
export function runCommand(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => execFile(file, args, { timeout: COMMAND_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: 'utf8' }, (error, stdout) => error ? reject(error) : resolve(stdout)));
}
export const defaultSamplerDeps = (sessions: () => SessionRoot[], log: SamplerDeps['log']): SamplerDeps => ({ run: runCommand, cpus, totalmem, now: () => performance.now(), sessions, log });

interface Baseline { at: number; cpus: CpuInfo[]; net: Map<string, NetCounter>; times?: Map<number, number> }
export class SystemSampler extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | undefined;
  private baseline: Baseline | null = null;
  private busy = false;
  private failing = false;
  // Bumped on every stop, so a sample still in flight from an earlier run is thrown away.
  private generation = 0;
  constructor(private readonly deps: SamplerDeps, private readonly intervalMs = SAMPLE_INTERVAL_MS) { super(); }
  running(): boolean { return this.timer !== undefined; }
  setSubscribers(count: number): void {
    if (count > 0 && !this.timer) {
      this.timer = setInterval(() => this.tick(), this.intervalMs);
      this.tick();
    } else if (count === 0 && this.timer) {
      clearInterval(this.timer); this.timer = undefined; this.baseline = null; this.busy = false; this.generation++;
    }
  }
  private tick(): void {
    if (this.busy) return; // a slow sample never stacks a second one behind it
    this.busy = true;
    const generation = this.generation;
    void this.sample(generation).then(stats => {
      if (generation !== this.generation) return;
      if (this.failing) { this.failing = false; this.deps.log.info('System stats sampling recovered'); }
      if (stats) this.emit('stats', stats);
    }, (error: unknown) => {
      if (generation !== this.generation) return;
      this.baseline = null;
      if (!this.failing) { this.failing = true; this.deps.log.error(`System stats sample skipped (${reason(error)})`); }
    }).finally(() => { if (generation === this.generation) this.busy = false; });
  }
  private async sample(generation: number): Promise<SystemStats | null> {
    const linux = (this.deps.platform ?? process.platform) === 'linux', { ps, memory, net: netCommand } = sampleCommands(linux ? 'linux' : 'darwin');
    const [psText, vmText, netText] = await Promise.all([this.deps.run(ps.file, [...ps.args]), this.deps.run(memory.file, [...memory.args]), this.deps.run(netCommand.file, [...netCommand.args])]);
    // Sampling stopped while the commands ran: leave no baseline, or the next run's first event would average over the gap.
    if (generation !== this.generation) return null;
    const at = this.deps.now(), cpuList = this.deps.cpus(), net = linux ? parseProcNetDev(netText) : parseNetstat(netText), memUsed = linux ? parseMeminfo(vmText) : parseVmStat(vmText);
    if (!net) throw new SampleError(linux ? '/proc/net/dev unreadable' : 'netstat output unreadable');
    if (memUsed === null) throw new SampleError(linux ? '/proc/meminfo unreadable' : 'vm_stat output unreadable');
    const before = this.baseline, times = linux ? parsePsTimes(psText) : null;
    this.baseline = { at, cpus: cpuList, net, ...times ? { times: new Map(times.map(row => [row.pid, row.seconds])) } : {} };
    if (!before) return null; // the first sample only sets the baseline for the deltas
    const machineCpu = cpuPercent(before.cpus, cpuList), rates = netRates(before.net, net, (at - before.at) / 1000);
    if (machineCpu === null || rates === null) return null; // counter reset or no elapsed time: skip this one
    const memTotal = this.deps.totalmem();
    return validateSystemStats({
      cpuPercent: machineCpu, memUsedBytes: Math.min(memUsed, memTotal), memTotalBytes: memTotal, netRxBytesPerSec: rates.rx, netTxBytesPerSec: rates.tx,
      sessions: sessionUsage(times ? psCpuShares(times, before.times ?? new Map(), (at - before.at) / 1000) : parsePs(psText), this.deps.sessions(), cpuList.length),
    });
  }
}

import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { cpus, totalmem, type CpuInfo } from 'node:os';
import type { SessionStats, SystemStats } from '../shared/protocol.js';
import { validateSystemStats } from '../shared/validate.js';
// This Mac (architecture §10, macOS only until v0.8). Samples run only while a client subscribes.
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
}
// Absolute paths: the daemon's PATH comes from whatever shell started it.
export const SAMPLE_COMMANDS = {
  // Only numeric columns: no command, user or name column is ever asked for.
  ps: { file: '/bin/ps', args: ['-axo', 'pid=,ppid=,rss=,%cpu='] },
  vmStat: { file: '/usr/bin/vm_stat', args: [] as string[] },
  netstat: { file: '/usr/sbin/netstat', args: ['-ibn'] },
} as const;
export const SAMPLE_INTERVAL_MS = 1000;
const COMMAND_TIMEOUT_MS = 2000, MAX_OUTPUT_BYTES = 1024 * 1024;

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

interface Baseline { at: number; cpus: CpuInfo[]; net: Map<string, NetCounter> }
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
    const { ps, vmStat, netstat } = SAMPLE_COMMANDS;
    const [psText, vmText, netText] = await Promise.all([this.deps.run(ps.file, [...ps.args]), this.deps.run(vmStat.file, [...vmStat.args]), this.deps.run(netstat.file, [...netstat.args])]);
    // Sampling stopped while the commands ran: leave no baseline, or the next run's first event would average over the gap.
    if (generation !== this.generation) return null;
    const at = this.deps.now(), cpuList = this.deps.cpus(), net = parseNetstat(netText), memUsed = parseVmStat(vmText);
    if (!net) throw new SampleError('netstat output unreadable');
    if (memUsed === null) throw new SampleError('vm_stat output unreadable');
    const before = this.baseline;
    this.baseline = { at, cpus: cpuList, net };
    if (!before) return null; // the first sample only sets the baseline for the deltas
    const machineCpu = cpuPercent(before.cpus, cpuList), rates = netRates(before.net, net, (at - before.at) / 1000);
    if (machineCpu === null || rates === null) return null; // counter reset or no elapsed time: skip this one
    const memTotal = this.deps.totalmem();
    return validateSystemStats({
      cpuPercent: machineCpu, memUsedBytes: Math.min(memUsed, memTotal), memTotalBytes: memTotal, netRxBytesPerSec: rates.rx, netTxBytesPerSec: rates.tx,
      sessions: sessionUsage(parsePs(psText), this.deps.sessions(), cpuList.length),
    });
  }
}

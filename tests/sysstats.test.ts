import { afterEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { CpuInfo } from 'node:os';
import { parsePs, parseVmStat, parseNetstat, netRates, cpuPercent, sessionUsage, SystemSampler, SAMPLE_COMMANDS, type SamplerDeps } from '../src/daemon/sysstats.js';
import { validateRequest, validateSystemStats } from '../src/shared/validate.js';
import type { SystemStats } from '../src/shared/protocol.js';

// Shapes recorded from macOS 26 (`vm_stat`, `netstat -ibn`, `ps -axo pid=,ppid=,rss=,%cpu=`); addresses scrubbed.
const VM_STAT = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                                    64668.
Pages active:                                 659302.
Pages inactive:                               640422.
Pages speculative:                             19979.
Pages throttled:                                   0.
Pages wired down:                             190882.
Pages purgeable:                               11197.
"Translation faults":                     5559429999.
Pages stored in compressor:                   953866.
Pages occupied by compressor:                 464846.
Swapouts:                                     198288.
`;
const NETSTAT = (en0In: number, en0Out: number, utunIn = 36664, utunOut = 111738) => `Name       Mtu   Network       Address            Ipkts Ierrs     Ibytes    Opkts Oerrs     Obytes  Coll
lo0        16384 <Link#1>                        7601835     0 1509837519  7601835     0 1509837519     0
lo0        16384 127           127.0.0.1         7601835     - 1509837519  7601835     - 1509837519     -
gif0*      1280  <Link#2>                              0     0          0        0     0          0     0
en0        1500  <Link#15>   00:00:00:00:00:01  95000000     0 ${en0In} 41000000     0 ${en0Out}     0
en0        1500  fe80::1%en0 fe80::1:1:1:1%en0  95000000     - 999999999999 41000000     - 999999999999     -
en0        1500  192.168.1     192.168.1.2      95000000     - 999999999999 41000000     - 999999999999     -
utun5      1380  <Link#25>                           120     0 ${utunIn}      400     0 ${utunOut}     0
bad0       1500  <Link#30>   00:00:00:00:00:02  notanumber  0 garbage     1     0     2     0
`;
// The daemon is 100; session roots are 200 and 300. 999 is someone else's process.
const PS = `    0     0      0   0.0
    1     0  25424   0.0
  100     1  50000   1.0
  200   100  10000  10.0
  201   200  20000  30.0
  202   201   5000   5.0
  300   100   4000   0.0
  999     1 900000  50.0
`;
const cpu = (busy: number, idle: number): CpuInfo => ({ model: 'm', speed: 1, times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });

describe('parsers', () => {
  it('parsePs keeps only well-formed numeric rows and drops anything with a command line', () => {
    const rows = parsePs(`${PS}\n  PID  PPID   RSS  %CPU\n  500   1  2048  0.5 /usr/bin/secret-tool --token=SECRET\nnonsense\n  501  1  -5  0.1\n  502  1  10  NaN\n`);
    expect(rows).toHaveLength(8);
    expect(rows.find(r => r.pid === 500)).toBeUndefined();
    expect(rows.find(r => r.pid === 201)).toEqual({ pid: 201, ppid: 200, rssKb: 20000, cpu: 30 });
    expect(JSON.stringify(rows)).not.toContain('secret');
  });
  it('parseVmStat sums active, wired and compressor pages times the page size', () => {
    expect(parseVmStat(VM_STAT)).toBe((659302 + 190882 + 464846) * 16384);
    expect(parseVmStat(VM_STAT.replace(/Pages wired down:.*\n/, ''))).toBeNull();
    expect(parseVmStat(VM_STAT.replace('page size of 16384 bytes', 'page size unknown'))).toBeNull();
    expect(parseVmStat(VM_STAT.replace('659302.', 'abc.'))).toBeNull();
    expect(parseVmStat('')).toBeNull();
  });
  it('parseNetstat reads link rows of non-loopback interfaces only, 10- and 11-field rows alike', () => {
    const counters = parseNetstat(NETSTAT(1000, 500));
    expect(counters && Object.fromEntries(counters)).toEqual({ 'gif0': { rx: 0, tx: 0 }, en0: { rx: 1000, tx: 500 }, utun5: { rx: 36664, tx: 111738 } });
    expect(parseNetstat('garbage\nmore garbage')).toBeNull();
  });
  it('netRates divides deltas by elapsed seconds and never goes negative', () => {
    const before = parseNetstat(NETSTAT(1000, 500)), after = parseNetstat(NETSTAT(5000, 1500, 36664 + 2000, 111738));
    if (!before || !after) throw new Error('fixture');
    expect(netRates(before, after, 2)).toEqual({ rx: 3000, tx: 500 });
    const reset = parseNetstat(NETSTAT(10, 1500));
    if (!reset) throw new Error('fixture');
    expect(netRates(before, reset, 2)).toBeNull();
    expect(netRates(before, after, 0)).toBeNull();
    // An interface that appears or disappears between samples is left out, not counted from zero.
    const vpn = new Map(after); vpn.set('utun9', { rx: 9e9, tx: 9e9 });
    expect(netRates(before, vpn, 2)).toEqual({ rx: 3000, tx: 500 });
  });
  it('cpuPercent is the busy share of all cores between two os.cpus() samples', () => {
    expect(cpuPercent([cpu(100, 900), cpu(100, 900)], [cpu(400, 1600), cpu(200, 1800)])).toBe(20);
    expect(cpuPercent([cpu(1, 1)], [cpu(1, 1)])).toBeNull();
    expect(cpuPercent([cpu(1, 1)], [cpu(1, 1), cpu(1, 1)])).toBeNull();
  });
  it('sessionUsage sums each session root and all its descendants as a share of the whole machine', () => {
    const a = randomUUID(), b = randomUUID(), gone = randomUUID();
    const usage = sessionUsage(parsePs(PS), [{ sessionId: a, pid: 200 }, { sessionId: b, pid: 300 }, { sessionId: gone, pid: 4242 }], 10);
    expect(usage).toEqual([{ sessionId: a, cpuPercent: 4.5, rssBytes: 35000 * 1024 }, { sessionId: b, cpuPercent: 0, rssBytes: 4000 * 1024 }]);
    // pid 0 is its own parent on macOS; the walk must still end. Shares are clamped to 0–100.
    expect(sessionUsage(parsePs('0 0 0 0\n7 0 1 900\n'), [{ sessionId: a, pid: 0 }], 1)).toEqual([{ sessionId: a, cpuPercent: 100, rssBytes: 1024 }]);
  });
});

describe('contract', () => {
  const stats = (): SystemStats => ({ cpuPercent: 31, memUsedBytes: 14e9, memTotalBytes: 32e9, netRxBytesPerSec: 1.4e6, netTxBytesPerSec: 2e5, sessions: [{ sessionId: randomUUID(), cpuPercent: 4, rssBytes: 310e6 }] });
  it('system.subscribe takes exactly one boolean', async () => {
    await expect(validateRequest({ id: randomUUID(), kind: 'system.subscribe', on: true })).resolves.toMatchObject({ on: true });
    for (const bad of [{ on: 'yes' }, {}, { on: false, pid: 1 }]) await expect(validateRequest({ id: randomUUID(), kind: 'system.subscribe', ...bad })).rejects.toThrow();
  });
  it('system.stats carries numbers only, in range, and no extra fields', () => {
    expect(validateSystemStats(stats())).toEqual(expect.objectContaining({ cpuPercent: 31 }));
    const s = stats(), session = s.sessions[0];
    if (!session) throw new Error('fixture');
    for (const bad of [{ ...s, command: '/usr/bin/secret' }, { ...s, cpuPercent: 101 }, { ...s, memUsedBytes: -1 }, { ...s, netRxBytesPerSec: Number.NaN }, { ...s, memUsedBytes: 33e9 },
      { ...s, sessions: [{ ...session, name: 'vim' }] }, { ...s, sessions: [{ ...session, sessionId: 'x' }] }, { ...s, sessions: [{ ...session, cpuPercent: Infinity }] },
      { ...s, sessions: Array.from({ length: 1001 }, () => session) }, null, []]) expect(() => validateSystemStats(bad)).toThrow();
  });
});

describe('SystemSampler', () => {
  afterEach(() => { vi.useRealTimers(); });
  function fixture(ps = PS) {
    vi.useFakeTimers();
    let tick = 0, rx = 1000;
    const calls: string[] = [], logs: string[] = [];
    const run = vi.fn<SamplerDeps['run']>(async (file: string) => {
      calls.push(file);
      if (file === SAMPLE_COMMANDS.ps.file) return ps;
      if (file === SAMPLE_COMMANDS.vmStat.file) return VM_STAT;
      rx += 4000; return NETSTAT(rx, 500);
    });
    const id = randomUUID();
    const deps: SamplerDeps = { run, cpus: () => { tick++; return [cpu(100 * tick, 300 * tick)]; }, totalmem: () => 64 * 1024 ** 3, now: () => Date.now(), sessions: () => [{ sessionId: id, pid: 200 }], log: { info: m => logs.push(m), error: m => logs.push(m) } };
    const sampler = new SystemSampler(deps), events: SystemStats[] = [];
    sampler.on('stats', (s: SystemStats) => events.push(s));
    return { sampler, run, calls, logs, events, id };
  }
  it('never spawns a process while nobody is subscribed', async () => {
    const { run } = fixture();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run).not.toHaveBeenCalled();
  });
  it('samples every 2 s while subscribed, emits valid numbers only, and stops with the last subscriber', async () => {
    const { sampler, run, events, id, logs } = fixture(`${PS}  500   200  2048  0.5 /usr/bin/secret-tool --token=SECRET\n`);
    sampler.setSubscribers(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toHaveLength(0); // the first sample is only a baseline for the deltas
    await vi.advanceTimersByTimeAsync(4000);
    expect(events).toHaveLength(2);
    const last = events.at(-1);
    expect(validateSystemStats(last)).toBeTruthy();
    expect(last).toMatchObject({ cpuPercent: 25, memTotalBytes: 64 * 1024 ** 3, netRxBytesPerSec: 2000, netTxBytesPerSec: 0, sessions: [{ sessionId: id, cpuPercent: 45, rssBytes: 35000 * 1024 }] });
    expect(JSON.stringify(events) + logs.join('\n')).not.toMatch(/secret|SECRET/);
    const used = run.mock.calls.length;
    sampler.setSubscribers(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.mock.calls.length).toBe(used);
    expect(sampler.running()).toBe(false);
  });
  it('commands are absolute paths with argv arrays', () => {
    for (const command of Object.values(SAMPLE_COMMANDS)) { expect(command.file.startsWith('/')).toBe(true); expect(Array.isArray(command.args)).toBe(true); }
    expect(SAMPLE_COMMANDS.ps.args).toEqual(['-axo', 'pid=,ppid=,rss=,%cpu=']);
  });
  it('a failing or slow sample is skipped and logged once per failure streak, and never overlaps the next tick', async () => {
    const { sampler, run, events, logs } = fixture();
    let fail = true, hang: (() => void) | null = null;
    const base = run.getMockImplementation();
    run.mockImplementation(async (file: string, args: string[]) => {
      if (fail) throw Object.assign(new Error(`Command failed: ${file} SECRET stderr`), { killed: true, signal: 'SIGTERM' });
      if (hang === null && file === SAMPLE_COMMANDS.ps.file && events.length === 1) await new Promise<void>(resolve => { hang = resolve; });
      if (!base) throw new Error('fixture');
      return base(file, args);
    });
    sampler.setSubscribers(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toHaveLength(0);
    expect(logs).toEqual(['System stats sample skipped (timed out)']); // never the error text: it can carry stderr
    fail = false;
    await vi.advanceTimersByTimeAsync(4000);
    expect(events).toHaveLength(1);
    expect(logs.at(-1)).toBe('System stats sampling recovered');
    await vi.advanceTimersByTimeAsync(2000); // this tick's ps hangs
    const before = run.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000); // no new tick starts behind it
    expect(run.mock.calls.length).toBe(before);
    expect(hang).not.toBeNull();
    sampler.setSubscribers(0);
  });
  it('a sample still in flight when sampling stops never leaves a baseline for the next run', async () => {
    const { sampler, run, events } = fixture();
    const base = run.getMockImplementation();
    let hang: (() => void) | null = null, holding = false;
    run.mockImplementation(async (file: string, args: string[]) => {
      if (holding && file === SAMPLE_COMMANDS.ps.file) await new Promise<void>(resolve => { hang = resolve; });
      if (!base) throw new Error('fixture');
      return base(file, args);
    });
    sampler.setSubscribers(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(events).toHaveLength(1);
    holding = true;
    await vi.advanceTimersByTimeAsync(2000); // this sample hangs in ps
    sampler.setSubscribers(0);
    holding = false; (hang as (() => void) | null)?.();
    await vi.advanceTimersByTimeAsync(60_000);
    sampler.setSubscribers(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(events).toHaveLength(1); // the restart's first sample is a baseline again, not a 60 s average
    await vi.advanceTimersByTimeAsync(1);
    expect(events).toHaveLength(2);
    sampler.setSubscribers(0);
  });
});

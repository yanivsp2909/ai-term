import { execFile } from 'node:child_process';

// B26: a test run's processes, followed while it runs. Killing the run's process group misses a process that moved to its
// own session (setsid) or group; while its parent still lives it shows up here as a descendant, and when the run ends it
// is stopped too. Each process is remembered with its start time, so a reused process id is never signalled. A process
// that detaches faster than one look (a double fork within POLL_MS) can still outlive the run, inside the sandbox.
const POLL_MS = 250;
interface Row { ppid: number; start: string }
function table(): Promise<Map<number, Row>> {
  return new Promise((done, fail) => execFile('/bin/ps', ['-axo', 'pid=,ppid=,lstart='], { env: { PATH: '/usr/bin:/bin', LC_ALL: 'C' }, maxBuffer: 16 * 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
    if (error) { fail(error); return; }
    const rows = new Map<number, Row>();
    for (const line of stdout.split('\n')) { const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/); if (match) rows.set(Number(match[1]), { ppid: Number(match[2]), start: match[3] ?? '' }); }
    done(rows);
  }));
}
export class ProcessTree {
  private readonly seen = new Map<number, string>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private looking: Promise<void> | null = null;
  constructor(private readonly root: number, private readonly log: (text: string) => void = () => {}) {}
  start(): void { this.timer = setInterval(() => { void this.look(); }, POLL_MS); this.timer.unref(); void this.look(); }
  private look(): Promise<void> {
    this.looking ??= table().then(rows => { this.add(rows, true); }, () => { this.log('Test run: the process list could not be read'); }).finally(() => { this.looking = null; });
    return this.looking;
  }
  // adopt: only a look while the run lives records the root; at stop it may be gone and its id reused by a stranger.
  private add(rows: Map<number, Row>, adopt: boolean): void {
    const root = rows.get(this.root); if (adopt && root && !this.seen.has(this.root)) this.seen.set(this.root, root.start);
    // Only a process still running since it was seen is family: a reused id's children are someone else's.
    const family = new Set([...this.seen].filter(([pid, start]) => rows.get(pid)?.start === start).map(([pid]) => pid));
    for (let grew = true; grew;) {
      grew = false;
      for (const [pid, row] of rows) if (!family.has(pid) && family.has(row.ppid)) { family.add(pid); this.seen.set(pid, row.start); grew = true; }
    }
  }
  // Every process of the run still alive, started at the time it was seen: SIGKILL. Returns how many were stopped.
  async stop(): Promise<number> {
    clearInterval(this.timer); await this.looking;
    let rows: Map<number, Row>;
    try { rows = await table(); } catch { this.log('Test run: the process list could not be read; leftover processes were not checked'); return 0; }
    this.add(rows, false);
    let stopped = 0;
    for (const [pid, start] of this.seen) {
      if (rows.get(pid)?.start !== start) continue;
      try { process.kill(pid, 'SIGKILL'); stopped++; }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) this.log('Test run: a leftover process could not be stopped'); }
    }
    return stopped;
  }
}

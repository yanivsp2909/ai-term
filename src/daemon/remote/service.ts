import { execFile, spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, open, rename, rm } from 'node:fs/promises';
const LOG_MAX_BYTES = 5 * 1024 * 1024;
import { join } from 'node:path';
import type { KeyStore } from '../keys.js';
import { atomicWrite, readState } from '../store.js';
import { isFsError } from '../../shared/paths.js';
import { REMOTE_HTTPS_PORT, REMOTE_IDLE_MS, type RemoteStatus } from '../../shared/remote.js';
import { PairingCodes, PHONE_ERRORS, RemotePhones } from './phones.js';
import { RemoteHttp, type RemoteBackend, type RemoteLogEntry } from './http.js';
import { findTailscale, ServeUnconfirmed, Tailscale, TailscaleError, TAILSCALE_ERRORS } from './tailscale.js';

// v1.0.8 /remote (D54, its /settings switch off by default). On: the phone server on 127.0.0.1 and `tailscale serve` for
// its own HTTPS port. Off by itself after 30 minutes with no requests, at daemon shutdown and, should the daemon die,
// at its next start (the state file says what to remove). While on and on AC power, `caffeinate -i -w <daemon pid>`
// keeps the Mac awake; it stops with /remote. Every action goes to ~/.ai-term/remote.log (0600): who, what, which agent,
// when, and never a code, a token or a message's text (its length only).
export const REMOTE_ERRORS = [TAILSCALE_ERRORS[0], TAILSCALE_ERRORS[1], 'Phone remote is off in /settings · R turns it on there, then /remote on', TAILSCALE_ERRORS[2], PHONE_ERRORS[0]] as const;
export const REMOTE_SERVICE_ERRORS: readonly string[] = [...new Set([...REMOTE_ERRORS, ...TAILSCALE_ERRORS, ...PHONE_ERRORS, '/remote is off · /remote on turns it on'])];
// failed: caffeinate couldn't start or stopped early; the Mac is then no longer kept awake.
export interface RemotePower { onAc(): Promise<boolean>; keepAwake(pid: number, failed: () => void): { stop(): void } }
// pmset says which power source is in use; caffeinate -i -w ends by itself if the daemon dies first.
export const macPower: RemotePower = {
  onAc: () => new Promise(done => execFile('/usr/bin/pmset', ['-g', 'batt'], { timeout: 5000 }, (error, stdout) => done(!error && /'AC Power'/.test(stdout)))),
  keepAwake: (pid, failed) => {
    const child = spawn('/usr/bin/caffeinate', ['-i', '-w', String(pid)], { stdio: 'ignore' });
    let stopped = false;
    child.on('error', failed); child.on('exit', () => { if (!stopped) failed(); });
    return { stop: () => { stopped = true; child.kill('SIGTERM'); } };
  },
};
export interface RemoteOptions { root: string; keys: KeyStore; backend: RemoteBackend; log: { error(text: string): void; info(text: string): void }; tailscale?: string | null; allowed: () => Promise<boolean>; power?: RemotePower; now?: () => number; pid?: number }
interface Live { http: RemoteHttp; tailscale: Tailscale; host: string; backend: string; since: number; lastRequest: number; awake: { stop(): void } | null; timer: NodeJS.Timeout }
export class RemoteService {
  private live: Live | null = null;
  private codes = new PairingCodes();
  readonly phones: RemotePhones;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private options: RemoteOptions) { this.phones = new RemotePhones(options.root, options.keys); }
  private now(): number { return this.options.now?.() ?? Date.now(); }
  private get stateFile(): string { return join(this.options.root, 'remote-state.json'); }
  private serial<T>(work: () => Promise<T>): Promise<T> { const next = this.queue.then(work); this.queue = next.then(() => undefined, () => undefined); return next; }
  isOn(): boolean { return this.live !== null; }
  async log(entry: RemoteLogEntry): Promise<void> {
    const line = `${JSON.stringify({ time: new Date(this.now()).toISOString(), ...entry })}\n`;
    try {
      const path = join(this.options.root, 'remote.log');
      // Kept small: past 5 MiB the log moves to remote.log.1 (one older copy).
      try { const old = await lstat(path); if (old.isFile() && old.size > LOG_MAX_BYTES) await rename(path, `${path}.1`); } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
      const file = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
      try { const info = await file.stat(); if (!info.isFile() || info.uid !== process.getuid?.()) throw new Error('not ours'); await file.chmod(0o600); await file.write(line); } finally { await file.close(); }
    } catch { this.options.log.error('Remote: remote.log could not be written'); }
  }
  async status(pair?: RemoteStatus['pair']): Promise<RemoteStatus> {
    const phones = await this.phones.list(), live = this.live;
    if (!live) return { state: 'off', phones };
    return { state: 'on', host: live.host, since: new Date(live.since).toISOString(), lastRequest: new Date(live.lastRequest).toISOString(), awake: live.awake !== null, phones, ...pair ? { pair } : {} };
  }
  // On (or, when already on, a fresh pairing code): the answer carries the one-time URL for the QR.
  on(): Promise<RemoteStatus> {
    return this.serial(async () => {
      if (!this.live) await this.start();
      const live = this.live; if (!live) throw new Error('/remote is off · /remote on turns it on');
      const { code, expiresAt } = this.codes.issue(this.now());
      await this.log({ action: 'pairing code shown' });
      return this.status({ url: `https://${live.host}/pair#${code}`, expiresAt: new Date(expiresAt).toISOString() });
    });
  }
  private async start(): Promise<void> {
    if (!await this.options.allowed()) throw new Error(REMOTE_ERRORS[2]);
    const program = this.options.tailscale === undefined ? await findTailscale() : this.options.tailscale;
    if (!program) throw new TailscaleError(TAILSCALE_ERRORS[0]);
    const tailscale = new Tailscale(program), self = await tailscale.self(), host = `${self.host}:${REMOTE_HTTPS_PORT}`;
    const http = new RemoteHttp({ host, login: self.login, phones: this.phones, codes: this.codes, backend: this.options.backend, log: entry => { void this.log(entry); }, activity: () => { if (this.live) this.live.lastRequest = this.now(); }, now: () => this.now(), fail: text => this.options.log.error(text) });
    const port = await http.listen(), backend = `http://127.0.0.1:${port}`;
    try {
      // Written first: should the daemon die from here on, its next start removes the serve entry.
      await atomicWrite(this.stateFile, { httpsPort: REMOTE_HTTPS_PORT, backend });
      await tailscale.on(REMOTE_HTTPS_PORT, backend);
    } catch (error) {
      await http.close();
      // serve ran but its entry couldn't be confirmed: it is AI Term's (the port was free just before), so it goes again,
      // or the state file stays for the next start to try (review: a dangling entry pointed at a port anyone could take).
      if (error instanceof ServeUnconfirmed) {
        try { await tailscale.drop(REMOTE_HTTPS_PORT); } catch { this.options.log.error("Remote: an unconfirmed tailscale serve entry couldn't be removed; run tailscale serve --https=8443 off"); throw error; }
      }
      await rm(this.stateFile, { force: true }); throw error;
    }
    const now = this.now(), timer = setInterval(() => { void this.tick().catch(() => this.options.log.error('Remote: its minute check failed')); }, 60_000);
    timer.unref();
    this.live = { http, tailscale, host, backend, since: now, lastRequest: now, awake: null, timer };
    await this.power();
    await this.log({ action: 'on', reason: `tailscale serve https:${REMOTE_HTTPS_PORT}` });
  }
  private async power(): Promise<void> {
    const live = this.live; if (!live) return;
    const ac = await (this.options.power ?? macPower).onAc();
    if (ac && !live.awake) {
      const handle = (this.options.power ?? macPower).keepAwake(this.options.pid ?? process.pid, () => {
        this.options.log.error("Remote: caffeinate couldn't keep the Mac awake");
        if (this.live?.awake === handle) this.live.awake = null;
      });
      live.awake = handle;
    }
    else if (!ac && live.awake) { live.awake.stop(); live.awake = null; }
  }
  // Every minute while on: off after 30 idle minutes; awake only on AC power.
  async tick(): Promise<void> {
    const live = this.live; if (!live) return;
    if (this.now() - live.lastRequest >= REMOTE_IDLE_MS) { await this.off('idle'); return; }
    await this.power();
  }
  off(reason: 'command' | 'idle' | 'shutdown'): Promise<RemoteStatus> {
    return this.serial(async () => {
      const live = this.live; this.live = null; this.codes.clear();
      if (!live) return this.status();
      clearInterval(live.timer); live.awake?.stop();
      await live.http.close();
      let removed = false;
      try { removed = await live.tailscale.off(REMOTE_HTTPS_PORT, live.backend); } catch { this.options.log.error("Remote: tailscale serve couldn't be turned off; run tailscale serve --https=8443 off"); }
      if (removed) await rm(this.stateFile, { force: true });
      await this.log({ action: 'off', reason });
      return this.status();
    });
  }
  async revoke(which: string): Promise<RemoteStatus> {
    const phone = await this.phones.revoke(which);
    await this.log({ action: 'revoke', phone: phone.name, phoneId: phone.id });
    return this.status();
  }
  // Daemon start: /remote is off after a restart. A serve entry the last daemon left is removed if it is still ours.
  async cleanup(): Promise<void> {
    let state: unknown;
    try { state = await readState(this.stateFile); } catch { this.options.log.error('Remote: remote-state.json is unreadable; check tailscale serve status'); return; }
    const value = state && typeof state === 'object' ? state as Record<string, unknown> : {};
    if (value.httpsPort !== REMOTE_HTTPS_PORT || typeof value.backend !== 'string' || !/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(value.backend)) return;
    const program = this.options.tailscale === undefined ? await findTailscale() : this.options.tailscale;
    try {
      if (program && await new Tailscale(program).off(REMOTE_HTTPS_PORT, value.backend)) await this.log({ action: 'off', reason: 'restart' });
      await rm(this.stateFile, { force: true });
    } catch (error) { if (!isFsError(error, 'ENOENT')) this.options.log.error("Remote: last run's tailscale serve entry couldn't be checked; run tailscale serve status"); }
  }
  async close(): Promise<void> { await this.off('shutdown'); }
}

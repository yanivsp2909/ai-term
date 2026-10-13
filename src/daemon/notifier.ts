import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { NotifierState, SessionInfo } from '../shared/protocol.js';
import { notificationBody, notificationFor } from './notify-policy.js';
import { NotificationPermission } from './notification-permission.js';
import { SettingsStore } from './settings.js';
// Inside the bundle; the helper's own name in Info.plist.
export const NOTIFIER_EXECUTABLE = 'Contents/MacOS/AITermNotifier';
// One fixed place per checkout (src/cli/index.ts and dist/cli/index.js both sit two levels below the repo root).
// Notification permission belongs to the bundle at this path, so scripts/build-notifier.mjs always rebuilds it here.
export function notifierAppPath(entry: string): string { return resolve(dirname(entry), '..', '..', 'build', 'notifier', 'AI Term.app'); }
type StatusPair = Pick<SessionInfo, 'status' | 'statusDetail'>;
export type Launcher = (file: string, args: readonly string[], done: (error: Error | null) => void) => void;
// Through Launch Services, so macOS treats the helper as its own app "AI Term" (identity and permission), not as a
// child of the daemon's terminal. -n starts a new instance even if one is still running, since only a fresh launch
// receives --args; -g keeps it from taking focus from the terminal. The spike saw it launch with the right bundle id.
const OPEN = '/usr/bin/open', LAUNCH_TIMEOUT_MS = 10_000;
// Codex status comes partly from terminal output an agent controls, so a flapping card must not launch helpers without
// bound: at most one per agent every 5 s and 3 per agent a minute, and 10 a minute in all. The per-agent minute keeps
// one flapping agent from using up the budget other agents' real alerts need. Waiting agents stay visible on the homepage.
const SESSION_GAP_MS = 5_000, WINDOW_MS = 60_000, WINDOW_LAUNCHES = 10, SESSION_WINDOW_LAUNCHES = 3;
const launchHelper: Launcher = (file, args, done) => {
  // open never hands its environment to the app; a fixed PATH keeps the daemon's environment out of it anyway.
  execFile(file, [...args], { timeout: LAUNCH_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } }, error => done(error));
};
const helperExists = (app: string): boolean => existsSync(join(app, NOTIFIER_EXECUTABLE));
// Notifications default to on and the setting is read at each notification, so /settings changes apply at once.
// The no-op callback makes the store skip a malformed key entry, as the server's store does, instead of failing the
// whole read (which would turn notifications off).
export function notificationsSetting(root: string): () => Promise<boolean> {
  const store = new SettingsStore(root, () => {});
  return async () => (await store.get()).notifications !== false;
}
export class Notifier {
  private launchFailed = false;
  private readonly logged = new Set<string>();
  private readonly sessionLaunches = new Map<string, number[]>();
  private recent: number[] = [];
  constructor(private readonly app: string | null, private readonly log: { error(text: string): void }, private readonly enabled: () => Promise<boolean>,
    private readonly launch: Launcher = launchHelper, private readonly exists: (app: string) => boolean = helperExists, private readonly now: () => number = Date.now,private readonly authorization=new NotificationPermission(app,text=>this.once(text))) {}
  start():void{this.authorization.start();}
  close():void{this.authorization.close();}
  permission(){return this.authorization.value();}
  refreshPermission(){return this.authorization.refresh();}
  state(): NotifierState { return this.launchFailed ? 'launch failed' : !this.app || !this.exists(this.app) ? 'not built' : 'ready'; }
  // Called on every status change. It never throws and never waits: the setting is read and the helper launched in the background.
  transition(session: SessionInfo, previous: StatusPair, next: StatusPair, attached: boolean): void {
    const alert = notificationFor(previous, next, attached, true); if (!alert) return;
    const body = notificationBody(session.title, alert), id = session.id;
    void this.enabled().then(on => { if (on) this.send(id, body); }, () => this.once('Notification settings unreadable'));
  }
  private send(sessionId: string, body: string): void {
    if(this.permission()==='denied'){this.once('Notifications blocked by macOS permission');return;}
    if (!this.app || !this.exists(this.app)) { this.once('Notifier helper not built'); return; }
    if (!this.allowed(sessionId)) { this.once('Notifications rate limited'); return; }
    const failed = () => { this.launchFailed = true; this.once('Notifier helper failed to launch'); };
    // Error details can carry the argv; only fixed text is logged.
    try { this.launch(OPEN, ['-n', '-g', '-a', this.app, '--args', '--session', sessionId, '--title', 'AI Term', '--body', body], error => { if (error) failed(); else this.launchFailed = false; }); }
    catch { failed(); }
  }
  private allowed(sessionId: string): boolean {
    const now = this.now();
    this.recent = this.recent.filter(at => now - at < WINDOW_MS);
    for (const [id, times] of this.sessionLaunches) { const kept = times.filter(at => now - at < WINDOW_MS); if (kept.length) this.sessionLaunches.set(id, kept); else this.sessionLaunches.delete(id); }
    const mine = this.sessionLaunches.get(sessionId) ?? [], last = mine.at(-1);
    if (last !== undefined && now - last < SESSION_GAP_MS || mine.length >= SESSION_WINDOW_LAUNCHES || this.recent.length >= WINDOW_LAUNCHES) return false;
    this.sessionLaunches.set(sessionId, [...mine, now]); this.recent.push(now); return true;
  }
  private once(text: string): void { if (this.logged.has(text)) return; this.logged.add(text); this.log.error(text); }
}

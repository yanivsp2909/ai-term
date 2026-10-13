import { dirname, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import type { NotifierState, SessionInfo } from '../shared/protocol.js';
import { notificationBody, notificationFor } from './notify-policy.js';
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
const launchHelper: Launcher = (file, args, done) => {
  // open never hands its environment to the app; a fixed PATH keeps the daemon's environment out of it anyway.
  execFile(file, [...args], { timeout: LAUNCH_TIMEOUT_MS, env: { PATH: '/usr/bin:/bin' } }, error => done(error));
};
const helperExists = (app: string): boolean => existsSync(join(app, NOTIFIER_EXECUTABLE));
export class Notifier {
  private failure: 'not built' | 'launch failed' | null = null;
  private readonly logged = new Set<string>();
  constructor(private readonly app: string | null, private readonly log: { error(text: string): void }, private readonly enabled: () => Promise<boolean>,
    private readonly launch: Launcher = launchHelper, private readonly exists: (app: string) => boolean = helperExists) {}
  state(): NotifierState { return this.failure === 'launch failed' ? 'launch failed' : !this.app || !this.exists(this.app) ? 'not built' : 'ready'; }
  // Called on every status change. It never throws and never waits: the setting is read and the helper launched in the background.
  transition(session: SessionInfo, previous: StatusPair, next: StatusPair, attached: boolean): void {
    const alert = notificationFor(previous, next, attached, true); if (!alert) return;
    const body = notificationBody(session.title, alert), id = session.id;
    void this.enabled().then(on => { if (on) this.send(id, body); }, () => this.once('Notification settings unreadable'));
  }
  private send(sessionId: string, body: string): void {
    if (!this.app || !this.exists(this.app)) { this.failure = 'not built'; this.once('Notifier helper not built'); return; }
    const failed = () => { this.failure = 'launch failed'; this.once('Notifier helper failed to launch'); };
    // Error details can carry the argv; only fixed text is logged.
    try { this.launch(OPEN, ['-n', '-g', '-a', this.app, '--args', '--session', sessionId, '--title', 'AI Term', '--body', body], error => { if (error) failed(); }); }
    catch { failed(); }
  }
  private once(text: string): void { if (this.logged.has(text)) return; this.logged.add(text); this.log.error(text); }
}

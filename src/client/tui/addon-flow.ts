import type { RequestBody } from '../connection.js';
import type { SessionInfo, SuccessResponse } from '../../shared/protocol.js';
import { isTaskUsage, isUUID, validateSession } from '../../shared/validate.js';
import { validateTestResult } from '../../shared/test-run.js';
import { validateAddonAsk, type AddonAsk, type AddonTarget } from '../../shared/addons.js';
import { parseAddonResult, validateAbView } from '../../shared/addon-results.js';
import { validateBrainPlan } from '../../shared/brain.js';
import { AddonPanel } from './addon-panel.js';
import { copyText } from './clipboard.js';
// A standup handed to the polish pass is cut at a line to fit the add-on argument limit (review: 60 agents overflowed it).
const POLISH_BYTES = 9000;
const fitLines = (text: string, bytes: number) => {
  const kept: string[] = []; let used = 0;
  for (const line of text.split('\n')) { used += Buffer.byteLength(line) + 1; if (used > bytes) break; kept.push(line); }
  // A first line too long by itself is cut, not dropped (follow-up review).
  return kept.length ? kept.join('\n') : Buffer.from(text).subarray(0, bytes).toString('utf8').replace(/\uFFFD+$/, '');
};
interface FlowOptions { request(body: RequestBody): Promise<SuccessResponse>; changed(): void; close(): void; started(response: SuccessResponse): Promise<void>; copy?(text: string): Promise<void> }
// One popup owns approval, the running state and the result. Closing it pauses polling, never stops the session.
// targets: empty for an add-on that runs no model (/bisect); its estimate is asked for with no target.
export class AddonFlow {
  readonly panel: AddonPanel;
  private ask?: AddonAsk; private session?: string; private timer?: ReturnType<typeof setTimeout>;
  private ended = false; private resultReady = false; private abRunning = false; private choice = 0;
  constructor(private name: string, private args: string, private cwd: string, private targets: AddonTarget[], private options: FlowOptions, private local = false) {
    this.panel = new AddonPanel(options.changed, () => { this.dispose(); options.close(); }, {
      start: unsandboxed => { void this.action(() => this.start(unsandboxed === true)); }, build: () => { void this.action(() => this.build()); },
      approve: () => { void this.action(async () => { if (!this.session) return; const response = await options.request({ kind: 'addons.approve', sessionId: this.session }); if (!response.savedPlan) throw new Error('Plan was not saved'); this.panel.setApproved(); }); },
      step: index => { void this.action(async () => { if (!this.session) return; await options.started(await options.request({ kind: 'addons.step', sessionId: this.session, step: index })); }); },
      copy: text => { void this.action(() => (options.copy ?? copyText)(text)); },
      choose: kind => { void this.action(() => this.choose(kind)); },
      apply: items => { void this.action(async () => { if (!this.session) return; const response = await options.request({ kind: 'addons.apply', sessionId: this.session, items }); const title = validateSession(response.session).title; await options.started(response); this.panel.setApplied(`✓ started ${title} in a worktree (Ask) · it is selected on the homepage · Esc closes`); }); },
      commit: () => { void this.action(async () => { if (!this.session) return; const sha = (await options.request({ kind: 'addons.commit', sessionId: this.session })).addonCommit; if (typeof sha !== 'string' || !/^[0-9a-f]{4,64}$/.test(sha)) throw new Error('The commit was not confirmed'); this.panel.setApplied(`✓ committed ${sha} in the agent's worktree · /pr publishes it when you're ready · Esc closes`); }); },
      // /standup m: the same popup becomes the standup-polish add-on, with its own estimate and y.
      polish: text => { void this.action(async () => { this.dispose(); this.ended = false; this.name = 'standup-polish'; this.args = fitLines(text, POLISH_BYTES); this.local = false; this.session = undefined; this.resultReady = false; await this.estimate(); }); },
      // o and s on a made file: the daemon opens it or copies it to Downloads; nothing happens until the key is pressed.
      file: (index, action) => { void this.action(async () => { if (!this.session) return; const saved = (await options.request({ kind: 'addons.file', sessionId: this.session, index, action })).addonSaved; this.panel.setApplied(action === 'open' ? '✓ opened with your default app · Esc closes' : typeof saved === 'string' ? `✓ saved a copy to ${saved} · Esc closes` : '✓ saved · Esc closes'); }); },
      ab: unsandboxed => { void this.action(async () => { if (!this.session) return; this.panel.setAb(validateAbView((await options.request({ kind: 'addons.ab', sessionId: this.session, unsandboxed })).addonAb)); this.abRunning = true; await this.poll(); }); },
    });
  }
  private async action(work: () => Promise<void>): Promise<void> { try { await work(); } catch (error) { this.panel.fail(error instanceof Error ? error.message : 'Add-on operation failed'); } this.options.changed(); }
  async open(): Promise<void> { this.ended = false; if (this.session) { if (!this.resultReady || this.abRunning) await this.poll(); } else await this.action(() => this.estimate()); }
  dispose(): void { this.ended = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  update(session: SessionInfo): void { if (session.id === this.session) { this.panel.setUsage(session.taskUsage ?? null); this.panel.setTests(session.tests ?? null); } }
  private async estimate(): Promise<void> {
    const target = this.local ? null : this.targets[this.choice]; if (target === undefined) throw new Error('No add-on engine available');
    this.ask = validateAddonAsk((await this.options.request({ kind: 'addons.plan', name: this.name, args: this.args, cwd: this.cwd, target })).addonAsk); if (this.ended) return;
    this.panel.setAsk(this.ask);
    // Free: no model and nothing run (AI Term's own records), so there is nothing to approve.
    if (this.ask.free) await this.start(false);
  }
  private async choose(kind: 'engine' | 'model'): Promise<void> {
    const current = this.targets[this.choice]; if (!current) return;
    const group = (t: AddonTarget) => `${t.engine}:${JSON.stringify(t.auth)}`;
    for (let n = 1; n <= this.targets.length; n++) { const index = (this.choice + n) % this.targets.length, t = this.targets[index]; if (t && (kind === 'engine' ? group(t) !== group(current) : group(t) === group(current))) { this.choice = index; break; } }
    await this.estimate();
  }
  private async build(): Promise<void> { const plan = validateBrainPlan((await this.options.request({ kind: 'brain.plan', cwd: this.cwd })).brainPlan); await this.options.request({ kind: 'brain.build', cwd: this.cwd, fingerprint: plan.fingerprint }); await this.estimate(); }
  private async start(unsandboxed: boolean): Promise<void> {
    if (!this.ask) return;
    const response = await this.options.request({ kind: 'addons.start', receipt: this.ask.receipt, ...unsandboxed ? { unsandboxed: true } : {} });
    // A local add-on has a run, not an agent: nothing to select on the homepage.
    if (response.addonRun !== undefined) { if (!isUUID(response.addonRun)) throw new Error('Invalid add-on run'); this.session = response.addonRun; }
    else { this.session = validateSession(response.session).id; await this.options.started(response); }
    await this.poll();
  }
  private async poll(): Promise<void> {
    if (!this.session || this.ended) return;
    try {
      const response = await this.options.request({ kind: 'addons.result', sessionId: this.session });
      if (this.ended) return;
      if (response.addonUsage !== undefined) { if (response.addonUsage !== null && !isTaskUsage(response.addonUsage)) throw new Error('Invalid add-on usage'); this.panel.setUsage(response.addonUsage); }
      if (response.addonTests !== undefined) this.panel.setTests(response.addonTests === null ? null : validateTestResult(response.addonTests));
      if (response.addonAb !== undefined && response.addonAb !== null) { const ab = validateAbView(response.addonAb); this.abRunning = ab.state === 'running'; this.panel.setAb(ab); }
      if (response.addonResult && !this.resultReady) { this.panel.setResult(parseAddonResult(JSON.stringify(response.addonResult), this.name, true)); this.resultReady = true; }
      this.options.changed();
      if (this.resultReady && !this.abRunning) return;
    } catch (error) { this.panel.wait(error instanceof Error ? error.message : 'Add-on result unavailable'); this.options.changed(); return; }
    this.timer = setTimeout(() => { void this.poll(); }, 1000); this.timer.unref();
  }
}

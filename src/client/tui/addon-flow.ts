import type { RequestBody } from '../connection.js';
import type { SuccessResponse } from '../../shared/protocol.js';
import { validateSession } from '../../shared/validate.js';
import { parseAddonResult, validateAddonAsk, type AddonAsk, type AddonTarget } from '../../shared/addons.js';
import { validateBrainPlan } from '../../shared/brain.js';
import { AddonPanel } from './addon-panel.js';
import { copyText } from './clipboard.js';
interface FlowOptions { request(body: RequestBody): Promise<SuccessResponse>; changed(): void; close(): void; started(response: SuccessResponse): Promise<void>; copy?(text: string): Promise<void> }
// One popup owns approval, the running state and the result. Closing it pauses polling, never stops the session.
export class AddonFlow {
  readonly panel: AddonPanel;
  private ask?: AddonAsk; private session?: string; private timer?: ReturnType<typeof setTimeout>;
  private ended = false; private resultReady = false; private choice = 0;
  constructor(private name: string, private args: string, private cwd: string, private targets: AddonTarget[], private options: FlowOptions) {
    this.panel = new AddonPanel(options.changed, () => { this.dispose(); options.close(); }, {
      start: () => { void this.action(() => this.start()); }, build: () => { void this.action(() => this.build()); },
      approve: () => { void this.action(async () => { if (!this.session) return; const response = await options.request({ kind: 'addons.approve', sessionId: this.session }); if (!response.savedPlan) throw new Error('Plan was not saved'); this.panel.setApproved(); }); },
      step: index => { void this.action(async () => { if (!this.session) return; await options.started(await options.request({ kind: 'addons.step', sessionId: this.session, step: index })); }); },
      copy: text => { void this.action(() => (options.copy ?? copyText)(text)); },
      choose: kind => { void this.action(() => this.choose(kind)); },
    });
  }
  private async action(work: () => Promise<void>): Promise<void> { try { await work(); } catch (error) { this.panel.wait(error instanceof Error ? error.message : 'Add-on operation failed'); } this.options.changed(); }
  async open(): Promise<void> { this.ended = false; if (this.session) { if (!this.resultReady) await this.poll(); } else await this.action(() => this.estimate()); }
  dispose(): void { this.ended = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
  private async estimate(): Promise<void> { const target = this.targets[this.choice]; if (!target) throw new Error('No add-on engine available'); this.ask = validateAddonAsk((await this.options.request({ kind: 'addons.plan', name: this.name, args: this.args, cwd: this.cwd, target })).addonAsk); if (!this.ended) this.panel.setAsk(this.ask); }
  private async choose(kind: 'engine' | 'model'): Promise<void> {
    const current = this.targets[this.choice]; if (!current) return;
    const group = (t: AddonTarget) => `${t.engine}:${JSON.stringify(t.auth)}`;
    for (let n = 1; n <= this.targets.length; n++) { const index = (this.choice + n) % this.targets.length, t = this.targets[index]; if (t && (kind === 'engine' ? group(t) !== group(current) : group(t) === group(current))) { this.choice = index; break; } }
    await this.estimate();
  }
  private async build(): Promise<void> { const plan = validateBrainPlan((await this.options.request({ kind: 'brain.plan', cwd: this.cwd })).brainPlan); await this.options.request({ kind: 'brain.build', cwd: this.cwd, fingerprint: plan.fingerprint }); await this.estimate(); }
  private async start(): Promise<void> { if (!this.ask) return; const response = await this.options.request({ kind: 'addons.start', receipt: this.ask.receipt }); this.session = validateSession(response.session).id; await this.options.started(response); await this.poll(); }
  private async poll(): Promise<void> {
    if (!this.session || this.ended) return;
    try {
      const response = await this.options.request({ kind: 'addons.result', sessionId: this.session });
      if (this.ended) return;
      if (response.addonResult) { this.panel.setResult(parseAddonResult(JSON.stringify(response.addonResult), this.name)); this.resultReady = true; this.options.changed(); return; }
    } catch (error) { this.panel.wait(error instanceof Error ? error.message : 'Add-on result unavailable'); this.options.changed(); return; }
    this.timer = setTimeout(() => { void this.poll(); }, 1000); this.timer.unref();
  }
}

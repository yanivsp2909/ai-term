import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { AddonAsk, AddonResult } from '../../shared/addons.js';
import type { TaskUsage } from '../../shared/protocol.js';
interface Actions { start(): void; build(): void; approve(): void; step(index: number): void; copy(text: string): void; choose(kind: 'engine' | 'model'): void }
export class AddonPanel {
  private panel: TextPanel; private ask?: AddonAsk; private result?: AddonResult;
  private chunk = 0; private selected = 0; private approved = false; private busy = false;
  private usage: TaskUsage | null = null;
  lines: string[] = [];
  constructor(changed: () => void, private close: () => void, private actions: Actions) { this.panel = new TextPanel('Add-on', changed, close); this.wait('Preparing the estimate…'); }
  private show(lines: string[]): void { this.lines = lines; this.panel.set(lines.map(text => ({ text, tone: 'ink-2' as const }))); }
  wait(message = 'Running in Ask mode · close this popup to inspect or attach the agent.'): void { this.busy = true; this.show([message, 'Esc closes']); }
  setAsk(ask: AddonAsk): void { this.ask = ask; this.busy = false; this.result = undefined; this.show([
    `/${ask.name} · ${ask.summary}`, `${ask.target.engine} · ${ask.target.model ?? 'CLI default'} · ${ask.authLabel ?? (ask.subscription ? 'subscription' : 'API key')} · Ask`,
    `folder: ${ask.cwd}`, `${ask.readOnly ? 'read-only' : 'can edit'} · worktree ${ask.worktree ? 'yes' : 'no'}`,
    `brain: ${ask.brain} · ${ask.brainNeed}`, ...(ask.brainNeed !== 'none' && ask.brain !== 'fresh' ? ['b builds the free local /brain first: folders, entry points and import ranks save repeated exploration.'] : []),
    `uses: ${ask.files.join(', ') || 'prompt only'}`, ...this.estimate(ask),
    'e engine/key · m model · y starts · Enter does nothing · Esc cancels',
  ]); }
  private estimate(ask: AddonAsk): string[] { return [`estimated tokens: ${ask.inputTokens.low}–${ask.inputTokens.high} in · ${ask.outputTokens.low}–${ask.outputTokens.high} out (1–8 inspection rounds; not a cap)`, ask.subscription ? 'price: $0 API charge · uses subscription limits' : ask.priceUsd ? `estimated price: $${ask.priceUsd.low.toFixed(4)}–$${ask.priceUsd.high.toFixed(4)}` : 'price unknown · set this model’s price before starting']; }
  setResult(result: AddonResult): void { this.result = result; this.busy = false; this.chunk = 0; this.panel.resetScroll(); this.refresh(); }
  setApproved(): void { this.approved = true; this.busy = false; this.refresh(); }
  setUsage(usage:TaskUsage|null):void { this.usage=usage;this.refresh(); }
  private refresh(): void {
    const r = this.result; if (!r) return;
    const actual=this.usage?`actual: ${this.usage.tokens} tokens · ${this.usage.unknownPrice?'price unknown':this.usage.costUsd===null?'subscription limits':`$${this.usage.costUsd.toFixed(4)}`}`:'actual: not reported by the engine';
    if (r.kind === 'plan') {
      const start=Math.max(0,Math.min(this.selected-1,r.steps.length-3));
      this.show([r.title,this.approved?'✓ plan saved · ↑↓ step · s starts this step in Ask mode in a worktree · Esc closes':'a approves and saves the plan · nothing starts · Esc closes',actual,
        ...(this.ask?[`${this.ask.target.engine} · ${this.ask.target.model??'CLI default'} · ${this.ask.cwd}`, ...this.estimate(this.ask)]:[]),
        ...r.steps.slice(start,start+3).map((s,i)=>`${start+i===this.selected?'›':' '} ${start+i+1}. ${s.title}`),`Selected step ${this.selected+1}/${r.steps.length}:`,...(r.steps[this.selected]?.prompt.split('\n')??[])]);
    }
    else if (r.kind === 'prompt') this.show([actual,...r.issues.map(s => `• ${s}`), ...r.diff.split('\n'), 'c copies the improved diff · Esc closes']);
    else if (this.chunk >= r.chunks.length) this.show([actual,'Recap · Esc closes', ...r.recap]);
    else this.show([actual,...(this.chunk === 0 ? [r.why, ...r.diagram, ''] : []), ...r.chunks[this.chunk] ?? [], `Space next · ${this.chunk + 1}/${r.chunks.length} · Esc closes`]);
  }
  key(key: string): void {
    if (key === 'escape') { this.close(); return; } if (this.busy || key === 'enter') return;
    if (!this.result && this.ask) {
      if (key === 'y' && (this.ask.subscription || this.ask.priceUsd)) { this.wait(); this.actions.start(); }
      else if (key === 'b' && this.ask.brainNeed !== 'none' && this.ask.brain !== 'fresh') { this.wait('Building the free local brain…'); this.actions.build(); }
      else if (key === 'e' || key === 'm') { this.wait('Updating the estimate…'); this.actions.choose(key === 'e' ? 'engine' : 'model'); }
      return;
    }
    const r = this.result;
    if (r?.kind === 'plan') {
      if (key === 'up' || key === 'down') { this.selected = Math.max(0, Math.min(r.steps.length - 1, this.selected + (key === 'up' ? -1 : 1))); this.panel.resetScroll();this.refresh(); }
      else if (key === 'a' && !this.approved) { this.busy = true; this.actions.approve(); }
      else if (key === 's' && this.approved) this.actions.step(this.selected);
      else this.panel.key(key);
    } else if (r?.kind === 'prompt' && key === 'c') this.actions.copy(r.diff);
    else if (r?.kind === 'explain' && key === 'space') { this.chunk = Math.min(r.chunks.length, this.chunk + 1); this.panel.resetScroll();this.refresh(); }
    else this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

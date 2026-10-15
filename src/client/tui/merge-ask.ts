import type { MergePlan, PrPlan } from '../../shared/merge.js';
import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { Line } from './worktree-question.js';

// v0.7.3 /merge and /pr: the exact commands and the secret scan's hits (file, line, kind; never the value) before
// anything runs. No hits: y runs, n or Esc keeps everything. Hits: only `override` typed letter by letter, then ⏎, goes
// on (a paste never reaches this popup), once; Esc keeps everything.
export type MergeAskPlan = { kind: 'merge'; plan: MergePlan } | { kind: 'pr'; plan: PrPlan };
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
export function mergeLines(ask: MergeAskPlan, typed: string): Line[] {
  const { plan } = ask, head = ask.kind === 'merge' ? `Merge ${plan.branch} → ${plan.base} in your checkout · ${plural(ask.plan.ahead, 'commit')}` : `Open a pull request: ${plan.branch} → ${plan.base} · ${ask.plan.remote}`;
  const scan: Line[] = plan.scanOff ? [{ text: 'secret scan: off (/settings v)', tone: 'ink-3' }] : plan.hits.length
    ? [{ text: `secret scan: ${plan.moreHits ? `more than ${plan.hits.length} possible secrets` : plural(plan.hits.length, 'possible secret')}`, tone: 'status-error' }, ...plan.hits.map(hit => ({ text: `⚠ ${hit.file}:${hit.line} · ${hit.kind} · ${hit.length} characters hidden`, tone: 'status-error' as const })), ...(plan.moreHits ? [{ text: '… and more (the first 100 are shown)', tone: 'status-error' as const }] : [])]
    : [{ text: 'secret scan: nothing found', tone: 'ink-2' }];
  const verb = ask.kind === 'merge' ? 'merge' : 'open it';
  const footer: Line[] = plan.hits.length
    ? [{ text: `type override and ⏎ to ${verb} anyway · Esc keeps everything`, tone: 'ink-3' }, { text: `override: ${typed}█`, tone: 'ink' }]
    : [{ text: `y runs these · n or Esc keeps everything`, tone: 'ink-3' }];
  return [{ text: head, tone: 'ink' }, ...plan.commands.map(command => ({ text: `$ ${command}`, tone: 'ink-2' as const })), ...(ask.kind === 'merge' ? [{ text: 'never a checkout, reset, stash or force; a conflict is undone at once', tone: 'ink-3' as const }] : []), ...scan, ...footer];
}
export class MergeAsk {
  private readonly panel: TextPanel;
  private typed = '';
  constructor(private readonly ask: MergeAskPlan, changed: () => void, private readonly close: () => void, private readonly run: (override: boolean) => void) {
    this.panel = new TextPanel(ask.kind === 'merge' ? 'Merge' : 'Pull request', changed, close);
    this.panel.set(mergeLines(ask, ''));
  }
  key(key: string): void {
    if (key === 'escape') { this.close(); return; }
    if (!this.ask.plan.hits.length) {
      if (key === 'y') { this.close(); this.run(false); return; }
      if (key === 'n') { this.close(); return; }
      this.panel.key(key); return;
    }
    // Anything but the exact word clears what was typed, so it has to be typed whole, on purpose.
    if (key === 'enter') { if (this.typed === 'override') { this.close(); this.run(true); return; } this.typed = ''; this.panel.set(mergeLines(this.ask, '')); return; }
    if (key === 'backspace') this.typed = this.typed.slice(0, -1);
    else if (/^[a-z]$/.test(key) && this.typed.length < 8) this.typed += key;
    else { this.panel.key(key); return; }
    this.panel.set(mergeLines(this.ask, this.typed));
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

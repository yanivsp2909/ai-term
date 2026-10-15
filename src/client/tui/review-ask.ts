import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { compactTokens } from './usage-panel.js';
import type { Line } from './worktree-question.js';
import type { ReviewPlan, ReviewResult } from '../../shared/review.js';

// v0.7.4 /review (D49): what the reviewer reads and what each model would cost, before anything is sent. ↑↓ picks a
// model, ⏎ runs it (a typed key, never a paste), Esc cancels. The result opens in its own popup.
const money = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
const WINDOW = 12;
export function reviewLines(plan: ReviewPlan, choice: number): Line[] {
  const start = Math.max(0, Math.min(choice - Math.floor(WINDOW / 2), plan.models.length - WINDOW));
  return [
    { text: `Review ${plan.title} · ${plan.files} file${plan.files === 1 ? '' : 's'} +${plan.added} −${plan.removed}${plan.cut ? ' · cut to fit' : ''}`, tone: 'ink' },
    { text: 'one request: the diff, secrets removed, goes to the model you pick', tone: 'ink-3' },
    { text: `estimated ${compactTokens(plan.inputTokens.low)}–${compactTokens(plan.inputTokens.high)} in · ${compactTokens(plan.outputTokens.low)}–${compactTokens(plan.outputTokens.high)} out`, tone: 'ink-3' },
    ...plan.models.slice(start, start + WINDOW).map((m, i) => ({ text: `${start + i === choice ? '›' : ' '} ${m.model} · key ····${m.last4} · ${money(m.priceUsd.low)}–${money(m.priceUsd.high)}`, tone: start + i === choice ? 'ink' as const : 'ink-2' as const })),
    ...(plan.models.length > WINDOW ? [{ text: `${plan.models.length} models · ↑↓ for more`, tone: 'ink-3' as const }] : []),
    { text: '↑↓ picks · ⏎ reviews · Esc cancels', tone: 'ink-3' },
  ];
}
export class ReviewAsk {
  private readonly panel: TextPanel;
  private choice: number;
  constructor(private readonly plan: ReviewPlan, changed: () => void, private readonly close: () => void, private readonly run: (model: ReviewPlan['models'][number]) => void) {
    this.choice = Math.min(plan.selected, Math.max(0, plan.models.length - 1));
    this.panel = new TextPanel('Review', changed, close);
    this.panel.set(reviewLines(plan, this.choice));
  }
  key(key: string): void {
    if (key === 'up' || key === 'down') { this.choice = Math.max(0, Math.min(this.plan.models.length - 1, this.choice + (key === 'up' ? -1 : 1))); this.panel.set(reviewLines(this.plan, this.choice)); return; }
    if (key === 'enter') { const model = this.plan.models[this.choice]; this.close(); if (model) this.run(model); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}
export function reviewResultLines(result: ReviewResult): Line[] {
  const { high, medium, low } = result.counts;
  return [
    { text: `${high + medium + low ? `${high} high · ${medium} medium · ${low} low` : 'no issues found'} · ${compactTokens(result.inputTokens)} in · ${compactTokens(result.outputTokens)} out · ${result.costUsd === null ? 'price ?' : money(result.costUsd)}`, tone: high ? 'status-error' : medium ? 'status-waiting' : 'ink-3' },
    ...result.text.split('\n').map(text => ({ text, tone: /^\W*HIGH\b/i.test(text) ? 'status-error' as const : /^\W*MEDIUM\b/i.test(text) ? 'status-waiting' as const : 'ink-2' as const })),
  ];
}
// The card's review part: what the last review found, or that one runs or failed.
export function reviewCardText(review: NonNullable<import('../../shared/protocol.js').SessionInfo['review']>): string {
  if (review.state === 'running') return '◐ reviewing';
  if (review.state === 'failed') return '✗ review failed';
  const parts = ([['high', review.high], ['medium', review.medium], ['low', review.low]] as const).filter(([, n]) => n > 0).map(([name, n]) => `${n} ${name}`);
  return `review: ${parts.length ? parts.join(', ') : 'no issues'}`;
}

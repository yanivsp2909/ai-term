import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { compactTokens } from './usage-panel.js';
import { engineLabel } from '../../shared/models.js';
import type { HandoffPlan, HandoffSummary } from '../../shared/handoff.js';
import type { Line } from './worktree-question.js';
import { OWN_ACCOUNT } from '../../shared/accounts.js';

// D49 for /handoff (v0.6.3): what runs, who writes the note, the token range and the price range, before anything is
// spent. ⏎ runs it (a typed key, never a paste), Esc cancels.
const money = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
export function handoffLines(plan: HandoffPlan): Line[] {
  const writer = plan.writer.kind === 'key' ? `summary by ${plan.writer.model} · key ····${plan.writer.last4} · it reads the end of ${plan.source}'s screen` : `summary written by ${plan.source} itself, as its next reply`;
  const tokens = `${compactTokens(plan.inputTokens.low)}–${compactTokens(plan.inputTokens.high)} in · ${compactTokens(plan.outputTokens.low)}–${compactTokens(plan.outputTokens.high)} out`;
  const price = plan.priceUsd ? `${money(plan.priceUsd.low)}–${money(plan.priceUsd.high)}` : plan.subscription ? "uses your plan's limits" : 'price ?';
  return [
    { text: `Hand off ${plan.source} → ${engineLabel(plan.engine)}`, tone: 'ink' },
    { text: writer, tone: 'ink-2' },
    { text: `estimated ${tokens} · ${price}`, tone: 'ink-2' },
    { text: `then ${engineLabel(plan.engine)} starts on ${plan.account ? `account ${plan.account}` : 'your own login'} in the same folder, Ask, with the note as its first message; ${plan.source} stops once it runs`, tone: 'ink-3' },
    { text: '⏎ hands off · Esc cancels', tone: 'ink-3' },
  ];
}
// ⏎ runs exactly what the ask showed: its writer and its account (own when none), so a default account changed in the
// meantime can't move the new agent (v0.6 gate).
export function handoffRequest(plan: HandoffPlan, sessionId: string): { kind: 'sessions.handoff'; sessionId: string; engine: HandoffPlan['engine']; writer: HandoffPlan['writer']; account: string } {
  return { kind: 'sessions.handoff', sessionId, engine: plan.engine, writer: plan.writer, account: plan.account ?? OWN_ACCOUNT };
}
export function handoffDone(from: string, to: string, summary: HandoffSummary | null): string {
  return `✓ handed off ${from} → ${to}${summary ? ` · summary ${compactTokens(summary.inputTokens)} in · ${compactTokens(summary.outputTokens)} out · ${summary.costUsd === null ? 'price ?' : money(summary.costUsd)}` : ''}`;
}
export class HandoffAsk {
  private readonly panel: TextPanel;
  constructor(plan: HandoffPlan, changed: () => void, private readonly close: () => void, private readonly run: () => void) {
    this.panel = new TextPanel('Handoff', changed, close);
    this.panel.set(handoffLines(plan));
  }
  key(key: string): void { if (key === 'enter') { this.close(); this.run(); return; } this.panel.key(key); }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

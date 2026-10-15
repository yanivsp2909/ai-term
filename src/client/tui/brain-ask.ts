import { basename } from 'node:path';
import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { compactTokens } from './usage-panel.js';
import type { Line } from './worktree-question.js';
import { brainAge, type BrainPlan } from '../../shared/brain.js';

// v1.0.2 /brain (D49): what the map covers and what a model pass would cost, before anything is built. The first row
// builds the free local map; the others add summaries by that model. ⏎ builds the chosen row, a turns "agents get it"
// on or off (D55, on), Esc cancels.
const money = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
const WINDOW = 10;
export function brainLines(plan: BrainPlan, choice: number, now = Date.now()): Line[] {
  const skipped = [plan.skipped.binary ? `${plan.skipped.binary} binary` : '', plan.skipped.large ? `${plan.skipped.large} over 256 KB` : '', plan.skipped.env ? `${plan.skipped.env} .env` : '', plan.skipped.secret ? `${plan.skipped.secret} flagged by the secret scan` : ''].filter(Boolean);
  const rows = ['local map only · free', ...(plan.summarize ? plan.models : []).map(m => `${m.model} · key ····${m.last4} · ${money(m.priceUsd.low)}–${money(m.priceUsd.high)}`)];
  const start = Math.max(0, Math.min(choice - Math.floor(WINDOW / 2), rows.length - WINDOW));
  return [
    { text: `Brain · ${basename(plan.repo)} · ${plan.files} file${plan.files === 1 ? '' : 's'} · ${plan.builtAt ? `${plan.changed} changed, ${plan.removed} removed since the last map (${brainAge(plan.builtAt, now)})` : 'first map'}`, tone: 'ink' },
    { text: `skipped: ${skipped.length ? skipped.join(', ') : 'none'}; ignored files aren't read`, tone: 'ink-3' },
    { text: 'local pass: free, no model · the tree, imports and exports (TS/JS, Python), who imports whom', tone: 'ink-3' },
    { text: plan.summarize ? `model pass: a short summary of ${plan.summarize} module${plan.summarize === 1 ? '' : 's'} and the main design decisions, secrets removed · estimated ${compactTokens(plan.inputTokens.low)}–${compactTokens(plan.inputTokens.high)} in · ${compactTokens(plan.outputTokens.low)}–${compactTokens(plan.outputTokens.high)} out` : 'model pass: nothing new to summarize', tone: 'ink-3' },
    ...rows.slice(start, start + WINDOW).map((text, i) => ({ text: `${start + i === choice ? '›' : ' '} ${text}`, tone: start + i === choice ? 'ink' as const : 'ink-2' as const })),
    ...rows.length > WINDOW ? [{ text: `${rows.length - 1} models · ↑↓ for more`, tone: 'ink-3' as const }] : [],
    { text: `agents get it: ${plan.agents ? 'on' : 'off'} · new agents in this repository read it at start`, tone: 'ink-3' },
    { text: '↑↓ choose · ⏎ builds · a agents on/off · Esc cancels', tone: 'ink-3' },
  ];
}
export class BrainAsk {
  private readonly panel: TextPanel;
  private choice: number;
  constructor(private plan: BrainPlan, changed: () => void, private readonly close: () => void, private readonly build: (model: BrainPlan['models'][number] | null) => void, private readonly agents: (on: boolean) => void) {
    // The free local map is the first choice; a model is one ↓ away.
    this.choice = 0;
    this.panel = new TextPanel('Brain', changed, close);
    this.panel.set(brainLines(plan, this.choice));
  }
  get rows(): number { return this.plan.summarize ? 1 + this.plan.models.length : 1; }
  key(key: string): void {
    if (key === 'up' || key === 'down') { this.choice = Math.max(0, Math.min(this.rows - 1, this.choice + (key === 'up' ? -1 : 1))); this.panel.set(brainLines(this.plan, this.choice)); return; }
    if (key === 'a') { this.plan = { ...this.plan, agents: !this.plan.agents }; this.agents(this.plan.agents); this.panel.set(brainLines(this.plan, this.choice)); return; }
    if (key === 'enter') { const model = this.choice === 0 ? null : this.plan.models[this.choice - 1] ?? null; this.close(); this.build(model); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

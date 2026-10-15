import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { compactTokens } from './usage-panel.js';
import type { Line } from './worktree-question.js';
import { engineLabel, type ModelChoice } from '../../shared/models.js';
import type { ForkPlan, ForkTarget } from '../../shared/fork.js';
import type { AuthRef, SessionInfo } from '../../shared/protocol.js';

// v0.7.4 /fork (D49): what starts and roughly what it costs, before anything runs. ⏎ forks (a typed key), Esc cancels.
const money = (usd: number): string => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`;
export function forkLines(plan: ForkPlan): Line[] {
  const estimate = plan.tokens ? `estimated ${compactTokens(plan.tokens.low)}–${compactTokens(plan.tokens.high)} tokens (from ${plan.source}'s run so far)` : 'tokens depend on the work (no run to compare yet)';
  const price = plan.priceUsd ? `${money(plan.priceUsd.low)}–${money(plan.priceUsd.high)}` : plan.subscription ? "uses your plan's limits" : 'price ?; budgets and caps still apply';
  return [
    { text: `Fork ${plan.source} → ${plan.model ?? 'CLI default'} · ${engineLabel(plan.engine)} · ${plan.authLabel}`, tone: 'ink' },
    { text: `first message: ${plan.firstMessage}`, tone: 'ink-2' },
    { text: `from the same start (${plan.base}), in its own worktree, Ask`, tone: 'ink-3' },
    { text: `${estimate} · ${price}`, tone: 'ink-2' },
    { text: '⏎ forks · Esc cancels', tone: 'ink-3' },
  ];
}
export class ForkAsk {
  private readonly panel: TextPanel;
  constructor(plan: ForkPlan, changed: () => void, private readonly close: () => void, private readonly run: () => void) {
    this.panel = new TextPanel('Fork', changed, close);
    this.panel.set(forkLines(plan));
  }
  key(key: string): void { if (key === 'enter') { this.close(); this.run(); return; } this.panel.key(key); }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}
// `/fork <agent> <model>`: the model as /model lists it. Several logins offer it: the source's own engine and login win,
// then its engine; still several: refused, never guessed.
export function forkTarget(source: SessionInfo, model: string, choices: readonly ModelChoice[]): ForkTarget | string {
  const named = choices.filter(c => c.model !== null && c.label === model);
  if (!named.length) return `${model} isn't a model /model offers · /fork <agent> <model>`;
  const own: AuthRef | undefined = source.auth.kind === 'key' ? { kind: 'key', keyId: source.auth.keyId } : undefined;
  const sameLogin = named.filter(c => c.engine === source.engine && (own ? c.auth?.kind === 'key' && c.auth.keyId === own.keyId : c.auth?.kind === 'account'));
  const sameEngine = named.filter(c => c.engine === source.engine);
  const pick = sameLogin.length === 1 ? sameLogin[0] : sameEngine.length === 1 ? sameEngine[0] : named.length === 1 ? named[0] : undefined;
  if (!pick?.auth) return `${model} runs on more than one login · pick it in /model, then start the agent there`;
  // An account agent forked onto the same engine keeps its account; another engine starts on its own login.
  const auth: AuthRef = pick.auth.kind === 'account' && pick.engine === source.engine && source.auth.kind === 'account' && source.auth.profile ? { kind: 'account', profile: source.auth.profile } : pick.auth;
  return { engine: pick.engine, model: pick.model, auth, ...(pick.engine === source.engine && source.effort !== undefined && source.effort !== null ? { effort: source.effort } : {}) };
}

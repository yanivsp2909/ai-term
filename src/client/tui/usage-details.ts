import type { Budgets, SessionInfo, UsagePeriod, UsageSummary } from '../../shared/protocol.js';
import { compactTokens } from './usage-panel.js';
import type { Line } from './worktree-question.js';

const PERIODS = [['today', 'daily'], ['week', 'weekly'], ['month', 'monthly']] as const;
function amounts(total: Pick<UsagePeriod, 'costUsd' | 'tokens' | 'cachedTokens' | 'unknownPrice'>): string {
  const cached = total.cachedTokens ? ` (${compactTokens(total.cachedTokens)} cached)` : '';
  return `≈ $${total.costUsd.toFixed(2)} · ${compactTokens(total.tokens)} tokens${cached}${total.unknownPrice ? ' · price ?' : ''}`;
}
// /usage and u (design.md: Usage details): each period, then its providers, then (v0.6.1, cost per task) each agent's own
// total since it started: dollars for API-key agents, tokens for subscriptions. By-model breakdowns aren't shown.
export function usageDetailLines(usage: UsageSummary, budgets: Budgets, sessions: readonly SessionInfo[] = [], taskCost = true): Line[] {
  const lines: Line[] = [];
  for (const [period, budget] of PERIODS) {
    const total = usage[period], limit = budgets[budget], over = limit !== null && total.costUsd > limit;
    lines.push({ text: `${period.toUpperCase()}  ${amounts(total)} · budget ${limit === null ? 'none' : `$${limit}`}${over ? ' · ! over budget' : ''}`, tone: over ? 'status-waiting' : 'ink' });
    if (!total.providers.length) lines.push({ text: '  no API-key usage', tone: 'ink-3' });
    for (const provider of total.providers) lines.push({ text: `  ${provider.provider}  ${amounts(provider)}`, tone: 'ink-2' });
    lines.push({ text: '', tone: 'ink-3' });
  }
  const tasks = taskCost ? sessions.filter(s => s.taskUsage && (s.taskUsage.tokens > 0 || (s.taskUsage.costUsd ?? 0) > 0)) : [];
  if (tasks.length) {
    lines.push({ text: 'BY AGENT (start to now)', tone: 'ink' });
    for (const s of tasks) {
      const t = s.taskUsage, tokens = compactTokens(t?.tokens ?? 0);
      lines.push({ text: t?.costUsd === null ? `  ${s.title}  ${tokens} tokens · plan limits, not dollars` : `  ${s.title}  ≈ $${(t?.costUsd ?? 0).toFixed(2)} · ${tokens} tokens${t?.unknownPrice ? ' · price ?' : ''}`, tone: 'ink-2' });
    }
    lines.push({ text: '', tone: 'ink-3' });
  }
  lines.push({ text: "Periods: API-key sessions only; subscriptions aren't counted. ≈ marks estimates · b sets budgets", tone: 'ink-3' });
  return lines;
}

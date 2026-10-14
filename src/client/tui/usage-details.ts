import type { Budgets, UsagePeriod, UsageSummary } from '../../shared/protocol.js';
import { compactTokens } from './usage-panel.js';
import type { Line } from './worktree-question.js';

const PERIODS = [['today', 'daily'], ['week', 'weekly'], ['month', 'monthly']] as const;
function amounts(total: Pick<UsagePeriod, 'costUsd' | 'tokens' | 'cachedTokens' | 'unknownPrice'>): string {
  const cached = total.cachedTokens ? ` (${compactTokens(total.cachedTokens)} cached)` : '';
  return `≈ $${total.costUsd.toFixed(2)} · ${compactTokens(total.tokens)} tokens${cached}${total.unknownPrice ? ' · price ?' : ''}`;
}
// /usage and u (design.md: Usage details): each period, then its providers. The daemon's summary is by provider only,
// so by-model and by-agent breakdowns aren't shown.
export function usageDetailLines(usage: UsageSummary, budgets: Budgets): Line[] {
  const lines: Line[] = [];
  for (const [period, budget] of PERIODS) {
    const total = usage[period], limit = budgets[budget], over = limit !== null && total.costUsd > limit;
    lines.push({ text: `${period.toUpperCase()}  ${amounts(total)} · budget ${limit === null ? 'none' : `$${limit}`}${over ? ' · ! over budget' : ''}`, tone: over ? 'status-waiting' : 'ink' });
    if (!total.providers.length) lines.push({ text: '  no API-key usage', tone: 'ink-3' });
    for (const provider of total.providers) lines.push({ text: `  ${provider.provider}  ${amounts(provider)}`, tone: 'ink-2' });
    lines.push({ text: '', tone: 'ink-3' });
  }
  lines.push({ text: "API-key sessions only; subscriptions aren't counted. ≈ marks estimates · b sets budgets", tone: 'ink-3' });
  return lines;
}

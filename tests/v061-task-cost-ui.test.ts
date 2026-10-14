import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { cardText, taskCostText } from '../src/client/tui/agent-card.js';
import { usageDetailLines } from '../src/client/tui/usage-details.js';
import { validateSession, validateSettings, validateSettingsPatch } from '../src/shared/validate.js';
import type { SessionInfo, UsageSummary } from '../src/shared/protocol.js';

// v0.6.1 cost per task (D55, on by default): each agent's own total, on its card and in /usage.
const now = '2026-10-15T00:00:00.000Z';
const session = (over: Partial<SessionInfo> = {}): SessionInfo => ({ id: randomUUID(), title: 'fix-login', engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId: randomUUID(), provider: 'foundry', keyLabel: 'narvis', last4: 'abcd' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, ...over });
const empty = { costUsd: 0, tokens: 0, cachedTokens: 0, unknownPrice: false, providers: [] };
const summary: UsageSummary = { today: { ...empty, costUsd: 0.42, tokens: 1500 }, week: empty, month: empty };

it('a task total reads in dollars for keys and in tokens for subscriptions', () => {
  expect(taskCostText({ tokens: 1500, costUsd: 0.4234 })).toBe('$0.42');
  expect(taskCostText({ tokens: 10, costUsd: 0.0004 })).toBe('<$0.01');
  expect(taskCostText({ tokens: 2000, costUsd: 0.3, unknownPrice: true })).toBe('$0.30+?');
  expect(taskCostText({ tokens: 12_345, costUsd: null })).toBe('12.3K tok');
  expect(taskCostText({ tokens: 0, costUsd: null })).toBeNull();
  expect(taskCostText(undefined)).toBeNull();
});

it('the card shows the task total after its auth, unless /settings turned it off', () => {
  const keyed = session({ taskUsage: { tokens: 1500, costUsd: 0.42 } }), sub = session({ engine: 'claude-code', model: 'sonnet', auth: { kind: 'account' }, authMethod: 'subscription', taskUsage: { tokens: 12_345, costUsd: null } });
  expect(cardText(keyed, Date.parse(now), 40).auth).toBe('API key ····abcd · $0.42');
  expect(cardText(sub, Date.parse(now), 40).auth).toBe('own login · sub · 12.3K tok');
  expect(cardText(keyed, Date.parse(now), 40, { taskCost: false }).auth).toBe('API key ····abcd');
  expect(cardText(session(), Date.parse(now), 40).auth).toBe('API key ····abcd');
});

it('/usage lists each agent\'s total under the periods, subscriptions in tokens', () => {
  const lines = usageDetailLines(summary, { daily: null, weekly: null, monthly: null }, [session({ title: 'fix-login', taskUsage: { tokens: 1500, costUsd: 0.42 } }), session({ title: 'docs', engine: 'codex', model: null, auth: { kind: 'account' }, authMethod: 'subscription', taskUsage: { tokens: 9000, costUsd: null } }), session({ title: 'idle' })]).map(line => line.text);
  expect(lines).toContain('BY AGENT (start to now)');
  expect(lines).toContain('  fix-login  ≈ $0.42 · 1.5K tokens');
  expect(lines).toContain('  docs  9.0K tokens · plan limits, not dollars');
  expect(lines.some(line => line.includes('idle'))).toBe(false);
  expect(usageDetailLines(summary, { daily: null, weekly: null, monthly: null }, [session({ taskUsage: { tokens: 1, costUsd: 1 } })], false).map(l => l.text)).not.toContain('BY AGENT (start to now)');
});

it('the record and the setting are validated', () => {
  expect(validateSession(session({ taskUsage: { tokens: 1, costUsd: null } })).taskUsage).toEqual({ tokens: 1, costUsd: null });
  for (const bad of [{ tokens: -1, costUsd: 0 }, { tokens: 1 }, { tokens: 1, costUsd: 'x' }, { tokens: 1, costUsd: 0, extra: true }, { tokens: 1, costUsd: 0, unknownPrice: false }]) expect(() => validateSession(session({ taskUsage: bad as never }))).toThrow();
  expect(validateSettings({ theme: 'graphite', taskCost: false }).taskCost).toBe(false);
  expect(() => validateSettingsPatch({ taskCost: 'yes' }, true)).toThrow();
  expect(validateSettingsPatch({ taskCost: true }, true)).toEqual({ taskCost: true });
});

import type { AgentFacts } from '../../src/shared/agent-facts.js';
// Facts as the daemon would answer them, for agent tests with no daemon: no limits unless a test sets them.
export function stubFacts(overrides: Partial<AgentFacts> = {}): AgentFacts {
  return { model: 'm1', wire: null, context: null, output: null, price: null, spent: { day: 0, week: 0, month: 0 }, budgets: { daily: null, weekly: null, monthly: null }, caps: { turns: null, spendUsd: null }, contextWarning: true, ...overrides };
}

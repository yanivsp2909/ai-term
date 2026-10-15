import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { Line } from './worktree-question.js';
import { testCommandText, type TestPlan } from '../../shared/test-run.js';

// v0.7.4 /test: what runs and where before it does, and which test setup files the agent changed (those run with the
// tests). y runs it (a typed key: a paste never reaches this popup), n or Esc runs nothing.
// B26: whether it runs in the sandbox, and the project's 127.0.0.1 switch (l), off by default.
export function testLines(plan: TestPlan): Line[] {
  return [
    { text: `Run tests for ${plan.title}`, tone: 'ink' },
    { text: `$ ${testCommandText(plan.command)}`, tone: 'ink-2' },
    { text: `in ${plan.cwd} · no API keys in its env · 10 min limit`, tone: 'ink-3' },
    ...(plan.sandbox ? [{ text: 'sandbox: writes only in this worktree and a temp folder · no network · no reads of ~/.ssh, ~/.aws and other key folders', tone: 'ink-3' as const },
      { text: plan.loopback ? '127.0.0.1: on for this project · l turns it off' : '127.0.0.1: off · l allows it for this project (any local service, like a dev database)', tone: 'ink-3' as const }]
      : [{ text: "no sandbox: it runs with your user's rights (files, network, your keys' folders)", tone: 'status-error' as const }]),
    ...(plan.changed.length ? [{ text: 'this agent changed these test setup files; running the tests runs them', tone: 'status-waiting' as const }, ...plan.changed.map(name => ({ text: `  ${name}`, tone: 'ink-2' as const }))] : []),
    { text: 'y runs · n or Esc runs nothing', tone: 'ink-3' },
  ];
}
export class TestAsk {
  private readonly panel: TextPanel;
  constructor(private readonly plan: TestPlan, changed: () => void, private readonly close: () => void, private readonly run: () => void, private readonly loopback?: (allowed: boolean) => void) {
    this.panel = new TextPanel('Tests', changed, close);
    this.panel.set(testLines(plan));
  }
  key(key: string): void {
    if (key === 'y') { this.close(); this.run(); return; }
    // The switch changes what runs, so the popup closes; the caller shows the new plan.
    if (key === 'l' && this.plan.sandbox && this.loopback) { this.close(); this.loopback(!this.plan.loopback); return; }
    if (key === 'n') { this.close(); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

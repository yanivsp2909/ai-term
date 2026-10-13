// v0.2 gate, security review: Codex status partly comes from terminal output an agent controls. One agent flapping
// Working → "Approval requested" must not use up the global budget and silence other agents' real waiting alerts.
import { expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Notifier, type Launcher } from '../src/daemon/notifier.js';
import type { SessionInfo } from '../src/shared/protocol.js';
const now = '2026-10-13T12:00:00.000Z';
const agent = (title: string): SessionInfo => ({ id: randomUUID(), title, engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'waiting', statusDetail: 'permission', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null });
const running = { status: 'running' as const, statusDetail: 'running' }, waiting = { status: 'waiting' as const, statusDetail: 'permission' };
it('a flapping agent gets at most 3 notifications a minute, so another agent still notifies', async () => {
  let t = 0; const launched: string[] = [], logs: string[] = [];
  const launch: Launcher = (_file, args, done) => { launched.push(args[args.indexOf('--body') + 1] ?? ''); done(null); };
  const notifier = new Notifier('/x/AI Term.app', { error: text => logs.push(text) }, async () => true, launch, () => true, () => t, { value: () => 'allowed', start() {}, close() {}, refresh: async () => 'allowed' } as never);
  const hostile = agent('hostile'), real = agent('real');
  for (let i = 0; i < 10; i++) { t = i * 5_000; notifier.transition(hostile, running, waiting, false); await Promise.resolve(); await Promise.resolve(); }
  t = 50_000; notifier.transition(real, running, waiting, false);
  await vi.waitFor(() => expect(launched).toContain('real · waiting: permission'));
  expect(launched.filter(body => body.startsWith('hostile'))).toHaveLength(3);
  // After its minute passes the flapping agent may notify again.
  t = 61_000; notifier.transition(hostile, running, waiting, false);
  await vi.waitFor(() => expect(launched.filter(body => body.startsWith('hostile'))).toHaveLength(4));
});

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';

// Found while building v0.6.1: the saved-state check listed only shell, Claude Code and Codex, so one finished AI Term
// agent in state.json made the next daemon start move the whole agent list aside (B24) and start with none.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('a saved AI Term agent record loads after a daemon restart, with the rest of the list', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-state-agent-')); roots.push(root);
  const paths = getPaths(root); await preparePaths(paths);
  const now = new Date().toISOString(), keyId = randomUUID();
  const base = { cwd: root, permission: 'ask', status: 'exited', statusDetail: 'exit 0', statusSince: now, exitCode: 0, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, pid: null };
  const agent = { ...base, id: randomUUID(), title: 'ai term', engine: 'ai-term', model: 'gpt-6.1-sol', effort: null, auth: { kind: 'key', keyId, provider: 'foundry', keyLabel: 'narvis', last4: 'abcd' }, authMethod: 'api-key', recipe: { engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId }, cwd: root, permission: 'ask', effort: null } };
  const claude = { ...base, id: randomUUID(), title: 'claude', engine: 'claude-code', model: null, auth: { kind: 'account' }, recipe: { engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask' } };
  await writeFile(paths.state, JSON.stringify({ sessions: [agent, claude], worktrees: [] }), { mode: 0o600 });
  const manager = new SessionManager(paths, new Logger(paths.log));
  await manager.load();
  expect(manager.list().map(s => s.title).sort()).toEqual(['ai term', 'claude']);
  expect(manager.notice).toBeNull();
  expect((await readdir(root)).some(name => name.startsWith('state.json.corrupt'))).toBe(false);
  await manager.shutdown();
});

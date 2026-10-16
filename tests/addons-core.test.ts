import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAddon, parseAddonResult } from '../src/shared/addons.js';
import { AddonService } from '../src/daemon/addons.js';
import { AddonPanel } from '../src/client/tui/addon-panel.js';
import type { SessionInfo } from '../src/shared/protocol.js';

const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const fixtures = {
  plan: { kind: 'plan', title: 'One change', steps: [{ title: 'Test', prompt: 'Read src/a.ts; add a failing test, fix it, run tests; stop after this step.' }] },
  prompt: { kind: 'prompt', issues: ['Missing checkpoint'], diff: '--- original\n+++ improved\n@@ -1 +1 @@\n-build\n+Build, run tests and stop.' },
  explain: { kind: 'explain', why: 'This module keeps the state.', diagram: ['input -> state -> screen'], chunks: [['One idea: store one value.', 'Example: src/a.ts:1 exports a = 1.', 'You are here: src/a.ts.', 'Quick check: what value is stored?']], recap: ['State holds one value.', 'The screen reads it.', 'You can trace src/a.ts.'] },
} as const;

it('D58 metadata is strict and explanation chunks stay small', async () => {
  const text = await readFile(new URL('../addons/plan/addon.md', import.meta.url), 'utf8');
  expect(parseAddon(text, 'plan')).toMatchObject({ name: 'plan', defaultEngine: 'claude-code', brain: 'recommended', readOnly: true, worktree: false });
  expect(() => parseAddon(text.replace('brain: recommended', 'brain: maybe'), 'plan')).toThrow();
  expect(() => parseAddon(text.replace('skills: []', 'skills: ["../../login"]'), 'plan')).toThrow();
  expect(parseAddonResult(JSON.stringify(fixtures.explain), 'explain')).toEqual(fixtures.explain);
  expect(() => parseAddonResult(JSON.stringify({ ...fixtures.explain, chunks: [Array(7).fill('line')] }), 'explain')).toThrow();
});

it('all pilots run once on a stub engine; approval saves the plan and only s starts a step', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-addons-')); cleanup.push(root);
  const repo = join(root, 'repo'), home = join(root, 'home'); await mkdir(repo); await mkdir(home);
  await writeFile(join(repo, 'AGENTS.md'), 'Keep permissions and stop after the requested step.');
  await writeFile(join(repo, 'prompt.md'), 'Build the feature');
  const runs: Record<string, unknown>[] = [], answers = new Map<string, string>();
  const engine = {
    async create(request: Record<string, unknown>) {
      runs.push(request); const id = randomUUID();
      const message = String(request.firstMessage), nonce = message.match(/RESULT_([a-f0-9]{32})_BEGIN/)?.[1];
      const name = ['plan', 'prompt', 'explain'].find(n => request.title === '/' + n) as keyof typeof fixtures | undefined;
      if (name && nonce) answers.set(id, `RESULT_${nonce}_BEGIN\n${JSON.stringify(fixtures[name])}\nRESULT_${nonce}_END`);
      return { id, status: 'running', cwd: repo, engine: request.engine } as SessionInfo;
    },
    async text(id: string) { return { sessionId: id, text: answers.get(id) ?? '', truncated: false }; },
    async brainPlan() { return null; },
  };
  const service = new AddonService(home, new URL('../addons/', import.meta.url).pathname, engine);
  let planRun = '';
  for (const name of ['plan', 'prompt', 'explain']) {
    const ask = await service.plan(name, name === 'prompt' ? 'prompt.md' : 'trace src/a.ts', repo, { engine: 'codex', model: null, auth: { kind: 'account' } });
    expect(runs).toHaveLength(name === 'plan' ? 0 : name === 'prompt' ? 1 : 2);
    const session = await service.start(ask.receipt); if (name === 'plan') planRun = session.id;
    expect(runs.at(-1)).toMatchObject({ permission: 'ask', useWorktree: false });
    expect(String(runs.at(-1)?.firstMessage)).toContain('addons/');
    expect((await service.result(session.id))?.kind).toBe(name);
    await expect(service.start(ask.receipt)).rejects.toThrow();
  }
  expect(runs).toHaveLength(3);
  const saved = await service.approve(planRun);
  expect(saved.startsWith(join(home, 'plans'))).toBe(true);
  expect(JSON.parse(await readFile(saved, 'utf8'))).toMatchObject(fixtures.plan);
  expect(runs).toHaveLength(3);
  await service.step(planRun, 0);
  expect(runs).toHaveLength(4);
  expect(runs.at(-1)).toMatchObject({ permission: 'ask', useWorktree: true, firstMessage: fixtures.plan.steps[0].prompt });
});

it('the single popup never starts on Enter, and Space reveals only the next explanation chunk', () => {
  const start = vi.fn(), build = vi.fn(), approve = vi.fn(), step = vi.fn(), copy = vi.fn();
  const panel = new AddonPanel(() => {}, () => {}, { start, build, approve, step, copy, choose: () => {} });
  panel.key('enter'); expect(start).not.toHaveBeenCalled();
  panel.setAsk({ receipt: randomUUID(), name: 'plan', summary: 'Plan', cwd: '/tmp/repo', target: { engine: 'claude-code', model: null, auth: { kind: 'account' } }, brain: 'none', brainNeed: 'recommended', worktree: false, readOnly: true, files: [], inputTokens: { low: 100, high: 200 }, outputTokens: { low: 100, high: 500 }, priceUsd: { low: 0, high: 0 }, subscription: true });
  panel.key('enter'); expect(start).not.toHaveBeenCalled(); panel.key('b'); expect(build).toHaveBeenCalledOnce();
  panel.key('y'); expect(start).toHaveBeenCalledOnce();
  panel.setResult({ ...fixtures.explain, chunks: [...fixtures.explain.chunks, ['Second idea', 'Example: src/b.ts:1.', 'You are here: src/b.ts.', 'Quick check: where next?']] });
  expect(panel.lines.join('\n')).not.toContain('Second idea'); panel.key('space'); expect(panel.lines.join('\n')).toContain('Second idea');
  panel.key('space'); expect(panel.lines.slice(-3)).toEqual(fixtures.explain.recap);
});

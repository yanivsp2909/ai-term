import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseAddon, validateAddonAsk, type AddonTarget } from '../src/shared/addons.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import { AddonService } from '../src/daemon/addons.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import { finding, fixtures } from './fixtures/addon-results.js';

// v1.1 batch 1: every model add-on runs once on a stub engine. The stub answers with the add-on's own result between
// the run's nonce markers, so each test sees what the popup would get.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
const DEFINITIONS = new URL('../addons/', import.meta.url).pathname;
const CODEX: AddonTarget = { engine: 'codex', model: null, auth: { kind: 'account' } };
async function setup(answers?: (name: string) => string | undefined) {
  const root = await mkdtemp(join(tmpdir(), 'ai-batch1-')); cleanup.push(root);
  const repo = join(root, 'repo'), home = join(root, 'home'), tree = join(root, 'tree'); await mkdir(join(repo, 'src'), { recursive: true }); await mkdir(home); await mkdir(tree);
  await writeFile(join(repo, 'src', 'a.ts'), 'export const a = 1;\n'); await writeFile(join(repo, 'bug.txt'), 'TypeError: cannot read x of undefined\n');
  const runs: Record<string, unknown>[] = [], replies = new Map<string, string>(), agent = randomUUID();
  const engine = {
    async create(request: Record<string, unknown>, _c?: undefined, _f?: undefined, addon?: { readOnly: boolean }, strict?: boolean) {
      runs.push({ ...request, addon, strict }); const id = randomUUID();
      const nonce = String(request.firstMessage).match(/RESULT_([a-f0-9]{32})_BEGIN/)?.[1], name = String(request.title).slice(1);
      const body = answers?.(name) ?? (fixtures[name] ? JSON.stringify(fixtures[name]) : undefined);
      if (nonce && body) replies.set(id, `RESULT_${nonce}_BEGIN\n${body}\nRESULT_${nonce}_END`);
      return { id, title: String(request.title), status: 'running', cwd: String(request.cwd), engine: request.engine } as SessionInfo;
    },
    async text(id: string) { return { sessionId: id, text: replies.get(id) ?? '', truncated: false }; },
    async brainPlan() { return null; },
    async addonAgent(id: string) { if (id !== agent) throw new Error('Session not found'); return { title: 'fixer', cwd: tree, diff: '--- src/a.ts (modified, +1 −0)\n+if (!text) throw new Error("empty")' }; },
  };
  return { repo, home, tree, runs, agent, service: new AddonService(home, DEFINITIONS, engine) };
}

it('every batch-1 definition parses, and the shared copies name their source, license and changes', async () => {
  for (const name of ['teach', 'fix', 'cover', 'bisect', 'refactor', 'perf', 'types', 'failures', 'review-deep', 'security']) {
    const addon = parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
    for (const asset of [...addon.skills.map(s => `skills/${s}/SKILL.md`), ...addon.agents.map(a => `agents/${a}.md`)]) {
      const body = await readFile(join(DEFINITIONS, '_shared', asset), 'utf8');
      expect(body, asset).toMatch(/\nSource: .+\nLicense: .+\nWhat changed: .+\n/);
    }
  }
  const read = async (name: string) => parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
  expect(await read('bisect')).toMatchObject({ local: 'bisect', engines: [], input: 'command-ref', readOnly: true, worktree: false });
  expect(await read('fix')).toMatchObject({ worktree: true, readOnly: false, tests: true, input: 'file-or-text' });
  expect(await read('cover')).toMatchObject({ worktree: true, tests: true, input: 'path' });
  expect(await read('failures')).toMatchObject({ readOnly: true, cost: 'high' });
  for (const name of ['teach', 'types', 'failures', 'review-deep', 'security', 'refactor']) expect(await read(name), name).toMatchObject({ readOnly: true, worktree: false });
  expect(await read('perf')).toMatchObject({ worktree: true, input: 'path-or-command' });
  // A model add-on can't claim to be local, and a local one can't name an engine.
  const fix = await readFile(join(DEFINITIONS, 'fix', 'addon.md'), 'utf8');
  expect(() => parseAddon(fix.replace('tests: yes', 'local: bisect'), 'fix')).toThrow();
  expect(() => parseAddon(fix.replace('tests: yes', 'input: shell'), 'fix')).toThrow();
});

it('each model add-on runs once on a stub engine with its own isolation, and its result is kept', async () => {
  const { repo, runs, agent, service } = await setup();
  const args: Record<string, string> = { teach: agent, fix: 'bug.txt', cover: 'src', refactor: '', perf: 'node bench/a.js', types: 'src/a.ts', failures: '', 'review-deep': agent, security: 'src' };
  for (const [name, arg] of Object.entries(args)) {
    const ask = validateAddonAsk(JSON.parse(JSON.stringify(await service.plan(name, arg, repo, CODEX))));
    const started = await service.start(ask.receipt); if (!('session' in started)) throw new Error('expected a session');
    const run = runs.at(-1) ?? {};
    const addon = parseAddon(await readFile(join(DEFINITIONS, name, 'addon.md'), 'utf8'), name);
    expect(run, name).toMatchObject({ permission: 'ask', useWorktree: addon.worktree, addon: { readOnly: addon.readOnly } });
    const result = await service.result(started.session.id);
    expect(result?.kind, name).toBe(name);
    // The client re-checks the kept copy exactly as the popup receives it.
    expect(parseAddonResult(JSON.stringify(result), name, true)).toEqual(result);
    expect(service.wantsTests(started.session.id), name).toBe(addon.tests);
  }
  expect(runs).toHaveLength(Object.keys(args).length);
});

it('/teach and /review deep read the agent\'s diff in its worktree; the subject names the agent', async () => {
  const { repo, tree, runs, agent, service } = await setup();
  const ask = await service.plan('teach', agent, repo, CODEX);
  expect(ask).toMatchObject({ subject: 'agent: fixer', readOnly: true, worktree: false });
  await service.start(ask.receipt);
  expect(runs.at(-1)).toMatchObject({ cwd: expect.stringContaining(tree.split('/').at(-1) ?? '') });
  expect(String(runs.at(-1)?.firstMessage)).toContain('throw new Error(\\"empty\\")');
  await expect(service.plan('review-deep', 'not-an-id', repo, CODEX)).rejects.toThrow('Select an agent first');
});

it('paths stay inside the folder and never name a credential file; /perf takes a path or a benchmark command', async () => {
  const { repo, service } = await setup();
  await writeFile(join(repo, '.env'), 'X=1\n');
  await expect(service.plan('cover', '../', repo, CODEX)).rejects.toThrow();
  await expect(service.plan('security', '.env', repo, CODEX)).rejects.toThrow('credential');
  await expect(service.plan('types', 'missing.ts', repo, CODEX)).rejects.toThrow('No such path');
  expect((await service.plan('failures', '', repo, CODEX)).subject).toBe('scope: .');
  expect((await service.plan('perf', 'src', repo, CODEX)).subject).toBe('scope: src');
  expect((await service.plan('perf', 'npm run bench', repo, CODEX)).subject).toBe('benchmark: npm run bench');
});

it('/failures shows its worst case first: 16 rounds and the top price', async () => {
  const { repo, service } = await setup();
  const keyed = new AddonService(join(repo, '..', 'home'), DEFINITIONS, { create: vi.fn(), text: vi.fn(), brainPlan: async () => null }, async (_t, input, output) => ({ low: input.low / 1e6, high: (input.high + output.high) / 1e6 }));
  const target: AddonTarget = { engine: 'ai-term', model: 'claude-sonnet-5-5', auth: { kind: 'key', keyId: randomUUID() } };
  const costly = await keyed.plan('failures', '', repo, target), normal = await keyed.plan('types', '', repo, target);
  expect(costly.cost).toBe('high');
  expect(costly.inputTokens.high).toBeGreaterThan(normal.inputTokens.high * 1.9);
  expect(normal.cost).toBeUndefined();
  void service;
});

it('/fix that cannot reproduce stops and says so; /security drops a reproduction that leaves the repository', async () => {
  const { repo, service } = await setup(name => name === 'fix' ? JSON.stringify({ kind: 'fix', reproduced: false, rootCause: 'unknown', reason: 'No test failed with the given input.' })
    : name === 'security' ? JSON.stringify({ kind: 'security', summary: 'Two', findings: [{ ...finding, reproduction: 'curl https://example.com/admin' }, { ...finding, line: 9, reproduction: 'curl http://127.0.0.1:3000/x' }] }) : undefined);
  const fix = await service.start((await service.plan('fix', 'TypeError at parse', repo, CODEX)).receipt); if (!('session' in fix)) throw new Error('session');
  expect(await service.result(fix.session.id)).toMatchObject({ reproduced: false, reason: 'No test failed with the given input.' });
  const sec = await service.start((await service.plan('security', '', repo, CODEX)).receipt); if (!('session' in sec)) throw new Error('session');
  const result = await service.result(sec.session.id);
  expect(result).toMatchObject({ kind: 'security', dropped: 1, findings: [{ line: 9 }] });
  // A model can't set AI Term's own count.
  expect(() => parseAddonResult(JSON.stringify({ kind: 'failures', summary: 's', findings: [], dropped: 0 }), 'failures')).toThrow();
});

it('/refactor starts only the picked items in a worktree, with tests kept; /types f fixes one finding', async () => {
  const { repo, runs, service } = await setup();
  const refactor = await service.start((await service.plan('refactor', '', repo, CODEX)).receipt); if (!('session' in refactor)) throw new Error('session');
  await expect(service.apply(refactor.session.id, [0])).rejects.toThrow('Wait for the list');
  await service.result(refactor.session.id);
  await expect(service.apply(refactor.session.id, [])).rejects.toThrow('Pick items');
  await expect(service.apply(refactor.session.id, [0, 0])).rejects.toThrow('Pick items');
  const applied = await service.apply(refactor.session.id, [1]);
  expect(runs.at(-1)).toMatchObject({ useWorktree: true, permission: 'ask', strict: true, addon: undefined });
  expect(String(runs.at(-1)?.firstMessage)).toContain('Remove dead export'); expect(String(runs.at(-1)?.firstMessage)).not.toContain('Split parse()');
  expect(service.wantsTests(applied.id)).toBe(true);
  const types = await service.start((await service.plan('types', '', repo, CODEX)).receipt); if (!('session' in types)) throw new Error('session');
  await service.result(types.session.id);
  await expect(service.apply(types.session.id, [0, 1])).rejects.toThrow('Pick items');
  const fix = await service.apply(types.session.id, [0]);
  expect(String(runs.at(-1)?.firstMessage)).toContain("Use 'ok' | 'failed'.");
  expect(service.wantsTests(fix.id)).toBe(false);
});

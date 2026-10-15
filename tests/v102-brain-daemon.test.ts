import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import type { Summarize } from '../src/daemon/handoff.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';
import { validateBrainPlan, validateBrainResult } from '../src/shared/brain.js';

// v1.0.2 /brain through the daemon, with a stub provider (tests never reach a network): the plan asks first with the
// token and price range of what changed; the model pass summarizes with secrets kept out, is held against budgets and the
// per-run cap, and is counted in Usage; agents started afterwards get the map.
const SECRET = 'AITERMCANARY-brain-0123456789abcdef', LEAK = 'sk-ant-api03-' + 'L'.repeat(40);
const snapshot: PriceSnapshot = { fetchedAt: '2026-10-15', providers: { anthropic: { 'claude-haiku-5': { input: 1, output: 5 }, 'claude-sonnet-5': { input: 3, output: 15 } }, openai: {}, azure: {} } };
const run = promisify(execFile), cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
async function daemon(settings: Record<string, unknown> = {}, summarize?: Summarize) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-brain-d-'))), home = join(root, 'home'), repo = join(root, 'repo');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(home, { mode: 0o700 }); await mkdir(join(repo, 'src'), { recursive: true });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]);
  await writeFile(join(repo, 'src', 'a.ts'), "import { b } from './b';\nexport const a = b + 1;\n");
  await writeFile(join(repo, 'src', 'b.ts'), 'export const b = 1;\n');
  await writeFile(join(repo, 'src', 'leak.ts'), `export const key = "${LEAK}";\n`);
  await run('/usr/bin/git', [...ID, 'add', '--', '.'], { cwd: repo }); await run('/usr/bin/git', [...ID, 'commit', '-qm', 'i', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  await writeFile(join(home, 'settings.json'), JSON.stringify({ theme: 'graphite', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(home, log), vault = new Map<string, string>();
  const keys = new KeyStore(home, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  const prompts: string[] = [];
  manager.setHandoffWriter({ prices: snapshot, summarize: summarize ?? (async (_writer, secret, _endpoint, prompt) => {
    expect(secret).toBe(SECRET); prompts.push(prompt);
    const paths = [...prompt.matchAll(/<file path="([^"]+)">/g)].map(m => m[1]);
    return { text: [...paths.map(p => `${p} :: The ${p} module.`), 'DECISION :: Modules export one value each.'].join('\n'), inputTokens: 900, outputTokens: 60 };
  }) });
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  const key = await keys.add({ provider: 'anthropic', label: 'work', secret: SECRET });
  return { home, repo, manager, usage, prompts, key };
}

it('the local pass needs no model: the plan offers it free, the build writes brain.md under the AI Term folder', async () => {
  const d = await daemon();
  const plan = validateBrainPlan(await d.manager.brainPlan(d.repo));
  expect(plan).toMatchObject({ files: 2, changed: 2, removed: 0, skipped: { binary: 0, large: 0, env: 0, secret: 1 }, builtAt: null, summarize: 2, agents: true });
  expect(plan.models.map(m => m.model)).toEqual(['claude-haiku-5', 'claude-sonnet-5']);
  expect(plan.models[0]?.priceUsd.high).toBeGreaterThan(0);
  const result = validateBrainResult(await d.manager.buildBrain(d.repo, plan.fingerprint));
  expect(result).toMatchObject({ files: 2, summarized: 0, costUsd: null, model: null });
  expect(result.path.startsWith(join(d.home, 'brain'))).toBe(true);
  expect(await readFile(result.path, 'utf8')).toContain('imported by: src/a.ts');
  expect(d.prompts).toEqual([]);
  expect((await d.manager.brainShow(d.repo)).text).toContain('# Brain: repo');
});

it('again: only what changed is planned and priced; a stale plan is refused', async () => {
  const d = await daemon();
  const first = await d.manager.brainPlan(d.repo); await d.manager.buildBrain(d.repo, first.fingerprint);
  await writeFile(join(d.repo, 'src', 'b.ts'), 'export const b = 2;\n');
  const second = await d.manager.brainPlan(d.repo);
  expect(second).toMatchObject({ changed: 1, files: 2 });
  await writeFile(join(d.repo, 'src', 'b.ts'), 'export const b = 3;\n');
  await expect(d.manager.buildBrain(d.repo, second.fingerprint)).rejects.toThrow('The repository changed since the plan was shown; run /brain again');
});

it('the model pass: summaries and design decisions, secrets kept out, counted in Usage; the next plan prices only what changed', async () => {
  const d = await daemon();
  const plan = await d.manager.brainPlan(d.repo), model = plan.models[0];
  if (!model) throw new Error('no model');
  const result = await d.manager.buildBrain(d.repo, plan.fingerprint, { keyId: model.keyId, model: model.model });
  expect(result).toMatchObject({ summarized: 2, model: 'claude-haiku-5' });
  expect(result.costUsd).toBeGreaterThan(0);
  expect(d.prompts.join('\n')).not.toContain(LEAK);
  expect(d.prompts.join('\n')).not.toContain('leak.ts');
  const text = await readFile(result.path, 'utf8');
  expect(text).toContain('The src/a.ts module.'); expect(text).toContain('- Modules export one value each.');
  expect(d.usage.summary().today.costUsd).toBeGreaterThan(0);
  await writeFile(join(d.repo, 'src', 'b.ts'), 'export const b = 2;\n');
  const next = await d.manager.brainPlan(d.repo);
  expect(next.summarize).toBe(1);
  expect(next.inputTokens.high).toBeLessThan(plan.inputTokens.high);
});

it('budgets and the per-run cap hold the model pass before anything is sent', async () => {
  const tight = await daemon({ budgets: { daily: 0.000001 } });
  const plan = await tight.manager.brainPlan(tight.repo), model = plan.models[0];
  if (!model) throw new Error('no model');
  await expect(tight.manager.buildBrain(tight.repo, plan.fingerprint, { keyId: model.keyId, model: model.model })).rejects.toThrow('The brain would pass your daily budget');
  expect(tight.prompts).toEqual([]);
  const capped = await daemon({ agentCaps: { turns: 100, spendUsd: 0.000001 } });
  const plan2 = await capped.manager.brainPlan(capped.repo), model2 = plan2.models[0];
  if (!model2) throw new Error('no model');
  await expect(capped.manager.buildBrain(capped.repo, plan2.fingerprint, { keyId: model2.keyId, model: model2.model })).rejects.toThrow("The brain's model pass would pass the per-run cap in /settings c");
});

it('agents started afterwards get it (D55, on): Claude Code\'s argv names the file, the card shows its age; switched off, they don\'t; rm deletes it', async () => {
  const d = await daemon();
  const plan = await d.manager.brainPlan(d.repo); const built = await d.manager.buildBrain(d.repo, plan.fingerprint);
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const spawned: string[][] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push([...args]); return real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  const claude = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'mapped' });
  expect(spawned.at(-1)).toContain(`--append-system-prompt-file=${built.path}`);
  expect(claude.brain?.builtAt).toEqual(expect.any(String));
  const codex = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'told', firstMessage: 'fix it', brainMention: true });
  expect(spawned.at(-1)?.at(-1)).toBe(`Before you start, read the repository map AI Term made at ${built.path}.\n\nfix it`);
  expect(codex.brain).toBeDefined();
  const plain = await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'plain', firstMessage: 'fix it' });
  expect(spawned.at(-1)?.at(-1)).toBe('fix it'); expect(plain.brain).toBeUndefined();
  await d.manager.setBrainForAgents(false);
  const off = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', title: 'unmapped' });
  expect(spawned.at(-1)?.join(' ')).not.toContain('append-system-prompt-file'); expect(off.brain).toBeUndefined();
  expect(await d.manager.brainRemove(d.repo)).toBe(true);
  await expect(d.manager.brainShow(d.repo)).rejects.toThrow('No brain for this repository yet · /brain builds one');
}, 30_000);

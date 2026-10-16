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
  expect(plan).toMatchObject({ files: 2, changed: 2, removed: 0, skipped: { binary: 0, large: 0, env: 0, secret: 1, names: 0 }, builtAt: null, summarize: 0, agents: false, trusted: false });
  expect(plan.models).toEqual([]);
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
  await d.manager.setBrainPreferences(d.repo, { trusted: true });
  const plan = await d.manager.brainPlan(d.repo), model = plan.models[0];
  if (!model) throw new Error('no model');
  const result = await d.manager.buildBrain(d.repo, plan.fingerprint, { keyId: model.keyId, model: model.model });
  expect(result).toMatchObject({ summarized: 2, model: 'claude-haiku-5' });
  expect(result.costUsd).toBeGreaterThan(0);
  expect(d.prompts.join('\n')).not.toContain(LEAK);
  expect(d.prompts.join('\n')).not.toContain('leak.ts');
  const text = await readFile(result.path, 'utf8');
  expect(text).toContain('The src/a.ts module.'); expect(text).toContain('- > Modules export one value each.');
  expect(d.usage.summary().today.costUsd).toBeGreaterThan(0);
  await writeFile(join(d.repo, 'src', 'b.ts'), 'export const b = 2;\n');
  const next = await d.manager.brainPlan(d.repo);
  expect(next.summarize).toBe(1);
  expect(next.inputTokens.high).toBeLessThan(plan.inputTokens.high);
});

it('budgets and the per-run cap hold the model pass before anything is sent', async () => {
  const tight = await daemon({ budgets: { daily: 0.000001 } });
  await tight.manager.setBrainPreferences(tight.repo, { trusted: true });
  const plan = await tight.manager.brainPlan(tight.repo), model = plan.models[0];
  if (!model) throw new Error('no model');
  await expect(tight.manager.buildBrain(tight.repo, plan.fingerprint, { keyId: model.keyId, model: model.model })).rejects.toThrow('The brain would pass your daily budget');
  expect(tight.prompts).toEqual([]);
  const capped = await daemon({ agentCaps: { turns: 100, spendUsd: 0.000001 } });
  await capped.manager.setBrainPreferences(capped.repo, { trusted: true });
  const plan2 = await capped.manager.brainPlan(capped.repo), model2 = plan2.models[0];
  if (!model2) throw new Error('no model');
  await expect(capped.manager.buildBrain(capped.repo, plan2.fingerprint, { keyId: model2.keyId, model: model2.model })).rejects.toThrow("The brain's model pass would pass the per-run cap in /settings c");
});

it('B30: agents default off; explicit old on survives; per-repository choices apply to every engine', async () => {
  const d = await daemon();
  const plan = await d.manager.brainPlan(d.repo); const built = await d.manager.buildBrain(d.repo, plan.fingerprint);
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  const spawned: string[][] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push([...args]); return real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  const base = { model: null, auth: { kind: 'account' as const }, cwd: d.repo, permission: 'ask' as const, firstMessage: 'fix it' };
  const off = await d.manager.create({ ...base, engine: 'claude-code' });
  expect(off.brain).toBeUndefined(); expect(spawned.at(-1)?.join(' ')).not.toContain('append-system-prompt-file');
  await d.manager.setBrainForAgents(true);
  const claude = await d.manager.create({ ...base, engine: 'claude-code' });
  const indexPath = built.path.replace('brain.md', 'brain-index.md');
  expect(spawned.at(-1)?.find(arg=>arg.startsWith('--append-system-prompt-file='))).toMatch(/snapshots.*brain-index\.md$/);
  expect(claude.brain).toBeDefined();
  await d.manager.setBrainPreferences(d.repo, { agents: false });
  const plain = await d.manager.create({ ...base, engine: 'codex' });
  expect(plain.brain).toBeUndefined(); expect(spawned.at(-1)?.at(-1)).toBe('fix it');
  const codex = await d.manager.create({ ...base, engine: 'codex', brain: true });
  expect(codex.brain).toBeDefined(); expect(spawned.at(-1)?.at(-1)).toContain('brain-index.md');
  const native = await d.manager.create({ ...base, engine: 'ai-term', model: 'claude-haiku-5', auth: { kind: 'key', keyId: d.key.id }, brain: true });
  expect(native.brain).toBeDefined(); expect(spawned.at(-1)?.find(arg=>arg.startsWith('--brain='))).toMatch(/snapshots.*brain-index\.md$/);
  expect(await d.manager.brainPreferences(d.repo)).toMatchObject({ agents: false, trusted: false });
  await d.manager.setBrainPreferences(d.repo, { agents: true });
  expect((await d.manager.brainPlan(d.repo)).agents).toBe(true);
  const settings = JSON.parse(await readFile(join(d.home, 'settings.json'), 'utf8')) as Record<string, unknown>;
  expect(settings.brainForAgents).toBe(true);
  expect(settings.brainRepositories).toBeDefined();
  expect(await d.manager.brainRemove(d.repo)).toBe(true);
  await expect(readFile(indexPath, 'utf8')).rejects.toThrow();
}, 30_000);

it('B30: untrusted repositories cannot run a model pass; trust changes invalidate the offered plan', async () => {
  const d = await daemon();
  const untrusted = await d.manager.brainPlan(d.repo);
  await expect(d.manager.buildBrain(d.repo, untrusted.fingerprint, { keyId: d.key.id, model: 'claude-haiku-5' })).rejects.toThrow('trust');
  expect(d.prompts).toEqual([]);
  await d.manager.setBrainPreferences(d.repo, { trusted: true });
  await expect(d.manager.buildBrain(d.repo, untrusted.fingerprint)).rejects.toThrow('changed');
  const trusted = await d.manager.brainPlan(d.repo);
  expect(trusted.models.length).toBeGreaterThan(0);
  await d.manager.buildBrain(d.repo, trusted.fingerprint, { keyId: d.key.id, model: 'claude-haiku-5' });
  await d.manager.setBrainPreferences(d.repo, { trusted: false });
  const indexPath = (await import('../src/daemon/brain.js')).brainPaths(d.home, d.repo).index;
  expect(await readFile(indexPath, 'utf8')).not.toContain('The src/');
});

// Part C review (typescript-reviewer): each failed before its fix.
it('MEDIUM (review): a model pass that fails partway keeps what it already paid for; earlier design notes stay first; a plan made stale by rm is refused', async () => {
  let calls = 0;
  const d = await daemon({}, async (_writer, _secret, _endpoint, prompt) => {
    calls++;
    if (calls === 2) throw new Error('provider down');
    const paths = [...prompt.matchAll(/<file path="([^"]+)">/g)].map(m => m[1]);
    return { text: [...paths.map(p => `${p} :: Summary ${calls}.`), `DECISION :: Decision ${calls}.`].join('\n'), inputTokens: 900, outputTokens: 60 };
  });
  await d.manager.setBrainPreferences(d.repo, { trusted: true });
  for (let i = 0; i < 6; i++) await writeFile(join(d.repo, 'src', `big${i}.ts`), `export const v${i} = 1;\n` + '// pad\n'.repeat(3000));
  const plan = await d.manager.brainPlan(d.repo), model = plan.models[0];
  if (!model) throw new Error('no model');
  await expect(d.manager.buildBrain(d.repo, plan.fingerprint, { keyId: model.keyId, model: model.model })).rejects.toThrow('The brain request failed');
  const kept = await readFile(join(d.home, 'brain', (await import('../src/daemon/worktrees.js')).repoDirectory(d.repo), 'brain.json'), 'utf8');
  expect(kept).toContain('Summary 1.');
  expect(kept).toContain('Decision 1.');
  const again = await d.manager.brainPlan(d.repo);
  expect(again.summarize).toBeLessThan(plan.summarize);
  const third = await d.manager.buildBrain(d.repo, again.fingerprint, { keyId: model.keyId, model: model.model });
  const text = await readFile(third.path, 'utf8');
  expect(text.indexOf('Decision 1.')).toBeLessThan(text.indexOf('Decision 3.'));
  const stale = await d.manager.brainPlan(d.repo);
  await d.manager.brainRemove(d.repo);
  await expect(d.manager.buildBrain(d.repo, stale.fingerprint)).rejects.toThrow('The repository changed since the plan was shown; run /brain again');
}, 30_000);


it('HIGH review: revoking trust stops later model batches and never restores notes to the current index', async () => {
  let release: () => void = () => {}, started: () => void = () => {}, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const sent = new Promise<void>(resolve => { started = resolve; });
  const d = await daemon({}, async (_writer, _secret, _endpoint, prompt) => {
    calls++; started(); await pending;
    const paths = [...prompt.matchAll(/<file path="([^"]+)">/g)].map(m => m[1]);
    return { text: paths.map(path => `${path} :: trusted-model-note`).join('\n'), inputTokens: 100, outputTokens: 20 };
  });
  await d.manager.setBrainPreferences(d.repo, { trusted: true });
  for (let i = 0; i < 8; i++) await writeFile(join(d.repo, 'src', `big${i}.ts`), `export const v${i} = 1;\n` + '// pad\n'.repeat(3000));
  const plan = await d.manager.brainPlan(d.repo);
  const build = d.manager.buildBrain(d.repo, plan.fingerprint, { keyId: d.key.id, model: 'claude-haiku-5' });
  const outcome = build.then(() => 'done', () => 'stopped');
  await sent; await d.manager.setBrainPreferences(d.repo, { trusted: false }); release();
  await outcome;
  expect(calls).toBe(1);
  const path = (await import('../src/daemon/brain.js')).brainPaths(d.home, d.repo).index;
  expect(await readFile(path, 'utf8')).not.toContain('trusted-model-note');
});

it('MEDIUM security review: an untrusted start index is immutable when a later trusted writer runs', async () => {
  const d = await daemon();
  const plan = await d.manager.brainPlan(d.repo); await d.manager.buildBrain(d.repo, plan.fingerprint);
  const brain = await import('../src/daemon/brain.js');
  const index = await brain.readBrain(d.home, d.repo); if (!index) throw new Error('missing index');
  index.files['src/a.ts'] = { ...index.files['src/a.ts']!, summary: 'trusted-model-note' };
  const untrusted = await brain.writeBrainIndex(d.home, d.repo, index, false, true);
  const trusted = await brain.writeBrainIndex(d.home, d.repo, index, true, true);
  expect(untrusted).not.toBe(trusted);
  expect(await readFile(untrusted, 'utf8')).not.toContain('trusted-model-note');
  expect(await readFile(trusted, 'utf8')).toContain('trusted-model-note');
});

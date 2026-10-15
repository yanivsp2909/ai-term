import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import { SettingsStore } from '../src/daemon/settings.js';
import * as engines from '../src/daemon/engines.js';
import pty from 'node-pty';
import type { Summarize } from '../src/daemon/handoff.js';
import { reviewCandidates } from '../src/daemon/review.js';
import { countFindings, diffForReview, reviewPrompt, REVIEW_OUTPUT_TOKENS, validateReviewPlan, validateReviewResult, validateReviewState } from '../src/shared/review.js';
import type { AgentDiff } from '../src/shared/diff.js';
import type { KeyView, SessionInfo } from '../src/shared/protocol.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';

// v0.7.4 /review [agent]: one reviewer pass over the agent's diff by a keyed model you pick. D49: it asks first (the
// models with their price ranges, the token range); the result shows in a popup and on the card. Auto-review on done
// (D55, off by default) does the same with the model you last picked, under its own daily budget.
const SECRET = 'AITERMCANARY-review-0123456789abcdef', LEAK = 'sk-ant-api03-' + 'L'.repeat(40);
const snapshot: PriceSnapshot = { fetchedAt: '2026-10-15', providers: { anthropic: { 'claude-haiku-5': { input: 1, output: 5 }, 'claude-sonnet-5': { input: 3, output: 15 } }, openai: { 'gpt-6.1-mini': { input: 0.2, output: 0.8 } }, azure: {} } };
const diff: AgentDiff = { title: 'fixer', branch: 'ai/fixer', base: 'main @ abc1234', added: 3, removed: 1, capped: false, files: [
  { path: 'src/login.ts', status: 'modified', added: 2, removed: 1, lines: ['@@ -1,2 +1,3 @@', ' import x', '-const a = 1;', '+const a = 2;', `+const key = "${LEAK}";`] },
  { path: 'notes.md', status: 'untracked', added: 1, removed: 0, lines: ['+hello'] },
] };

it('the review prompt carries the diff with secrets removed, asks for severity lines, and counts them', () => {
  const text = diffForReview(diff);
  expect(text).toContain('--- src/login.ts (modified, +2 −1)'); expect(text).toContain('+const a = 2;'); expect(text).toContain('--- notes.md (untracked, +1 −0)');
  expect(text).not.toContain(LEAK);
  const prompt = reviewPrompt(text);
  expect(prompt).toContain('HIGH:'); expect(prompt).toContain('No issues found.'); expect(prompt).toContain('+const a = 2;');
  expect(countFindings('HIGH: src/a.ts:3 null deref\n- MEDIUM: b\n**LOW**: c\n2. HIGH: d\nhigh-level note')).toEqual({ high: 2, medium: 1, low: 1 });
  expect(countFindings('No issues found.')).toEqual({ high: 0, medium: 0, low: 0 });
  const big: AgentDiff = { ...diff, files: Array.from({ length: 400 }, (_, i) => ({ path: `f${i}.ts`, status: 'added' as const, added: 400, removed: 0, lines: Array.from({ length: 400 }, () => '+' + 'x'.repeat(60)) })) };
  const cut = diffForReview(big);
  expect(cut.length).toBeLessThan(130_000); expect(cut).toContain('(the diff is cut here:');
});

it('the models you can pick: priced chat models of your keys, cheapest first, each with its price range', () => {
  const anthropic: KeyView = { id: randomUUID(), provider: 'anthropic', label: 'work', last4: 'aaaa' }, openai: KeyView = { id: randomUUID(), provider: 'openai', label: 'o', last4: 'oooo' };
  const models = reviewCandidates([anthropic, openai], {}, snapshot, { low: 8000, high: 12000 }, { low: 200, high: REVIEW_OUTPUT_TOKENS });
  expect(models.map(m => `${m.provider}/${m.model}`)).toEqual(['openai/gpt-6.1-mini', 'anthropic/claude-haiku-5', 'anthropic/claude-sonnet-5']);
  expect(models[2]).toMatchObject({ keyId: anthropic.id, keyLabel: 'work', last4: 'aaaa' });
  expect(models[2]?.priceUsd.high).toBeCloseTo((12000 * 3 + REVIEW_OUTPUT_TOKENS * 15) / 1e6, 10);
  expect(models[2]?.priceUsd.low).toBeCloseTo((8000 * 3 + 200 * 15) / 1e6, 10);
  expect(reviewCandidates([], {}, snapshot, { low: 1, high: 2 }, { low: 1, high: 2 })).toEqual([]);
});

it('the client accepts only the fixed review shapes', () => {
  for (const ok of [{ state: 'running' }, { state: 'failed' }, { state: 'done', high: 1, medium: 0, low: 2 }]) expect(validateReviewState(ok)).toEqual(ok);
  for (const bad of [{ state: 'done' }, { state: 'done', high: -1, medium: 0, low: 0 }, { state: 'running', x: 1 }]) expect(() => validateReviewState(bad)).toThrow();
  expect(() => validateReviewResult({ title: 'fixer', model: 'm', text: 'a\u001b[2Jb', counts: { high: 0, medium: 0, low: 0 }, inputTokens: 1, outputTokens: 1, costUsd: null })).toThrow();
  expect(() => validateReviewPlan({ title: 'x' })).toThrow();
});

const run = promisify(execFile), cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
async function daemon(settings: Record<string, unknown> = {}, summarize?: Summarize) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-review-'))), home = join(root, 'home'), repo = join(root, 'repo');
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(home, { mode: 0o700 }); await mkdir(repo);
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await writeFile(join(repo, 'login.ts'), 'const a = 1;\n');
  await run('/usr/bin/git', [...ID, 'add', '--', '.'], { cwd: repo }); await run('/usr/bin/git', [...ID, 'commit', '-qm', 'initial', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths);
  await writeFile(join(home, 'settings.json'), JSON.stringify({ theme: 'graphite', ...settings }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(home, log), vault = new Map<string, string>();
  const keys = new KeyStore(home, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usage, '/opt/ai-term/dist/cli/index.js');
  const prompts: { prompt: string; model: string; max?: number }[] = [];
  manager.setHandoffWriter({ prices: snapshot, summarize: summarize ?? (async (writer, secret, _endpoint, prompt, _signal, max) => { expect(secret).toBe(SECRET); prompts.push({ prompt, model: writer.model, ...(max !== undefined ? { max } : {}) }); return { text: `HIGH: login.ts:1 the key is hard-coded\nLOW: login.ts:1 naming\n${LEAK}`, inputTokens: 9000, outputTokens: 400 }; }) });
  await usage.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usage.close(); });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  // The agent stays alive (a stub that waits), so its exit can't race the turn end the test simulates.
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => real('/bin/sh', ['-c', 'sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  const key = await keys.add({ provider: 'anthropic', label: 'work', secret: SECRET });
  const agent = await manager.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: repo, permission: 'ask', title: 'fixer' });
  const live = (manager as unknown as { sessions: Map<string, { info: SessionInfo }> }).sessions.get(agent.id);
  if (!live) throw new Error('no live'); live.info.status = 'done';
  await writeFile(join(agent.worktree ?? '', 'login.ts'), `const a = 2;\nconst key = "${LEAK}";\n`);
  return { home, manager, usage, prompts, key, agent, live, repo };
}

it('/review asks first with the models and prices; the run reviews exactly the diff shown, without secrets, and shows on the card', async () => {
  const d = await daemon();
  const plan = validateReviewPlan(await d.manager.reviewPlan(d.agent.id));
  expect(plan).toMatchObject({ title: 'fixer', files: 1, added: 2, removed: 1, cut: false });
  expect(plan.models.map(m => m.model)).toEqual(['claude-haiku-5', 'claude-sonnet-5']);
  expect(plan.selected).toBe(0);
  const pick = plan.models[1];
  if (!pick) throw new Error('no model');
  const result = validateReviewResult(await d.manager.review(d.agent.id, pick.keyId, pick.model, plan.fingerprint));
  expect(result).toMatchObject({ title: 'fixer', model: 'claude-sonnet-5', counts: { high: 1, medium: 0, low: 1 }, inputTokens: 9000, outputTokens: 400 });
  expect(result.costUsd).toBeCloseTo((9000 * 3 + 400 * 15) / 1e6, 10);
  expect(result.text).not.toContain(LEAK);
  expect(d.prompts).toHaveLength(1); expect(d.prompts[0]?.prompt).toContain('const a = 2;'); expect(d.prompts[0]?.prompt).not.toContain(LEAK); expect(d.prompts[0]?.max).toBe(REVIEW_OUTPUT_TOKENS);
  expect(d.manager.get(d.agent.id).review).toEqual({ state: 'done', high: 1, medium: 0, low: 1 });
  expect(await d.manager.lastReview(d.agent.id)).toEqual(result);
  // The model you picked becomes the default next time (and the one auto-review uses).
  expect((await new SettingsStore(d.home).get()).reviewModel).toEqual({ keyId: d.key.id, model: 'claude-sonnet-5' });
  expect(validateReviewPlan(await d.manager.reviewPlan(d.agent.id)).selected).toBe(1);
  // The usage counts like any API spend.
  await vi.waitFor(() => expect(d.usage.summary().today.costUsd).toBeCloseTo((9000 * 3 + 400 * 15) / 1e6, 10));
});

it('a diff that changed since the ask, a model not offered, or a running agent is refused before anything is sent', async () => {
  const d = await daemon();
  const plan = await d.manager.reviewPlan(d.agent.id), pick = plan.models[0];
  if (!pick) throw new Error('no model');
  await writeFile(join(d.agent.worktree ?? '', 'more.ts'), 'x\n');
  await expect(d.manager.review(d.agent.id, pick.keyId, pick.model, plan.fingerprint)).rejects.toThrow('The diff changed since it was shown; run /review again');
  const fresh = await d.manager.reviewPlan(d.agent.id);
  await expect(d.manager.review(d.agent.id, pick.keyId, 'gpt-made-up', fresh.fingerprint)).rejects.toThrow('Pick one of the models /review offered');
  d.live.info.status = 'running';
  await expect(d.manager.reviewPlan(d.agent.id)).rejects.toThrow('Stop or wait for the agent first; it is running');
  expect(d.prompts).toHaveLength(0);
});

it('a budget that would be passed refuses; a failed request says so with fixed words and the card says failed', async () => {
  const d = await daemon({ budgets: { daily: 0.000001, weekly: null, monthly: null } });
  const plan = await d.manager.reviewPlan(d.agent.id), pick = plan.models[0];
  if (!pick) throw new Error('no model');
  await expect(d.manager.review(d.agent.id, pick.keyId, pick.model, plan.fingerprint)).rejects.toThrow('The review would pass your daily budget');
  const e = await daemon({}, async () => { throw new Error(`provider said ${SECRET}`); });
  const p2 = await e.manager.reviewPlan(e.agent.id), m2 = p2.models[0];
  if (!m2) throw new Error('no model');
  await expect(e.manager.review(e.agent.id, m2.keyId, m2.model, p2.fingerprint)).rejects.toThrow(/^The review request failed$/);
  expect(e.manager.get(e.agent.id).review).toEqual({ state: 'failed' });
});

it('auto-review (off by default) runs on a finished turn with the model you last picked, under its daily budget', async () => {
  const d = await daemon();
  await d.manager.afterTurn(d.agent.id);
  expect(d.prompts).toHaveLength(0);
  await new SettingsStore(d.home).set({ autoReview: true, autoReviewDailyUsd: 1 });
  await d.manager.afterTurn(d.agent.id);
  expect(d.prompts).toHaveLength(0); // no model picked yet: /review once picks it
  await d.manager.review(d.agent.id, d.key.id, 'claude-haiku-5', (await d.manager.reviewPlan(d.agent.id)).fingerprint);
  await writeFile(join(d.agent.worktree ?? '', 'next.ts'), 'y\n');
  await d.manager.afterTurn(d.agent.id);
  expect(d.prompts).toHaveLength(2); expect(d.prompts[1]?.model).toBe('claude-haiku-5');
  expect(d.manager.get(d.agent.id).review).toEqual({ state: 'done', high: 1, medium: 0, low: 1, auto: true });
  // Nothing changed since: no second review of the same diff.
  await d.manager.afterTurn(d.agent.id);
  expect(d.prompts).toHaveLength(2);
  // Its own daily budget: once today's auto-reviews would pass it, they stop (and the card doesn't pretend).
  await new SettingsStore(d.home).set({ autoReviewDailyUsd: 0.01 });
  await writeFile(join(d.agent.worktree ?? '', 'again.ts'), 'z\n');
  await d.manager.afterTurn(d.agent.id);
  expect(d.prompts).toHaveLength(2);
  expect(JSON.parse(await readFile(join(d.home, 'auto-review.json'), 'utf8'))).toMatchObject({ spentUsd: expect.any(Number) });
});

// ---- Part F review findings ----
it('MEDIUM (security review): passwords in URLs, npm and Stripe tokens are removed before the diff goes out', async () => {
  const { redactSecrets } = await import('../src/shared/redact.js');
  const npm = 'npm_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8', stripe = 'rk_live_' + '51Habc123DEF456ghi789JKL', live = 'sk_live_' + '51Habc123DEF456ghi789JKL';
  const out = redactSecrets(`DATABASE_URL=postgres://admin:S3cretPw@host/app\nfetch("https://bob:hunter22@example.com/x")\n${npm} ${stripe} ${live}`);
  for (const secret of ['S3cretPw', 'hunter22', npm, stripe, live]) expect(out).not.toContain(secret);
  expect(out).toContain('example.com/x');
});

it('MEDIUM (TS review): an auto-review refused before anything was sent books nothing in its daily budget', async () => {
  const d = await daemon();
  await d.manager.review(d.agent.id, d.key.id, 'claude-haiku-5', (await d.manager.reviewPlan(d.agent.id)).fingerprint);
  await new SettingsStore(d.home).set({ autoReview: true, autoReviewDailyUsd: 1 });
  await writeFile(join(d.agent.worktree ?? '', 'next.ts'), 'y\n');
  (d.manager as unknown as { reviewing: Set<string> }).reviewing.add(d.agent.id);
  await d.manager.afterTurn(d.agent.id);
  expect(JSON.parse(await readFile(join(d.home, 'auto-review.json'), 'utf8')).spentUsd).toBe(0);
});

it('LOW (TS review): a review that ends after the agent went back to work doesn\'t put a stale result on the card', async () => {
  let release: () => void = () => {};
  const d = await daemon({}, async () => { await new Promise<void>(resolve => { release = resolve; }); return { text: 'HIGH: x', inputTokens: 10, outputTokens: 5 }; });
  const plan = await d.manager.reviewPlan(d.agent.id), pick = plan.models[0];
  if (!pick) throw new Error('no model');
  const reviewing = d.manager.review(d.agent.id, pick.keyId, pick.model, plan.fingerprint);
  await vi.waitFor(() => expect(d.manager.get(d.agent.id).review).toEqual({ state: 'running' }));
  d.live.info.status = 'running'; release();
  await reviewing;
  expect(d.manager.get(d.agent.id).review).toBeUndefined();
});

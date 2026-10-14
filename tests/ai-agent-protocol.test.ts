import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { realpathSync } from 'node:fs';
import { validateRequest, validateSession, validateSettings, validateSettingsPatch, isPermissionForEngine, isEffortForEngine } from '../src/shared/validate.js';
import { keyEngine, modelChoices } from '../src/shared/models.js';
import type { KeyView } from '../src/shared/protocol.js';

// v0.4.1: engine 'ai-term' is AI Term's own agent. It runs only on an API key (D47).
const cwd = realpathSync(tmpdir()), keyId = randomUUID();
const create = (fields: Record<string, unknown>) => validateRequest({ id: randomUUID(), kind: 'sessions.create', engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId }, cwd, permission: 'ask', ...fields });

it('an ai-term start needs key auth, Ask or Don\'t ask, and no effort level', async () => {
  await expect(create({})).resolves.toMatchObject({ engine: 'ai-term' });
  await expect(create({ permission: 'dontAsk' })).resolves.toMatchObject({ permission: 'dontAsk' });
  await expect(create({ auth: { kind: 'account' } })).rejects.toThrow();
  await expect(create({ permission: 'auto' })).rejects.toThrow();
  await expect(create({ effort: 'high' })).rejects.toThrow();
  await expect(create({ effort: null })).resolves.toBeDefined();
  await expect(create({ login: true, model: null, auth: { kind: 'account' } })).rejects.toThrow();
  expect(isPermissionForEngine('ai-term', 'ask')).toBe(true); expect(isPermissionForEngine('ai-term', 'auto')).toBe(false);
  expect(isEffortForEngine('ai-term', null)).toBe(true); expect(isEffortForEngine('ai-term', 'low')).toBe(false);
});

it('ai-term session records validate; an account-auth ai-term record does not', () => {
  const now = new Date().toISOString();
  const record = { id: randomUUID(), title: 'AI Term', engine: 'ai-term', model: 'gpt-6.1-sol', auth: { kind: 'key', keyId, provider: 'foundry', keyLabel: 'narvis', last4: 'ITid' }, cwd, permission: 'ask', status: 'running', statusDetail: 'running', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, effort: null };
  expect(validateSession(record).engine).toBe('ai-term');
  expect(() => validateSession({ ...record, auth: { kind: 'account' } })).toThrow();
});

it('keysRunOn is a setting with two values; the saved default engine stays a CLI', () => {
  expect(validateSettingsPatch({ keysRunOn: 'cli' }, true)).toEqual({ keysRunOn: 'cli' });
  expect(validateSettingsPatch({ keysRunOn: 'ai-term' }, true)).toEqual({ keysRunOn: 'ai-term' });
  expect(() => validateSettingsPatch({ keysRunOn: 'codex' }, true)).toThrow();
  expect(() => validateSettings({ theme: 'graphite', defaultEngine: 'ai-term' })).toThrow();
});

const foundry: KeyView = { id: keyId, provider: 'foundry', label: 'narvis', last4: 'ITid', endpoint: 'https://narvis-resource.openai.azure.com/openai/v1', deployments: ['gpt-6.1-sol', 'kimi-k3'], lastTest: [{ model: 'gpt-6.1-sol', status: 'ready' }, { model: 'kimi-k3', status: 'not a chat model' }] };
const anthropic: KeyView = { id: randomUUID(), provider: 'anthropic', label: 'a', last4: 'abcd' };

it('D47 routing (v0.4.2): every key runs on ai term unless the fallback says the CLI; accounts always run the CLIs', () => {
  for (const provider of ['foundry', 'anthropic', 'openai'] as const) { expect(keyEngine(provider, undefined)).toBe('ai-term'); expect(keyEngine(provider, 'ai-term')).toBe('ai-term'); }
  expect(keyEngine('foundry', 'cli')).toBe('codex'); expect(keyEngine('openai', 'cli')).toBe('codex'); expect(keyEngine('anthropic', 'cli')).toBe('claude-code');
  const rows = modelChoices([foundry, anthropic], undefined, 'ai-term');
  // A Chat Completions deployment (tested 'not a chat model' before v0.4.2, 'chat' now) runs on AI Term's agent only.
  expect(rows.filter(r => r.group?.startsWith('FOUNDRY')).map(r => [r.engine, r.model])).toEqual([['ai-term', 'gpt-6.1-sol'], ['ai-term', 'kimi-k3']]);
  expect(rows.filter(r => r.auth?.kind === 'account').every(r => r.engine !== 'ai-term')).toBe(true);
  const claude = rows.filter(r => r.auth?.kind === 'key' && r.group === 'ANTHROPIC');
  expect(claude.length).toBeGreaterThan(3); expect(claude.every(r => r.engine === 'ai-term' && r.model?.startsWith('claude-'))).toBe(true);
  const cli = modelChoices([foundry, anthropic], undefined, 'cli').filter(r => r.auth?.kind === 'key');
  expect(cli.filter(r => r.group?.startsWith('FOUNDRY')).map(r => [r.engine, r.model])).toEqual([['codex', 'gpt-6.1-sol']]);
  expect(cli.filter(r => r.group === 'ANTHROPIC').map(r => [r.engine, r.model])).toEqual([['claude-code', null], ['claude-code', 'opus'], ['claude-code', 'sonnet']]);
});

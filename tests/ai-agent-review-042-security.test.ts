import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, realpath, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { UsageService } from '../src/daemon/usage-service.js';
import { Logger } from '../src/daemon/log.js';
import { HttpReporter } from '../src/agent/report.js';
import { RunLimits, estimateTokens } from '../src/agent/limits.js';
import { deploymentAlias } from '../src/daemon/usage-prices.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.4.2 security review findings, each reproduced here before its fix.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('MEDIUM: a fast AI Term agent loop is counted whole in Usage and budgets, not cut at the CLI export rate', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-sec042-'))); roots.push(root); await mkdir(join(root, 'logs'), { recursive: true });
  const usage = new UsageService(root, new Logger(join(root, 'logs', 'daemon.log'))); await usage.start();
  try {
    const telemetry = usage.register({ sessionId: randomUUID(), engine: 'ai-term', provider: 'anthropic', model: 'claude-sonnet-5' });
    const reporter = new HttpReporter({ port: telemetry.port, status: 'a'.repeat(64), usage: telemetry.credential }, () => {});
    for (let i = 0; i < 100; i++) await reporter.usage('claude-sonnet-5', { input: 10_000, cached: 5_000, output: 1000 });
    expect(usage.summary().today.tokens).toBe(1_100_000);
  } finally { await usage.close(); }
});

it('LOW: the worst case counts dense text (CJK, emoji) as a token per character, not a third', () => {
  expect(estimateTokens('a'.repeat(3000))).toBe(1000);
  expect(estimateTokens('漢'.repeat(3000))).toBeGreaterThanOrEqual(3000);
  const limits = new RunLimits();
  const tight = stubFacts({ price: { input: 1, output: 0 }, output: 1, caps: { turns: null, spendUsd: 0.004 } });
  expect(limits.check(tight, estimateTokens('a'.repeat(9000)))).toBeNull();
  expect(limits.check(tight, estimateTokens('漢'.repeat(9000)))?.text).toContain('cap reached');
});

it('nit: a deployment named like an Object property has no alias unless one was set', () => {
  expect(deploymentAlias({ theme: 'graphite', deploymentModels: {} }, 'toString')).toBeUndefined();
  expect(deploymentAlias({ theme: 'graphite', deploymentModels: { 'my-kimi': 'kimi-k2.6' } }, 'my-kimi')).toBe('kimi-k2.6');
});

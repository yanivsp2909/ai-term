import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { BudgetLedger, type Reservation } from '../src/daemon/budget-ledger.js';
import { parseAgentFacts, parseBudgetAnswer } from '../src/shared/agent-facts.js';
import { validateUsageRecord } from '../src/shared/validate.js';
import { stubFacts } from './fixtures/agent-facts.js';

// v0.6.1 (B25): the daemon holds the budget. Every request's worst case is reserved here first, across all agents.
const roots: string[] = [];
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function ledger(options: { ttlMs?: number } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'ai-ledger-')); roots.push(root);
  const booked: Reservation[] = [], errors: string[] = [], file = join(root, 'budget-reservations.json');
  const made = new BudgetLedger({ file, book: async r => { booked.push(r); }, log: { error: text => { errors.push(text); } }, ...options });
  return { ledger: made, booked, errors, file };
}
const daily = (limit: number) => ({ daily: limit, weekly: null, monthly: null });
const spent = (day: number) => ({ day, week: day, month: day });
const request = (sessionId: string, amountUsd: number) => ({ sessionId, provider: 'foundry' as const, model: 'gpt-6.1-sol', amountUsd });

it('two agents racing for the last of a daily budget: exactly one reservation is granted', async () => {
  const { ledger: l } = await ledger(), a = randomUUID(), b = randomUUID();
  const first = l.reserve(request(a, 0.3), daily(1), spent(0.5)), second = l.reserve(request(b, 0.3), daily(1), spent(0.5));
  expect('grant' in first).toBe(true);
  expect(second).toEqual({ refused: { budget: 'daily', spent: 0.5, reserved: 0.3, limit: 1 } });
  expect(l.reserved()).toBeCloseTo(0.3, 10);
  await l.close();
});

it('every budget is checked; no budget grants anything; a bad amount is refused', async () => {
  const { ledger: l } = await ledger(), id = randomUUID();
  expect(l.reserve(request(id, 2), { daily: null, weekly: 10, monthly: 2.5 }, { day: 0, week: 1, month: 1 })).toEqual({ refused: { budget: 'monthly', spent: 1, reserved: 0, limit: 2.5 } });
  expect('grant' in l.reserve(request(id, 50), { daily: null, weekly: null, monthly: null }, spent(9))).toBe(true);
  for (const amount of [-1, Number.NaN, Number.POSITIVE_INFINITY]) expect(l.reserve(request(id, amount), daily(10), spent(0))).toMatchObject({ refused: { budget: 'unavailable' } });
  await l.close();
});

it('settling releases a reported request, books an unreported one once, and only for the session that holds it', async () => {
  const { ledger: l, booked } = await ledger(), a = randomUUID(), b = randomUUID();
  const one = l.reserve(request(a, 0.2), daily(5), spent(0)), two = l.reserve(request(a, 0.4), daily(5), spent(0));
  if (!('grant' in one) || !('grant' in two)) throw new Error('expected grants');
  expect(await l.settle(b, one.grant.id, true)).toBe(false);
  expect(await l.settle(a, one.grant.id, false)).toBe(true); expect(booked).toEqual([]);
  expect(await l.settle(a, two.grant.id, true)).toBe(true); expect(await l.settle(a, two.grant.id, true)).toBe(false);
  expect(booked).toEqual([expect.objectContaining({ id: two.grant.id, sessionId: a, amountUsd: 0.4, provider: 'foundry', model: 'gpt-6.1-sol' })]);
  expect(l.reserved()).toBe(0);
  await l.close();
});

it('a reservation nobody settles expires at its worst case; an exited agent\'s reservations are booked at once', async () => {
  vi.useFakeTimers();
  const { ledger: l, booked, errors } = await ledger({ ttlMs: 1000 }), a = randomUUID(), b = randomUUID();
  l.reserve(request(a, 0.1), daily(5), spent(0)); l.reserve(request(b, 0.2), daily(5), spent(0));
  await l.releaseSession(b); expect(booked.map(r => r.amountUsd)).toEqual([0.2]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(booked.map(r => r.amountUsd)).toEqual([0.2, 0.1]); expect(errors).toContain('Budget reservation expired; booked at its worst case');
  expect(l.reserved()).toBe(0);
  await l.close();
});

it('a daemon restart books what the last one still held, from a private file, and fails closed while closed', async () => {
  const first = await ledger(), a = randomUUID();
  first.ledger.reserve(request(a, 0.7), daily(5), spent(0)); await first.ledger.close();
  expect((await stat(first.file)).mode & 0o777).toBe(0o600);
  expect(first.ledger.reserve(request(a, 0.1), daily(5), spent(0))).toMatchObject({ refused: { budget: 'unavailable' } });
  const booked: Reservation[] = [], next = new BudgetLedger({ file: first.file, book: async r => { booked.push(r); }, log: { error() {} } });
  await next.load();
  expect(booked).toEqual([expect.objectContaining({ sessionId: a, amountUsd: 0.7 })]);
  expect(JSON.parse(await readFile(first.file, 'utf8'))).toEqual({ v: 1, reservations: [] });
  // A malformed record is skipped with a fixed log line, never booked or trusted.
  await writeFile(first.file, JSON.stringify({ v: 1, reservations: [{ id: 'x', amountUsd: 1e9 }] }));
  const errors: string[] = [], again = new BudgetLedger({ file: first.file, book: async r => { booked.push(r); }, log: { error: text => { errors.push(text); } } });
  await again.load(); expect(booked).toHaveLength(1); expect(errors).toEqual(['Budget reservation record unreadable; skipped']);
  await next.close(); await again.close();
});

it('contract: facts carry what every agent holds; reserve answers are exact; worst-case bookings are valid usage records', () => {
  expect(parseAgentFacts(stubFacts({ reserved: 0.25 }))?.reserved).toBe(0.25);
  const old: Record<string, unknown> = { ...stubFacts() }; delete old.reserved;
  expect(parseAgentFacts(old)).toBeNull();
  expect(parseAgentFacts({ ...stubFacts(), reserved: -1 })).toBeNull();
  const id = randomUUID();
  expect(parseBudgetAnswer({ grant: { id } })).toEqual({ grant: { id } });
  expect(parseBudgetAnswer({ refused: { budget: 'weekly', spent: 1, reserved: 0.5, limit: 2 } })).toEqual({ refused: { budget: 'weekly', spent: 1, reserved: 0.5, limit: 2 } });
  for (const bad of [null, {}, { grant: { id: 'nope' } }, { grant: { id }, extra: 1 }, { refused: { budget: 'yearly', spent: 1, reserved: 0, limit: 2 } }, { refused: { budget: 'daily', spent: -1, reserved: 0, limit: 2 } }]) expect(parseBudgetAnswer(bad)).toBeNull();
  expect(validateUsageRecord({ ts: new Date().toISOString(), sessionId: id, provider: 'openai', model: 'gpt-6.1-sol', inputTokens: 0, outputTokens: 0, costUsd: 0.4, costSource: 'worst-case' }).costSource).toBe('worst-case');
});

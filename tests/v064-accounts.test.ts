import { afterEach, expect, it, vi } from 'vitest';
import { lstat, mkdir, mkdtemp, readlink, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import pty from 'node-pty';
import { buildSpawnEnv } from '../src/daemon/env.js';
import { prepareProfile, profileDir } from '../src/daemon/accounts.js';
import { parseLimit } from '../src/daemon/limit-detect.js';
import { validateSettingsPatch, validateSession, validateRequest } from '../src/shared/validate.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import * as engines from '../src/daemon/engines.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v0.6.4 several accounts per engine (D53): each its own config folder under ~/.ai-term/profiles, the CLI's own login.
const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-accounts-'))); roots.push(root); return root; };

it('account profiles are validated: names, engine, at most 10, own reserved, defaults by name', () => {
  expect(validateSettingsPatch({ accounts: [{ name: 'work', engine: 'claude-code' }, { name: 'side', engine: 'codex' }], defaultAccounts: { 'claude-code': 'work' } }, true)).toMatchObject({ defaultAccounts: { 'claude-code': 'work' } });
  for (const bad of [[{ name: 'own', engine: 'codex' }], [{ name: 'Work', engine: 'codex' }], [{ name: 'a', engine: 'ai-term' }], [{ name: 'a', engine: 'codex', token: 'x' }], [{ name: 'a', engine: 'codex' }, { name: 'a', engine: 'claude-code' }], Array.from({ length: 11 }, (_, i) => ({ name: `a${i}`, engine: 'codex' }))])
    expect(() => validateSettingsPatch({ accounts: bad }, true)).toThrow();
  expect(() => validateSettingsPatch({ defaultAccounts: { codex: 'Bad Name' } }, true)).toThrow();
});

it('an account reference names a profile only; a session record says which one it used', async () => {
  const cwd = await temp();
  expect((await validateRequest({ id: randomUUID(), kind: 'sessions.create', engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'work' }, cwd, permission: 'ask' })).kind).toBe('sessions.create');
  await expect(validateRequest({ id: randomUUID(), kind: 'sessions.create', engine: 'claude-code', model: null, auth: { kind: 'account', profile: '../x' }, cwd, permission: 'ask' })).rejects.toThrow();
  const now = new Date().toISOString(), s: SessionInfo = { id: randomUUID(), title: 'x', engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'work' }, authMethod: 'subscription', cwd, permission: 'ask', status: 'running', statusDetail: 'running', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null };
  expect(validateSession(s).auth).toEqual({ kind: 'account', profile: 'work' });
  expect(cardText(s, Date.now(), 60).auth).toBe('own login · sub · work');
});

it('env.ts alone points a CLI at its profile folder; nothing else changes', () => {
  const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/Users/x/.claude-mine', CODEX_HOME: '/Users/x/.codex-mine' };
  const claude = buildSpawnEnv('claude-code', { kind: 'account' }, base, { profileDir: '/r/profiles/work' });
  expect(claude.CLAUDE_CONFIG_DIR).toBe('/r/profiles/work'); expect(claude.CODEX_HOME).toBe('/Users/x/.codex-mine');
  const codex = buildSpawnEnv('codex', { kind: 'account' }, base, { profileDir: '/r/profiles/side' });
  expect(codex.CODEX_HOME).toBe('/r/profiles/side'); expect(codex.CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-mine');
  expect(buildSpawnEnv('claude-code', { kind: 'account' }, base).CLAUDE_CONFIG_DIR).toBe('/Users/x/.claude-mine');
});

it('a profile folder is private and shares only your skills, agents and commands by symlink', async () => {
  const root = await temp(), home = await temp();
  await mkdir(join(home, '.claude', 'skills'), { recursive: true }); await mkdir(join(home, '.claude', 'agents'));
  await writeFile(join(home, '.claude', 'settings.json'), '{}'); await writeFile(join(home, '.claude', '.credentials.json'), 'secret');
  const dir = await prepareProfile(root, 'claude-code', 'work', home);
  expect(dir).toBe(profileDir(root, 'work'));
  expect((await stat(dir)).mode & 0o777).toBe(0o700); expect((await stat(join(root, 'profiles'))).mode & 0o777).toBe(0o700);
  expect(await readlink(join(dir, 'skills'))).toBe(join(home, '.claude', 'skills'));
  expect(await readlink(join(dir, 'agents'))).toBe(join(home, '.claude', 'agents'));
  await expect(lstat(join(dir, 'commands'))).rejects.toThrow(); // no ~/.claude/commands to share
  for (const never of ['settings.json', '.credentials.json', 'history.jsonl', 'projects']) await expect(lstat(join(dir, never))).rejects.toThrow();
  // Again: idempotent, and a profile folder that is a symlink is refused.
  await prepareProfile(root, 'claude-code', 'work', home);
  await symlink(home, join(root, 'profiles', 'evil'));
  await expect(prepareProfile(root, 'codex', 'evil', home)).rejects.toThrow();
  const codex = await prepareProfile(root, 'codex', 'side', home);
  await expect(lstat(join(codex, 'prompts'))).rejects.toThrow();
});

it('a limit on screen is read with its reset time when it says one', () => {
  expect(parseLimit('working…\n5-hour limit reached ∙ resets 3pm (Asia/Jerusalem)\n> ')).toEqual({ resets: '15:00' });
  expect(parseLimit('Claude usage limit reached. Your limit will reset at 7:30 pm.')).toEqual({ resets: '19:30' });
  expect(parseLimit("■ You've hit your usage limit. Upgrade to Pro or try again at 3:45 PM.")).toEqual({ resets: '15:45' });
  expect(parseLimit("You've hit your usage limit. Try again in 2 hours.")).toEqual({ resets: null });
  expect(parseLimit('a normal reply that mentions limits and resets')).toBeNull();
});

it('the card shows a limit with its reset time instead of the activity', () => {
  const now = new Date().toISOString(), s: SessionInfo = { id: randomUUID(), title: 'x', engine: 'codex', model: null, auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: null, lastActivity: null, limit: { resets: '15:00' } };
  expect(cardText(s, Date.now(), 60).line3.startsWith('⏸ limit · resets 15:00')).toBe(true);
  expect(cardText({ ...s, limit: { resets: null } }, Date.now(), 60).line3.startsWith('⏸ limit')).toBe(true);
  expect(validateSession(s).limit).toEqual({ resets: '15:00' });
});

async function daemon(settings: Record<string, unknown>, script = 'printf ready; read done') {
  const root = await temp(), paths = getPaths(root); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', ...settings }), { mode: 0o600 });
  const manager = new SessionManager(paths, new Logger(paths.log));
  await manager.load(); roots.push(root);
  const spawned: { args: string[]; env: Record<string, string> }[] = [];
  const real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => { spawned.push({ args: Array.isArray(args) ? [...args] : [], env: { ...(options?.env as Record<string, string>) } }); return real('/bin/sh', ['-c', script], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  const checks: (string | undefined)[] = [];
  vi.spyOn(engines, 'checkEngine').mockImplementation(async (_engine, _base, _runner, profile) => { checks.push(profile); return { installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' }; });
  return { root, manager, spawned, checks, close: () => manager.shutdown() };
}

it('an agent on an account runs with that profile folder; the default account applies when none is picked; own is your normal login', async () => {
  const d = await daemon({ accounts: [{ name: 'work', engine: 'claude-code' }], defaultAccounts: { 'claude-code': 'work' } });
  try {
    const picked = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'work' }, cwd: d.root, permission: 'ask' });
    expect(d.spawned.at(-1)?.env.CLAUDE_CONFIG_DIR).toBe(join(d.root, 'profiles', 'work')); expect(d.checks.at(-1)).toBe(join(d.root, 'profiles', 'work'));
    expect(picked.auth).toEqual({ kind: 'account', profile: 'work' });
    const defaulted = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask' });
    expect(defaulted.auth).toEqual({ kind: 'account', profile: 'work' });
    const own = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'own' }, cwd: d.root, permission: 'ask' });
    expect(own.auth).toEqual({ kind: 'account' }); expect(d.spawned.at(-1)?.env.CLAUDE_CONFIG_DIR).toBeUndefined();
    await expect(d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account', profile: 'work' }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Account not found for this engine');
    await expect(d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'gone' }, cwd: d.root, permission: 'ask' })).rejects.toThrow('Account not found for this engine');
  } finally { await d.close(); }
});

it('logging in to an account runs the CLI\'s own login with only that profile folder; AI Term reads nothing from it', async () => {
  const d = await daemon({ accounts: [{ name: 'side', engine: 'codex' }] });
  try {
    await d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account', profile: 'side' }, cwd: d.root, permission: 'ask', login: true, title: 'Codex login · side' });
    expect(d.spawned.at(-1)?.env.CODEX_HOME).toBe(join(d.root, 'profiles', 'side'));
    expect(d.spawned.at(-1)?.args).toEqual(['--no-daemon', '-c', 'check_for_update_on_startup=false', 'login']);
    expect((await stat(join(d.root, 'profiles', 'side'))).mode & 0o777).toBe(0o700);
  } finally { await d.close(); }
});

it('a limit that shows on an agent\'s screen reaches its record, and goes when the screen moves on', async () => {
  const d = await daemon({}, "printf '5-hour limit reached \\342\\210\\231 resets 3pm\\r\\n'; read done; printf '\\033[2J\\033[Hback to work\\r\\n'; sleep 5");
  try {
    const s = await d.manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask' });
    await expect.poll(() => d.manager.get(s.id).limit, { timeout: 4000 }).toEqual({ resets: '15:00' });
    const live = (d.manager as unknown as { sessions: Map<string, { host?: { write(t: string): void } }> }).sessions.get(s.id);
    live?.host?.write('\r');
    await expect.poll(() => d.manager.get(s.id).limit, { timeout: 4000 }).toBeUndefined();
  } finally { await d.close(); }
});

import { UsageService } from '../src/daemon/usage-service.js';
import type { PriceSnapshot } from '../src/daemon/usage-prices.js';
it('a handoff can continue on another account of the same engine, same folder, the CLI\'s own login for that account', async () => {
  const root = await temp(), paths = getPaths(root); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', handoff: true, accounts: [{ name: 'work', engine: 'claude-code' }] }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), manager = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage);
  manager.setHandoffWriter({ prices: { fetchedAt: 'x', providers: { anthropic: {}, openai: {}, azure: {} } } as PriceSnapshot, summarize: async () => ({ text: 'unused', inputTokens: 0, outputTokens: 0 }) });
  await usage.start(); await manager.load();
  const spawned: Record<string, string>[] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((_file, _args, options) => { spawned.push({ ...(options?.env as Record<string, string>) }); return real('/bin/sh', ['-c', 'printf ready; read done; sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' });
  try {
    const source = await manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: root, permission: 'ask', title: 'fixer' });
    await expect.poll(() => manager.get(source.id).status).toBe('running');
    const m = manager as unknown as { sessions: Map<string, { reported?: boolean }>; ingressStatus(id: string, update: unknown): void };
    const live = m.sessions.get(source.id); if (live) live.reported = true;
    m.ingressStatus(source.id, { event: { seq: 50, at: new Date().toISOString(), kind: 'done' }, reply: 'before' });
    expect((await manager.handoffPlan(source.id, 'claude-code', 'work')).account).toBe('work');
    const handing = manager.handoff(source.id, 'claude-code', { kind: 'agent' }, 'work');
    await new Promise(resolve => setTimeout(resolve, 300));
    m.ingressStatus(source.id, { event: { seq: 99, at: new Date().toISOString(), kind: 'done' }, reply: '## Goal\nship' });
    const result = await handing;
    expect(result.session.auth).toEqual({ kind: 'account', profile: 'work' });
    expect(spawned.at(-1)?.CLAUDE_CONFIG_DIR).toBe(join(root, 'profiles', 'work'));
    await expect(manager.handoffPlan(result.session.id, 'claude-code', 'nobody')).rejects.toThrow('Account not found for this engine');
  } finally { await manager.shutdown(); await usage.close(); }
});

// Part F security review (2026-10-15).
it('MEDIUM review: unreadable settings never start an account agent on a guessed account', async () => {
  const d = await daemon({ accounts: [{ name: 'work', engine: 'codex' }], defaultAccounts: { codex: 'work' } });
  try {
    await writeFile(join(d.root, 'settings.json'), '{not json', { mode: 0o600 });
    const before = d.spawned.length;
    await expect(d.manager.create({ engine: 'codex', model: null, auth: { kind: 'account' }, cwd: d.root, permission: 'ask' })).rejects.toThrow("Settings unreadable; can't tell which account to use");
    expect(d.spawned.length).toBe(before);
  } finally { await d.close(); }
});
it('LOW review: a handoff with no account named checks and starts the same account: the engine default', async () => {
  const root = await temp(), paths = getPaths(root); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', handoff: true, accounts: [{ name: 'work', engine: 'claude-code' }], defaultAccounts: { 'claude-code': 'work' } }), { mode: 0o600 });
  const log = new Logger(paths.log), usage = new UsageService(root, log), manager = new SessionManager(paths, log, undefined, undefined, undefined, undefined, usage);
  manager.setHandoffWriter({ prices: { fetchedAt: 'x', providers: { anthropic: {}, openai: {}, azure: {} } } as PriceSnapshot, summarize: async () => ({ text: 'unused', inputTokens: 0, outputTokens: 0 }) });
  await usage.start(); await manager.load();
  const real = pty.spawn; vi.spyOn(pty, 'spawn').mockImplementation((_f, _a, options) => real('/bin/sh', ['-c', 'printf ready; read done; sleep 30'], { ...options, env: { PATH: '/usr/bin:/bin' } }));
  const checks: (string | undefined)[] = [];
  vi.spyOn(engines, 'checkEngine').mockImplementation(async (_e, _b, _r, profile) => { checks.push(profile); return { installed: true, path: '/bin/sh', version: '1', loggedIn: true, authMethod: 'subscription' }; });
  try {
    const source = await manager.create({ engine: 'claude-code', model: null, auth: { kind: 'account', profile: 'own' }, cwd: root, permission: 'ask', title: 'fixer' });
    await expect.poll(() => manager.get(source.id).status).toBe('running');
    expect((await manager.handoffPlan(source.id, 'claude-code')).account).toBe('work');
    expect(checks.at(-1)).toBe(join(root, 'profiles', 'work'));
  } finally { await manager.shutdown(); await usage.close(); }
});

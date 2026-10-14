import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import headless from '@xterm/headless';
import { Homepage } from '../src/client/tui/homepage.js';
import { parsePresetCommand, presetProblem, presetLines } from '../src/client/tui/presets.js';
import { validatePreset, MAX_PRESETS, type Preset } from '../src/shared/presets.js';
import { validateRequest, validateSettingsPatch } from '../src/shared/validate.js';
import type { KeyView, SessionInfo, Settings, SuccessResponse } from '../src/shared/protocol.js';
import type { RequestBody } from '../src/client/connection.js';

// v0.6.2 presets (D55, on by default): a saved start setup, never a key.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const folder = async () => { const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-preset-'))); roots.push(root); return root; };
const key: KeyView = { id: randomUUID(), provider: 'anthropic', label: 'work', last4: 'abcd' };
const preset = (over: Partial<Preset> = {}): Preset => ({ engine: 'claude-code', model: 'sonnet', effort: 'high', auth: { kind: 'account' }, permission: 'ask', cwd: '/tmp', worktree: true, ...over });

it('a preset holds the start setup only: engine, model, effort, auth reference, mode, folder, worktree, first message', () => {
  expect(validatePreset(preset({ firstMessage: 'run the tests' }))).toEqual(preset({ firstMessage: 'run the tests' }));
  expect(validatePreset(preset({ engine: 'ai-term', model: 'claude-sonnet-5', effort: null, auth: { kind: 'key', keyId: key.id }, permission: 'dontAsk' })).permission).toBe('dontAsk');
  for (const bad of [{ ...preset(), secret: 'sk-x' }, preset({ auth: { kind: 'key', keyId: 'nope' } }), preset({ engine: 'codex', permission: 'auto' }), preset({ cwd: 'relative' }), preset({ worktree: 'yes' as never }), preset({ firstMessage: 'x'.repeat(4097) }), preset({ engine: 'ai-term', auth: { kind: 'account' } }), preset({ model: '-rf' })])
    expect(() => validatePreset(bad)).toThrow();
});

it('settings store presets by name with the existing validators: names, count and contents', () => {
  expect(validateSettingsPatch({ presets: { 'fix-tests': preset() }, presetsEnabled: true }, true)).toEqual({ presets: { 'fix-tests': preset() }, presetsEnabled: true });
  for (const name of ['', 'Has Space', '-dash', 'x'.repeat(33), '__proto__']) expect(() => validateSettingsPatch({ presets: { [name]: preset() } }, true)).toThrow();
  expect(() => validateSettingsPatch({ presets: Object.fromEntries(Array.from({ length: MAX_PRESETS + 1 }, (_, i) => [`p${i}`, preset()])) }, true)).toThrow();
  expect(() => validateSettingsPatch({ presets: { ok: { ...preset(), permission: 'yolo' } } }, true)).toThrow();
});

it('sessions.create takes a worktree on/off for this one agent', async () => {
  const cwd = await folder();
  expect((await validateRequest({ id: randomUUID(), kind: 'sessions.create', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd, permission: 'ask', useWorktree: false })).kind).toBe('sessions.create');
  await expect(validateRequest({ id: randomUUID(), kind: 'sessions.create', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd, permission: 'ask', useWorktree: 'no' })).rejects.toThrow();
});

it('/preset parses save, use, list and rm; a gone key or folder is a one-line reason', async () => {
  expect(parsePresetCommand('/preset')).toEqual({ kind: 'list' });
  expect(parsePresetCommand('/preset save fix-tests run npm test and fix it')).toEqual({ kind: 'save', name: 'fix-tests', firstMessage: 'run npm test and fix it' });
  expect(parsePresetCommand('/preset save fix-tests')).toEqual({ kind: 'save', name: 'fix-tests' });
  expect(parsePresetCommand('/preset rm fix-tests')).toEqual({ kind: 'rm', name: 'fix-tests' });
  expect(parsePresetCommand('/preset fix-tests')).toEqual({ kind: 'use', name: 'fix-tests' });
  for (const bad of ['/preset save', '/preset rm', '/preset Bad Name', '/preset rm a b']) expect(parsePresetCommand(bad)).toMatchObject({ kind: 'error' });
  const cwd = await folder();
  expect(await presetProblem('p', preset({ cwd }), [key])).toBeNull();
  expect(await presetProblem('p', preset({ cwd, auth: { kind: 'key', keyId: randomUUID() } }), [key])).toBe("preset p: its API key was removed · save it again with another key");
  expect(await presetProblem('p', preset({ cwd: join(cwd, 'gone') }), [key])).toBe(`preset p: folder ${join(cwd, 'gone')} is gone`);
  expect(presetLines({ p: preset({ cwd, permission: 'dontAsk', worktree: false, firstMessage: 'hi' }) }, [key])).toEqual([`p · sonnet · claude code · own login · ! don't ask · ${cwd} · worktree off · first message: hi`]);
});

class TTY extends EventEmitter { isTTY = true; isRaw = false; columns = 130; rows = 45; output = ''; setRawMode(v: boolean) { this.isRaw = v; } resume() {} pause() {} write(data: string | Buffer) { this.output += data.toString(); return true; } }
async function screen(tty: TTY): Promise<string> { const terminal = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(resolve => terminal.write(tty.output, resolve)); return Array.from({ length: 45 }, (_, y) => terminal.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { terminal.dispose(); } }
const shows = (tty: TTY, text: string) => vi.waitFor(async () => expect(await screen(tty)).toContain(text));
class Client extends EventEmitter {
  requests: RequestBody[] = []; settings: Settings = { theme: 'graphite' };
  async request(body: RequestBody): Promise<SuccessResponse> {
    this.requests.push(body);
    const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.set') this.settings = { ...this.settings, ...body.patch };
    if (body.kind === 'settings.get' || body.kind === 'settings.set') response.settings = this.settings;
    if (body.kind === 'sessions.list') response.sessions = [] as SessionInfo[];
    if (body.kind === 'keys.list') response.keys = [key];
    if (body.kind === 'engines.status') response.engines = { claudeCode: { installed: true, path: '/bin/claude', version: '1', loggedIn: true, authMethod: 'subscription' }, codex: { installed: true, path: '/bin/codex', version: '1', loggedIn: true, authMethod: 'subscription' } };
    if (body.kind === 'sessions.create') response.session = { id: randomUUID(), title: 'claude', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: body.cwd, permission: 'ask', status: 'starting', statusDetail: 'starting', statusSince: new Date().toISOString(), exitCode: null, createdAt: new Date().toISOString(), lastOutputAt: null, ctxPercent: null, lastActivity: null };
    return response;
  }
}
const type = (tty: TTY, text: string) => { for (const char of text) tty.emit('data', Buffer.from(char)); };
const enter = (tty: TTY) => tty.emit('data', Buffer.from('\r'));

it('/preset save keeps the next agent\'s setup; /preset <name> opens the start box with it; ⏎ starts it with its worktree choice', async () => {
  const cwd = await folder(), tty = new TTY(), client = new Client(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd, terminalProgram: 'unknown' });
  await home.start();
  try {
    type(tty, "/mode don't ask"); enter(tty); await vi.waitFor(() => expect(client.requests.some(r => r.kind === 'settings.get')).toBe(true));
    type(tty, '/preset save nightly fix the flaky test'); enter(tty);
    await shows(tty, "✓ preset nightly saved · ! don't ask");
    expect(client.settings.presets?.nightly).toMatchObject({ cwd, permission: 'dontAsk', firstMessage: 'fix the flaky test', auth: { kind: 'account' } });
    client.settings = { ...client.settings, presets: { nightly: { ...preset({ cwd, worktree: false, firstMessage: 'fix the flaky test' }), permission: 'dontAsk' } } };
    type(tty, '/preset nightly'); enter(tty);
    await shows(tty, 'preset         nightly · worktree off');
    await shows(tty, "! don't ask");
    enter(tty);
    await vi.waitFor(() => expect(client.requests.find(r => r.kind === 'sessions.create')).toMatchObject({ cwd, permission: 'dontAsk', useWorktree: false, firstMessage: 'fix the flaky test', model: 'sonnet', effort: 'high' }));
    type(tty, '/preset rm nightly'); enter(tty);
    await shows(tty, '✓ preset nightly removed');
    expect(client.settings.presets).toEqual({});
    client.settings = { ...client.settings, presetsEnabled: false };
    // The command menu's Enter first completes `/preset ` (it takes arguments); the second runs it.
    type(tty, '/preset'); enter(tty); enter(tty);
    await shows(tty, 'presets are off · /settings s turns them on');
  } finally { await home.stop(); }
});

it('in the start box p steps through saved presets; a preset whose folder is gone says why and is skipped', async () => {
  const cwd = await folder(), tty = new TTY(), client = new Client(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd, terminalProgram: 'unknown' });
  client.settings = { theme: 'graphite', presets: { alpha: preset({ cwd, model: 'opus', worktree: false }), beta: preset({ cwd: join(cwd, 'gone') }) } };
  await home.start();
  try {
    type(tty, 'a task'); enter(tty);
    await shows(tty, 'Start a new agent');
    type(tty, 'p'); await shows(tty, 'preset         alpha · worktree off'); await shows(tty, 'opus · claude code');
    type(tty, 'p'); await shows(tty, '✗ preset beta: folder '); await shows(tty, 'preset         alpha · worktree off');
    type(tty, 'p'); await vi.waitFor(async () => expect(await screen(tty)).not.toContain('✗ preset beta'));
  } finally { await home.stop(); }
});

import { CredentialsPanel } from '../src/client/tui/credentials.js';
it('/settings has its own switch for presets, on by default; s toggles it', async () => {
  let settings: Settings = { theme: 'graphite' };
  const panel = new CredentialsPanel('settings', { request: async body => { if (body.kind === 'settings.set') settings = { ...settings, ...body.patch }; return { id: randomUUID(), ok: true, settings, keys: [] }; }, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {}, caps: vi.fn() });
  await panel.load();
  expect(panel.lines().join('\n')).toContain('presets: on · /preset (s)');
  await panel.key('s'); expect(settings.presetsEnabled).toBe(false);
  expect(panel.lines().join('\n')).toContain('presets: off · /preset (s)');
});

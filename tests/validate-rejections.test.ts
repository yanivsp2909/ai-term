import { afterEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateRequest, validateSuccess, validateModes, validateExitCode, validateSettingsPatch, validateSettings, validateEngineStatus, validateSession, validateSystemStats, validCwd, ValidationError } from '../src/shared/validate.js';
// Every case names the message it expects, so a value can't pass by tripping an unrelated check first.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp() { const root = await mkdtemp(join(tmpdir(), 'ai-term-validate-')); roots.push(root); return root; }
const id = randomUUID(), sessionId = randomUUID();
const modes = { applicationCursorKeys: false, applicationKeypad: false, bracketedPaste: true, focusEvents: false, cursorVisible: true, mouseTracking: 'none', mouseEncoding: 'default' };
const engine = { installed: true, path: '/usr/local/bin/claude', version: '2.1.295', loggedIn: true, authMethod: 'subscription' };
const now = new Date().toISOString();
const session = { id: sessionId, title: 'shell', engine: 'shell', model: 'shell', auth: { kind: 'account' }, cwd: '/tmp', permission: 'ask', status: 'exited', statusDetail: 'exit 0', statusSince: now, createdAt: now, exitCode: 0, lastOutputAt: null, ctxPercent: null };

describe('validateRequest rejections', () => {
  it.each([null, undefined, 'hello', 7, [], [{ id, kind: 'sessions.list' }]])('refuses a non-object request %j', async value => {
    await expect(validateRequest(value)).rejects.toThrow('Expected a request object');
  });
  it.each([{ kind: 'sessions.list' }, { id: 'not-a-uuid', kind: 'sessions.list' }, { id, kind: 7 }, { id }])('refuses a request without a UUID id and string kind %j', async value => {
    await expect(validateRequest(value)).rejects.toThrow('Request needs a UUID id and kind');
  });
  it.each(['sessions.exec', 'shell', '__proto__', 'constructor', 'keys.get'])('refuses unknown kind %j', async kind => {
    await expect(validateRequest({ id, kind })).rejects.toThrow('Unknown request kind');
  });
  it.each([{ protocol: '1', version: '0.1.1' }, { protocol: 1.5, version: '0.1.1' }, { protocol: 1, version: 3 }, { protocol: 1, version: '' }, { protocol: 1, version: 'a b' }, { protocol: 1, version: 'x'.repeat(41) }])('refuses a malformed hello %j', async fields => {
    await expect(validateRequest({ id, kind: 'hello', ...fields })).rejects.toThrow('Invalid hello');
  });
  it('refuses an extra field on every kind, even a valid one', async () => {
    const cwd = await temp();
    for (const request of [{ id, kind: 'hello', protocol: 1, version: '1' }, { id, kind: 'settings.get' }, { id, kind: 'engines.status' }, { id, kind: 'sessions.create', engine: 'shell', cwd },
      { id, kind: 'sessions.attach', sessionId, cols: 80, rows: 24 }, { id, kind: 'sessions.preview', sessionId: null }, { id, kind: 'sessions.detach', sessionId },
      { id, kind: 'system.subscribe', on: true }, { id, kind: 'layout.previewSize', cols: 80, rows: 24 }]) {
      await expect(validateRequest(request)).resolves.toBeTruthy();
      await expect(validateRequest({ ...request, env: { PATH: '/tmp' } })).rejects.toThrow('Unexpected request field');
    }
    // A shell create carries no agent fields: a smuggled model or permission is refused, not ignored.
    for (const extra of [{ model: 'opus' }, { permission: 'dontAsk' }, { firstMessage: 'hi' }, { auth: { kind: 'account' } }])
      await expect(validateRequest({ id, kind: 'sessions.create', engine: 'shell', cwd, ...extra })).rejects.toThrow('Unexpected request field');
  });
  it.each(['bad', 7, {}, '00000000-0000-0000-0000-000000000000'])('refuses a preview of a non-UUID session %j', async value => {
    await expect(validateRequest({ id, kind: 'sessions.preview', sessionId: value })).rejects.toThrow('Invalid session UUID');
  });
  it.each(['sessions.attach', 'sessions.resize'])('%s refuses a bad session or a size outside 2–1000 x 1–500', async kind => {
    for (const fields of [{ sessionId: 'x', cols: 80, rows: 24 }, { sessionId, cols: 1, rows: 24 }, { sessionId, cols: 80, rows: 501 }, { sessionId, cols: 80.5, rows: 24 }, { sessionId, cols: '80', rows: 24 }, { sessionId }])
      await expect(validateRequest({ id, kind, ...fields })).rejects.toThrow('Invalid session UUID or size');
  });
  it.each(['sessions.detach', 'sessions.stop', 'sessions.remove'])('%s needs a session UUID', async kind => {
    await expect(validateRequest({ id, kind, sessionId: 'x' })).rejects.toThrow('Invalid session UUID or title');
    await expect(validateRequest({ id, kind })).rejects.toThrow('Invalid session UUID or title');
    // Only rename carries a title.
    await expect(validateRequest({ id, kind, sessionId, title: 'ok' })).rejects.toThrow('Unexpected request field');
  });
  it('rename refuses a missing, empty, too long or control-character title', async () => {
    for (const title of [undefined, '', 'x'.repeat(61), 'a\nb', 'bell\x07', 7])
      await expect(validateRequest({ id, kind: 'sessions.rename', sessionId, title })).rejects.toThrow('Invalid session UUID or title');
    expect(await validateRequest({ id, kind: 'sessions.rename', sessionId, title: '🙂'.repeat(60) })).toMatchObject({ title: '🙂'.repeat(60) });
  });
  it('create refuses a non-string title and a title that is empty once escapes are stripped', async () => {
    const cwd = await temp();
    await expect(validateRequest({ id, kind: 'sessions.create', engine: 'shell', cwd, title: 7 })).rejects.toThrow('Invalid title');
    for (const title of ['', '   ', '\x1b[31m\x1b[0m', '\x07\x00'])
      await expect(validateRequest({ id, kind: 'sessions.create', engine: 'shell', cwd, title })).rejects.toThrow('Invalid title');
    // A long title is cut to 60 characters, not refused.
    expect(await validateRequest({ id, kind: 'sessions.create', engine: 'shell', cwd, title: 'x'.repeat(100) })).toMatchObject({ title: 'x'.repeat(60) });
  });
  it('create checks the folder before anything else and refuses agent fields that fail their own checks', async () => {
    const cwd = await temp();
    const agent = { id, kind: 'sessions.create', engine: 'codex', model: null, auth: { kind: 'account' }, cwd, permission: 'ask' };
    for (const cwdValue of [undefined, 7, 'relative/dir', `${cwd}\0x`, '/' + 'a/'.repeat(2049)])
      await expect(validateRequest({ ...agent, cwd: cwdValue })).rejects.toThrow('Folder must be an existing absolute directory');
    for (const patch of [{ engine: undefined }, { auth: { kind: 'account', extra: 1 } }, { auth: null }, { permission: undefined }, { firstMessage: 'é'.repeat(8193) }])
      await expect(validateRequest({ ...agent, ...patch })).rejects.toThrow('Invalid account agent request');
    // The 16 KiB first-message limit counts bytes, not characters.
    expect(await validateRequest({ ...agent, firstMessage: 'é'.repeat(8192) })).toMatchObject({ engine: 'codex' });
  });
  it('settings.set refuses a missing or invalid patch', async () => {
    for (const patch of [undefined, null, [], 'theme', {}])
      await expect(validateRequest({ id, kind: 'settings.set', patch })).rejects.toThrow(/settings patch/);
  });
});

describe('validCwd', () => {
  it('refuses files, missing paths and oversized paths, and surfaces other filesystem errors', async () => {
    const root = await temp();
    expect(await validCwd(root)).toBe(true);
    expect(await validCwd(join(root, 'missing'))).toBe(false);
    expect(await validCwd('/' + 'a'.repeat(4096))).toBe(false);
    // A name longer than the filesystem allows is not "missing": the error reaches the caller.
    await expect(validCwd(join(root, 'n'.repeat(300)))).rejects.toMatchObject({ code: 'ENAMETOOLONG' });
  });
});

describe('validateSuccess rejections', () => {
  it.each([null, 'ok', [], [{ id, ok: true }]])('refuses a non-object response %j', value => {
    expect(() => validateSuccess(value)).toThrow('Invalid daemon response');
  });
  it.each([{ ok: true }, { id: 'x', ok: true }, { id, ok: false }, { id, ok: 'true' }, { id }])('refuses a response without a UUID id and ok: true %j', value => {
    expect(() => validateSuccess(value)).toThrow('Invalid daemon response');
  });
  it('refuses a hello from a pid that could not be a daemon, or a bad version string', () => {
    const hello = { id, ok: true, kind: 'hello', protocol: 1, version: '0.1.1', daemonPid: 4242 };
    expect(validateSuccess(hello)).toMatchObject({ daemonPid: 4242 });
    for (const patch of [{ daemonPid: 1 }, { daemonPid: 0 }, { daemonPid: -5 }, { daemonPid: 1.5 }, { version: 'a b' }, { version: 3 }, { kind: 'sessions' }])
      expect(() => validateSuccess({ ...hello, ...patch })).toThrow('Invalid daemon hello');
  });
  it('refuses snapshots without a valid size', () => {
    expect(validateSuccess({ id, ok: true, snapshot: '', cols: 2, rows: 1 })).toMatchObject({ cols: 2 });
    for (const patch of [{ snapshot: 3, cols: 80, rows: 24 }, { snapshot: 'x' }, { snapshot: 'x', cols: 1001, rows: 24 }])
      expect(() => validateSuccess({ id, ok: true, ...patch })).toThrow('Invalid daemon snapshot');
  });
  it('refuses settings without a theme', () => {
    expect(() => validateSuccess({ id, ok: true, settings: { defaultEngine: 'codex' } })).toThrow('Invalid settings theme');
  });
  it('refuses an engines block that is missing an engine or carries a bad one', () => {
    for (const engines of [null, 'x', { claudeCode: engine }, { codex: engine }])
      expect(() => validateSuccess({ id, ok: true, engines })).toThrow('Invalid engines status');
    expect(() => validateSuccess({ id, ok: true, engines: { claudeCode: engine, codex: null } })).toThrow('Invalid engine status');
  });
  it('refuses bad terminal modes, one bad session, or a sessions value that is not a list', () => {
    expect(() => validateSuccess({ id, ok: true, modes: { ...modes, mouseTracking: 'all' } })).toThrow('Invalid terminal modes');
    expect(validateSuccess({ id, ok: true, session, sessions: [session] })).toMatchObject({ session: { id: sessionId } });
    expect(() => validateSuccess({ id, ok: true, session: { ...session, cwd: 'relative' } })).toThrow('Invalid daemon session');
    expect(() => validateSuccess({ id, ok: true, sessions: [session, { ...session, status: 'gone' }] })).toThrow('Invalid daemon sessions');
    expect(() => validateSuccess({ id, ok: true, sessions: session })).toThrow('Invalid daemon sessions');
  });
});

describe('field validators', () => {
  it('validateModes needs every boolean and a known mouse mode and encoding', () => {
    expect(validateModes(modes)).toEqual(modes);
    for (const value of [null, [], 'modes'])
      expect(() => validateModes(value)).toThrow('Invalid terminal modes');
    for (const key of ['applicationCursorKeys', 'applicationKeypad', 'bracketedPaste', 'focusEvents', 'cursorVisible'])
      expect(() => validateModes({ ...modes, [key]: 'true' }), key).toThrow('Invalid terminal modes');
    for (const patch of [{ mouseTracking: 'button' }, { mouseEncoding: 'x10' }, { mouseTracking: undefined }])
      expect(() => validateModes({ ...modes, ...patch })).toThrow('Invalid terminal modes');
  });
  it('validateExitCode maps null to undefined and refuses anything but a safe integer', () => {
    expect(validateExitCode(null)).toBeUndefined();
    expect(validateExitCode(0)).toBe(0);
    expect(validateExitCode(-1)).toBe(-1);
    for (const value of [undefined, '0', 1.5, Number.NaN, 2 ** 53])
      expect(() => validateExitCode(value)).toThrow('Invalid session exit code');
  });
  it('validateSettingsPatch refuses empty, prototype keys, bad values and oversized patches', () => {
    for (const value of [null, [], 'x'])
      expect(() => validateSettingsPatch(value)).toThrow('Expected settings patch');
    expect(() => validateSettingsPatch({ future: 1 }, true)).toThrow('Unknown settings patch field');
    // Stored settings may carry future keys; only a client patch is held to the known ones.
    expect(validateSettingsPatch({ future: 1 })).toEqual({ future: 1 });
    for (const value of [{}, JSON.parse('{"__proto__":{"theme":"ink"}}') as unknown, { constructor: 1 }, { prototype: 1 }, { theme: 'neon' }, { defaultEngine: 'shell' }, { defaultModel: '-x' },
      { permission: 'dontAsk' }, { defaultCwd: 7 }, { defaultCwd: 'relative' }, { defaultCwd: '/tmp/\0' }, { theme: 'ink', note: 'x'.repeat(16384) }])
      expect(() => validateSettingsPatch(value), JSON.stringify(value).slice(0, 40)).toThrow('Invalid settings patch');
  });
  it('validateSettings needs a theme even when every other field is valid', () => {
    expect(validateSettings({ theme: 'auto', defaultModel: null })).toEqual({ theme: 'auto', defaultModel: null });
    expect(() => validateSettings({ defaultModel: null })).toThrow('Invalid settings theme');
  });
  it('validateEngineStatus refuses non-objects, extra keys and relative paths', () => {
    expect(validateEngineStatus(engine)).toEqual(engine);
    for (const value of [null, [], 'claude'])
      expect(() => validateEngineStatus(value)).toThrow('Invalid engine status');
    for (const patch of [{ email: 'x' }, { installed: 'yes' }, { path: 'claude' }, { version: '2.1 beta' }, { loggedIn: 'no' }, { authMethod: 'oauth' }])
      expect(() => validateEngineStatus({ ...engine, ...patch }), JSON.stringify(patch)).toThrow('Invalid engine status');
  });
  it('validateSession refuses non-objects and each bad field', () => {
    for (const value of [null, [], 'session'])
      expect(() => validateSession(value)).toThrow('Invalid daemon session');
    for (const patch of [{ id: 'x' }, { title: '' }, { engine: 'bash' }, { model: '-x' }, { cwd: 'tmp' }, { cwd: '/tmp\0' }, { auth: { kind: 'key' } }, { permission: 'yolo' }, { status: 'gone' },
      { statusDetail: 3 }, { statusDetail: 'x'.repeat(4097) }, { statusSince: 'yesterday' }, { createdAt: 3 }, { lastOutputAt: 'never' }, { ctxPercent: 105 }, { exitCode: 1.5 }, { authMethod: 'oauth' }])
      expect(() => validateSession({ ...session, ...patch }), JSON.stringify(patch).slice(0, 40)).toThrow('Invalid daemon session');
  });
  it('validateSystemStats refuses a session entry that is not an object', () => {
    const stats = { cpuPercent: 1, memUsedBytes: 1, memTotalBytes: 2, netRxBytesPerSec: 0, netTxBytesPerSec: 0 };
    for (const entry of [null, 'x', [sessionId, 1, 1]])
      expect(() => validateSystemStats({ ...stats, sessions: [entry] })).toThrow('Invalid session stats');
    expect(() => validateSystemStats({ ...stats, sessions: [{ sessionId, cpuPercent: 1 }] })).toThrow('Invalid session stats');
  });
});

it('ValidationError carries the INVALID_REQUEST code', () => {
  expect(new ValidationError('x').code).toBe('INVALID_REQUEST');
});

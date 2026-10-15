import { expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { doctorLines, extraLines } from '../src/cli/doctor.js';
import { KeyStore } from '../src/daemon/keys.js';
import { validateRequest } from '../src/shared/validate.js';
import { randomUUID } from 'node:crypto';

// v1.0.1: ai doctor also reports the sandbox, the keychain (asked of the daemon, which alone touches it), gh (installed,
// logged in: `gh auth status`'s exit code only, never its output or token) and the notifier.
const base = { platform: 'darwin' as NodeJS.Platform, sandbox: async () => ({ dontAsk: true }), keychain: async () => ({ reachable: true }), gh: async () => '/opt/homebrew/bin/gh', ghStatus: async () => ({ code: 0, output: 'Logged in to github.com account PRIVATE (keyring)\n  - Token: gho_PRIVATE' }), notifier: () => 'built', notifySend: async () => null };

it('macOS, everything there', async () => {
  expect(await extraLines('/x/dist/cli/index.js', base)).toEqual([
    'Sandbox: sandbox-exec · agent bash, tests and dev servers run in it',
    'Keychain: reachable',
    'gh: /opt/homebrew/bin/gh; logged in',
    'Notifier: built',
  ]);
});

it('nothing there: each line says why and what to do, and nothing gh printed reaches the report', async () => {
  const lines = await extraLines('/x/dist/cli/index.js', { ...base, sandbox: async () => ({ dontAsk: false, note: "don't ask needs macOS's sandbox-exec, which is missing" }), keychain: async () => null, ghStatus: async () => ({ code: 1, output: 'not logged in PRIVATE' }), notifier: () => 'not built' });
  expect(lines).toEqual([
    "Sandbox: none · don't ask needs macOS's sandbox-exec, which is missing",
    "Keychain: not checked · the daemon isn't running; start ai, then run ai doctor again",
    'gh: /opt/homebrew/bin/gh; not logged in · gh auth login',
    'Notifier: not built · npm run build:notifier',
  ]);
  expect(lines.join('\n')).not.toContain('PRIVATE');
  const noGh = await extraLines('/x', { ...base, gh: async () => null, keychain: async () => ({ reachable: false, note: 'Keychain unavailable' }) });
  expect(noGh).toContain('gh: not found · /pr needs it');
  expect(noGh).toContain('Keychain: unavailable · Keychain unavailable');
});

it('Linux and Windows', async () => {
  expect(await extraLines('/x', { ...base, platform: 'linux', notifySend: async () => '/usr/bin/notify-send' })).toEqual(['Sandbox: bwrap · agent bash and tests run in it', 'Keychain: reachable', 'gh: /opt/homebrew/bin/gh; logged in', 'Notifier: notify-send']);
  expect((await extraLines('/x', { ...base, platform: 'linux' })).at(-1)).toBe("Notifier: none · notify-send isn't installed");
  expect((await extraLines('/x', { ...base, platform: 'win32', sandbox: async () => ({ dontAsk: false, note: "don't ask needs a sandbox, and Windows has none AI Term can use" }) }))[0]).toBe("Sandbox: none · don't ask needs a sandbox, and Windows has none AI Term can use");
  expect((await extraLines('/x', { ...base, platform: 'win32' })).at(-1)).toBe("Notifier: none · notifications aren't available on Windows yet");
});

it('gh is asked with `auth status` only', async () => {
  const ghStatus = vi.fn(async () => ({ code: 0, output: '' }));
  await extraLines('/x', { ...base, ghStatus });
  expect(ghStatus).toHaveBeenCalledWith('/opt/homebrew/bin/gh', ['auth', 'status']);
});

it('the daemon answers keys.health by looking up a probe entry that never holds a key', async () => {
  const read = vi.fn(async () => null);
  const store = new KeyStore(await mkdtemp(join(tmpdir(), 'ai-keys-health-')), { vault: { read, write: async () => {}, remove: async () => {} } });
  expect(await store.health()).toEqual({ reachable: true });
  expect(read).toHaveBeenCalledWith('doctor-probe');
  const broken = new KeyStore(await mkdtemp(join(tmpdir(), 'ai-keys-health-')), { vault: { read: async () => { throw new Error('no keyring'); }, write: async () => {}, remove: async () => {} } });
  expect((await broken.health()).reachable).toBe(false);
  await expect(validateRequest({ id: randomUUID(), kind: 'keys.health' })).resolves.toMatchObject({ kind: 'keys.health' });
});

it('the full report runs without a daemon and adds the four lines', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ai-doctor-')); vi.stubEnv('AI_TERM_HOME', root);
  try {
    const lines = await doctorLines(resolve('src/cli/index.ts'), () => {}, { ...base, keychain: async () => null });
    expect(lines.some(line => line.startsWith('Sandbox: '))).toBe(true);
    expect(lines).toContain("Keychain: not checked · the daemon isn't running; start ai, then run ai doctor again");
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

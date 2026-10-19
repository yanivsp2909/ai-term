import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import headless from '@xterm/headless';
import { setupStatus } from '../src/daemon/setup.js';
import { markFreshSetup } from '../src/daemon/settings.js';
import { validateSetupStatus, type SetupStatus } from '../src/shared/setup.js';
import { validateSettingsPatch } from '../src/shared/validate.js';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SuccessResponse } from '../src/shared/protocol.js';

// v1.2 Part C: the first time ai starts on an empty AI Term folder (and on `ai setup`), the homepage shows what's
// installed, what's ready and the next steps. Tools are found on PATH and run only with --version or their own status
// command, argv only, with a short timeout; their config and credential files are never read.
const cleanup: string[] = [];
afterEach(async () => { for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true }); });
async function folder() { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-setup-'))); cleanup.push(dir); return dir; }

// Each stub writes the arguments it got to argv.log, then does what its case needs.
async function stubs(cases: Record<string, string>) {
  const bin = await folder(), log = join(bin, 'argv.log');
  for (const [name, body] of Object.entries(cases)) {
    await writeFile(join(bin, name), `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "${log}"\n${body}\n`);
    await chmod(join(bin, name), 0o755);
  }
  return { bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean) };
}
const ESC = '\\033';

describe('what setup finds', () => {
  it('installed, missing, logged in, logged out, hanging and escape codes, in plain words', async () => {
    const s = await stubs({
      claude: `case "$1" in --version) printf '${ESC}[31m2.1.300 (Claude Code)${ESC}[0m\\n';; auth) printf '{"loggedIn":true,"authMethod":"claude.ai"}';; esac`,
      codex: `case "$1" in --version) echo 'codex-cli 0.160.1';; login) echo 'Not logged in'; exit 1;; esac`,
      'cursor-agent': `printf '${ESC}]0;title${ESC}\\\\2026.10.01-abc\\n'`,
      copilot: 'exec /bin/sleep 30',
      gh: `case "$1" in --version) echo 'gh version 2.81.0 (2026-10-01)';; auth) exit 1;; esac`,
      ollama: "echo 'ollama version is 0.12.3'",
    });
    const started = Date.now();
    const status = await setupStatus({ env: { PATH: s.bin, HOME: await folder() }, timeoutMs: 400, keys: [{ label: 'work', provider: 'anthropic', last4: 'WXYZ' }], sandbox: { dontAsk: false, note: 'no bwrap here' }, platform: 'linux', tailscaleCandidates: [] });
    expect(Date.now() - started).toBeLessThan(6000);
    const tool = (id: string) => status.tools.find(t => t.id === id);
    expect(tool('claude-code')).toMatchObject({ found: 'found', version: '2.1.300', login: 'logged in' });
    expect(tool('codex')).toMatchObject({ found: 'found', version: '0.160.1', login: 'not logged in' });
    expect(tool('gemini')).toMatchObject({ found: 'not found', version: null, install: 'npm install -g @google/gemini-cli' });
    expect(tool('copilot')).toMatchObject({ found: "couldn't check", version: null });
    expect(tool('cursor')).toMatchObject({ found: 'found', login: 'signs in on its own screen' });
    expect(tool('gh')).toMatchObject({ found: 'found', version: '2.81.0', login: 'not logged in' });
    expect(tool('tailscale')).toMatchObject({ found: 'not found', login: null });
    expect(tool('ollama')).toMatchObject({ found: 'found', version: '0.12.3', login: null });
    expect(tool('lmstudio')).toMatchObject({ found: 'not found' });
    expect(status.keys).toEqual([{ label: 'work', provider: 'anthropic', last4: 'WXYZ' }]);
    expect(status).toMatchObject({ sandbox: 'none', sandboxNote: 'no bwrap here' });
    // Only versions and the CLIs' own status commands ran; nothing else, and nothing that writes.
    for (const call of await s.calls()) expect(call, call).toMatch(/^(claude (--version|auth status --json)|codex (--version|login status)|cursor-agent --version|copilot --version|gh (--version|auth status)|ollama --version)$/);
    // Nothing printed by a tool reaches the status as raw text.
    expect(JSON.stringify(status)).not.toContain('\\u001b'); expect(JSON.stringify(status)).not.toContain(String.fromCharCode(27));
    expect(validateSetupStatus(JSON.parse(JSON.stringify(status)))).toEqual(status);
  }, 20_000);

  it('the sandbox line names what AI Term found; the setting takes done or skipped only', async () => {
    const empty = await folder();
    const mac = await setupStatus({ env: { PATH: empty }, timeoutMs: 200, keys: [], sandbox: { dontAsk: true }, platform: 'darwin', tailscaleCandidates: [] });
    expect(mac).toMatchObject({ sandbox: 'sandbox-exec', sandboxNote: null, keys: [] });
    const linux = await setupStatus({ env: { PATH: empty }, timeoutMs: 200, keys: [], sandbox: { dontAsk: true }, platform: 'linux', tailscaleCandidates: [] });
    expect(linux.sandbox).toBe('bwrap');
    expect(validateSettingsPatch({ setup: 'done' }, true)).toEqual({ setup: 'done' });
    expect(validateSettingsPatch({ setup: 'skipped' }, true)).toEqual({ setup: 'skipped' });
    expect(() => validateSettingsPatch({ setup: 'later' }, true)).toThrow();
    expect(() => validateSetupStatus({ ...mac, tools: [{ id: 'claude-code', name: 'Claude Code', found: 'maybe', version: null, login: null, install: 'x' }] })).toThrow();
  });
});

class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
async function screen(tty: TTY) { const term = new headless.Terminal({ cols: 130, rows: 45, allowProposedApi: true }); try { await new Promise<void>(r => term.write(tty.output, r)); return Array.from({ length: 45 }, (_, y) => term.buffer.active.getLine(y)?.translateToString(true) ?? '').join('\n'); } finally { term.dispose(); } }
const STATUS: SetupStatus = {
  tools: [
    { id: 'claude-code', name: 'Claude Code', found: 'found', version: '2.1.300', login: 'logged in', install: 'npm install -g @anthropic-ai/claude-code' },
    { id: 'codex', name: 'Codex', found: 'not found', version: null, login: null, install: 'npm install -g @openai/codex' },
    { id: 'copilot', name: 'Copilot CLI', found: "couldn't check", version: null, login: null, install: 'npm install -g @github/copilot' },
    { id: 'gh', name: 'GitHub CLI (gh)', found: 'found', version: '2.81.0', login: 'not logged in', install: 'brew install gh' },
  ],
  keys: [], sandbox: 'none', sandboxNote: 'no bwrap here',
};
async function homepage(settings: Record<string, unknown>, options: { setup?: boolean; sessions?: number } = {}) {
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get') response.settings = { theme: 'graphite', ...settings };
    if (body.kind === 'sessions.list') response.sessions = [];
    if (body.kind === 'keys.list') response.keys = [];
    if (body.kind === 'setup.status') response.setup = STATUS;
    if (body.kind === 'engines.status') response.engines = { claudeCode: { installed: true, path: '/bin/claude', version: '2.1.300', loggedIn: true, authMethod: 'subscription' }, codex: { installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' } };
    return response;
  } });
  const tty = new TTY(), home = new Homepage(client as never, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown', ...options.setup ? { setup: true } : {} });
  await home.start();
  return { tty, home, requests };
}

describe('the setup screen', () => {
  it('on a fresh home it shows what is installed, what is ready and the next steps; Esc skips for good', async () => {
    const h = await homepage({ setup: 'pending' });
    try {
      await vi.waitFor(async () => expect(await screen(h.tty)).toContain("What's installed"), { timeout: 5000 });
      const text = await screen(h.tty);
      for (const line of ["What's installed", '✓ Claude Code 2.1.300 · logged in', '✗ Codex · not found · install: npm install -g @openai/codex', "? Copilot CLI · couldn't check", '✓ GitHub CLI (gh) 2.81.0 · not logged in',
        "What's ready", 'API keys: none yet', 'Sandbox: none · no bwrap here', 'Next steps', 'l  log in to a CLI', 'k  add an API key', 'b  set a budget', 'd  pick a default engine', '/remote on', 'Esc skips']) expect(text, line).toContain(line);
      h.tty.emit('data', Buffer.from('\x1b'));
      await vi.waitFor(() => expect(h.requests.some(r => r.kind === 'settings.set' && JSON.stringify(r).includes('"setup":"skipped"'))).toBe(true), { timeout: 5000 });
      expect(await screen(h.tty)).not.toContain("What's installed");
    } finally { await h.home.stop(); }
  });

  it('never by itself once finished or skipped; ai setup shows it again; ⏎ finishes; a next step opens its screen', async () => {
    const done = await homepage({ setup: 'done' });
    try { expect(done.requests.some(r => r.kind === 'setup.status')).toBe(false); } finally { await done.home.stop(); }
    const again = await homepage({ setup: 'skipped' }, { setup: true });
    try {
      await vi.waitFor(async () => expect(await screen(again.tty)).toContain("What's installed"), { timeout: 5000 });
      again.tty.emit('data', Buffer.from('\r'));
      await vi.waitFor(() => expect(again.requests.some(r => r.kind === 'settings.set' && JSON.stringify(r).includes('"setup":"done"'))).toBe(true), { timeout: 5000 });
    } finally { await again.home.stop(); }
    const step = await homepage({ setup: 'pending' });
    try {
      step.tty.emit('data', Buffer.from('b'));
      await vi.waitFor(async () => expect(await screen(step.tty)).toMatch(/daily/i), { timeout: 5000 });
      const text = await screen(step.tty);
      expect(text).not.toContain("What's installed"); expect(text).toMatch(/daily/i);
      expect(step.requests.some(r => r.kind === 'settings.set' && JSON.stringify(r).includes('"setup":"done"'))).toBe(true);
    } finally { await step.home.stop(); }
  });

  it('a failing setup check never blocks the homepage: it says so in plain words', async () => {
    const requests: RequestBody[] = [];
    const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
      requests.push(body); if (body.kind === 'setup.status') throw new Error('daemon too old');
      const response: SuccessResponse = { id: randomUUID(), ok: true };
      if (body.kind === 'settings.get') response.settings = { theme: 'graphite', setup: 'pending' }; if (body.kind === 'sessions.list') response.sessions = []; if (body.kind === 'keys.list') response.keys = [];
      return response;
    } });
    const tty = new TTY(), home = new Homepage(client as never, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' });
    await home.start();
    try { await vi.waitFor(async () => expect(await screen(tty)).toContain("Setup couldn't check this machine"), { timeout: 5000 }); } finally { await home.stop(); }
  });

  it('the daemon marks only a new AI Term folder pending; one already in use never shows the setup by itself', async () => {
    const fresh = await folder();
    expect(await markFreshSetup(fresh, join(fresh, 'state.json'))).toBe(true);
    expect(JSON.parse(await readFile(join(fresh, 'settings.json'), 'utf8'))).toMatchObject({ setup: 'pending' });
    expect(await markFreshSetup(fresh, join(fresh, 'state.json'))).toBe(false);
    const used = await folder(); await writeFile(join(used, 'state.json'), '{"v":1,"sessions":[]}');
    expect(await markFreshSetup(used, join(used, 'state.json'))).toBe(false);
    const plain = await homepage({});
    try { expect(plain.requests.some(r => r.kind === 'setup.status')).toBe(false); } finally { await plain.home.stop(); }
  });

  it('ai setup is a command the README lists', async () => {
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain('`ai setup`');
    await mkdir(await folder(), { recursive: true });
  });
});

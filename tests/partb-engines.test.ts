import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { EXTRA_ENGINES, EXTRA_ENGINE_FACTS, isExtraEngine } from '../src/shared/cli-engines.js';
import { buildExtraArgs, buildExtraEnv, CURSOR_AUTH_VARS, GEMINI_AUTH_VARS, COPILOT_AUTH_VARS } from '../src/daemon/env.js';
import { checkExtraEngine, geminiSandboxRunner } from '../src/daemon/engines.js';
import { KeyStore } from '../src/daemon/keys.js';
import { commandRegistry, type CommandContext } from '../src/client/tui/commands.js';
import { badge } from '../src/client/tui/layout.js';
import { isAgentEngine, isEffortForEngine, isPermissionForEngine, validateRequest } from '../src/shared/validate.js';
import { engineLabel, engineTitle, modelChoices } from '../src/shared/models.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { parseAccountCommand } from '../src/client/tui/accounts.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// Part B (2026-10-19): Cursor CLI, Gemini CLI and GitHub Copilot CLI, each run untouched in a PTY like Claude Code and
// Codex: argv only, its own login inside AI Term, its credential and routing variables removed, Ask by default.
const run = promisify(execFile);

describe('what each CLI is', () => {
  it('three engines, each with an install hint and the modes its docs allow', () => {
    expect(EXTRA_ENGINES).toEqual(['cursor', 'gemini', 'copilot']);
    for (const engine of EXTRA_ENGINES) { expect(isExtraEngine(engine)).toBe(true); expect(isAgentEngine(engine)).toBe(true); expect(EXTRA_ENGINE_FACTS[engine].install).toMatch(/^(npm install -g |curl )/); }
    expect(isExtraEngine('codex')).toBe(false);
    expect(engineLabel('cursor')).toBe('cursor'); expect(engineLabel('gemini')).toBe('gemini cli'); expect(engineLabel('copilot')).toBe('copilot cli');
    expect(engineTitle('cursor')).toBe('Cursor'); expect(engineTitle('gemini')).toBe('Gemini CLI'); expect(engineTitle('copilot')).toBe('Copilot CLI');
    // Ask always; Don't ask only where the CLI keeps a sandbox its docs describe (Gemini CLI: yolo turns its sandbox on).
    for (const engine of EXTRA_ENGINES) { expect(isPermissionForEngine(engine, 'ask')).toBe(true); expect(isPermissionForEngine(engine, 'auto')).toBe(false); expect(isEffortForEngine(engine, 'high')).toBe(false); expect(isEffortForEngine(engine, null)).toBe(true); }
    expect(isPermissionForEngine('gemini', 'dontAsk')).toBe(true); expect(isPermissionForEngine('cursor', 'dontAsk')).toBe(false); expect(isPermissionForEngine('copilot', 'dontAsk')).toBe(false);
    expect(EXTRA_ENGINE_FACTS.cursor.dontAskNote).toMatch(/don't ask: off/); expect(EXTRA_ENGINE_FACTS.copilot.dontAskNote).toMatch(/don't ask: off/); expect(EXTRA_ENGINE_FACTS.gemini.dontAskNote).toBeNull();
  });

  it('each CLI shows in /model with its default model, on your own login', () => {
    const choices = modelChoices([]);
    for (const engine of EXTRA_ENGINES) expect(choices.find(c => c.engine === engine && c.model === null)).toMatchObject({ label: 'CLI default', auth: { kind: 'account' } });
    expect(choices.filter(c => c.engine === 'gemini').map(c => c.model)).toEqual([null, 'pro', 'flash', 'flash-lite']);
  });
});

describe('env and argv', () => {
  const base = { PATH: '/usr/bin:/bin', HOME: '/home/u', LANG: 'en_US.UTF-8', OPENAI_API_KEY: 'not-theirs' };
  it('an account session drops that CLI\'s credential and routing variables, and nothing else of yours', () => {
    for (const [engine, vars] of [['cursor', CURSOR_AUTH_VARS], ['gemini', GEMINI_AUTH_VARS], ['copilot', COPILOT_AUTH_VARS]] as const) {
      const planted = Object.fromEntries(vars.map(name => [name.replace('*', 'X'), 'AITERMCANARY-partB']));
      const env = buildExtraEnv(engine, { ...base, ...planted });
      expect(JSON.stringify(env)).not.toContain('AITERMCANARY-partB');
      expect(env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: '/home/u', TERM: 'xterm-256color', TERM_PROGRAM: 'AITerm' });
    }
    // The lists hold what each CLI's docs name: an env key would silently bill instead of your login.
    for (const name of ['CURSOR_API_KEY']) expect(CURSOR_AUTH_VARS).toContain(name);
    for (const name of ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLE_CLOUD_PROJECT', 'GOOGLE_GENAI_USE_VERTEXAI', 'GOOGLE_GEMINI_BASE_URL', 'CODE_ASSIST_ENDPOINT', 'GEMINI_CLI_HOME']) expect(GEMINI_AUTH_VARS).toContain(name);
    for (const name of ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_HOST', 'COPILOT_PROVIDER_*', 'COPILOT_HOME', 'COPILOT_ALLOW_ALL']) expect(COPILOT_AUTH_VARS).toContain(name);
    // Windows spells a name any way it likes; it is removed whatever its case.
    expect(buildExtraEnv('copilot', { ...base, gh_token: 'AITERMCANARY-partB' }, { platform: 'win32' })).not.toHaveProperty('gh_token');
  });

  it('an account profile is the CLI\'s documented config folder variable; Cursor has none, so it never gets one', () => {
    expect(buildExtraEnv('gemini', base, { profileDir: '/home/u/.ai-term/profiles/work' }).GEMINI_CLI_HOME).toBe('/home/u/.ai-term/profiles/work');
    expect(buildExtraEnv('copilot', base, { profileDir: '/home/u/.ai-term/profiles/work' }).COPILOT_HOME).toBe('/home/u/.ai-term/profiles/work');
    expect(() => buildExtraEnv('cursor', base, { profileDir: '/home/u/.ai-term/profiles/work' })).toThrow('Cursor has one account');
    expect(EXTRA_ENGINE_FACTS.cursor.accounts).toBe(false); expect(EXTRA_ENGINE_FACTS.gemini.accounts).toBe(true); expect(EXTRA_ENGINE_FACTS.copilot.accounts).toBe(true);
  });

  it('argv: the model as one element, the first message as one element, an explicit Ask where the CLI has one', () => {
    expect(buildExtraArgs({ engine: 'gemini', model: 'pro', permission: 'ask', firstMessage: 'fix the bug; rm -rf /' })).toEqual(['--approval-mode=default', '--model=pro', '--prompt-interactive=fix the bug; rm -rf /']);
    expect(buildExtraArgs({ engine: 'gemini', model: null, permission: 'dontAsk' })).toEqual(['--approval-mode=yolo', '--sandbox']);
    expect(buildExtraArgs({ engine: 'copilot', model: 'gpt-6', permission: 'ask', firstMessage: 'hi' })).toEqual(['--model=gpt-6', '--interactive=hi']);
    expect(buildExtraArgs({ engine: 'cursor', model: 'sonnet-5', permission: 'ask', firstMessage: 'hello there' })).toEqual(['--model=sonnet-5', 'hello there']);
    expect(buildExtraArgs({ engine: 'cursor', model: null, permission: 'ask' })).toEqual([]);
    // A positional prompt starting with - would read as a flag: refused, never passed.
    expect(() => buildExtraArgs({ engine: 'cursor', model: null, permission: 'ask', firstMessage: '--force' })).toThrow('A first message for Cursor can\'t start with -');
    for (const [engine, permission] of [['cursor', 'dontAsk'], ['copilot', 'dontAsk'], ['gemini', 'auto']] as const) expect(() => buildExtraArgs({ engine, model: null, permission })).toThrow();
    for (const model of ['bad model', '--force', 'x'.repeat(300)]) expect(() => buildExtraArgs({ engine: 'gemini', model, permission: 'ask' })).toThrow();
  });

  it('the agents\' skip flags live in env.ts only (git.ts\'s worktree remove --force is not one)', async () => {
    const { stdout } = await run('/usr/bin/grep', ['-rlE', '--', "approval-mode=yolo|allow-all-tools|'--yolo'|bypassPermissions|ask-for-approval=never|--dangerously", 'src']).catch(() => ({ stdout: '' }));
    expect(stdout.trim().split('\n').filter(Boolean)).toEqual(['src/daemon/env.ts']);
  });
});

describe('finding the CLI', () => {
  const dirs: string[] = [];
  afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
  async function bin(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'ai-partb-bin-')); dirs.push(dir);
    for (const [name, body] of Object.entries(files)) { await writeFile(join(dir, name), `#!/bin/sh\n${body}\n`); await chmod(join(dir, name), 0o755); }
    return dir;
  }
  it('version from --version; login status is the CLI\'s own business (never read from its files)', async () => {
    const dir = await bin({ gemini: 'echo "0.42.1"', copilot: 'echo "GitHub Copilot CLI 1.0.3"' });
    expect(await checkExtraEngine('gemini', { PATH: dir })).toMatchObject({ installed: true, path: join(dir, 'gemini'), version: '0.42.1', loggedIn: null, authMethod: 'unknown' });
    expect(await checkExtraEngine('copilot', { PATH: dir })).toMatchObject({ installed: true, version: '1.0.3' });
    expect(await checkExtraEngine('cursor', { PATH: dir })).toMatchObject({ installed: false, path: null });
  });

  it('Cursor: cursor-agent, or an `agent` only when it says it is Cursor\'s', async () => {
    const other = await bin({ agent: 'echo "some other agent 3.0.0"' });
    expect(await checkExtraEngine('cursor', { PATH: other })).toMatchObject({ installed: false });
    const cursor = await bin({ agent: 'case "$1" in --version) echo "2026.10.01-abc";; *) echo "Cursor Agent";; esac' });
    expect(await checkExtraEngine('cursor', { PATH: cursor })).toMatchObject({ installed: true, path: join(cursor, 'agent') });
    const named = await bin({ 'cursor-agent': 'echo "2026.10.01"' });
    expect(await checkExtraEngine('cursor', { PATH: `${other}:${named}` })).toMatchObject({ installed: true, path: join(named, 'cursor-agent') });
  });
});

describe('in the daemon', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
  async function setup(settings: Record<string, unknown> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-partb-'))), paths = getPaths(join(root, 'home')); await preparePaths(paths);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(paths.root, 'settings.json'), JSON.stringify({ theme: 'slate', ...settings }), { mode: 0o600 });
    const bin = join(root, 'bin'); await mkdir(bin);
    // docker: Gemini CLI's Don't ask needs a sandbox runner off macOS (Part B review); a stub keeps the test the same anywhere.
    for (const name of ['gemini', 'copilot', 'cursor-agent', 'docker']) { await writeFile(join(bin, name), '#!/bin/sh\necho "1.2.3"\n'); await chmod(join(bin, name), 0o755); }
    const repo = join(root, 'repo'); await mkdir(repo);
    await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await writeFile(join(repo, 'a.txt'), 'a\n');
    await run('/usr/bin/git', ['add', '--', '.'], { cwd: repo }); await run('/usr/bin/git', ['commit', '-qm', 'initial', '--'], { cwd: repo });
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ''}`; cleanups.push(async () => { process.env.PATH = oldPath; });
    for (const name of ['GEMINI_API_KEY', 'GH_TOKEN', 'CURSOR_API_KEY']) { process.env[name] = 'AITERMCANARY-partB-env'; cleanups.push(async () => { delete process.env[name]; }); }
    const vault = new Map<string, string>();
    const keys = new KeyStore(paths.root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
    const manager = new SessionManager(paths, new Logger(paths.log), undefined, undefined, undefined, keys, undefined, '/opt/ai-term/dist/cli/index.js'); await manager.load();
    cleanups.push(() => manager.shutdown());
    const spawned: { file: string; args: string[]; env: Record<string, string> }[] = [], real = pty.spawn;
    vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => { spawned.push({ file, args: Array.isArray(args) ? [...args] : [], env: { ...(options?.env as Record<string, string>) } }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
    return { root, paths, manager, repo, bin, spawned, keys };
  }

  it('starts each CLI in its own worktree, Ask by default, with its credential variables gone and status from output', async () => {
    const d = await setup();
    for (const engine of ['gemini', 'copilot', 'cursor'] as const) {
      const session = await d.manager.create({ engine, model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', firstMessage: 'hello' });
      const started = d.spawned.at(-1); if (!started) throw new Error('no spawn');
      expect(started.file).toBe(join(d.bin, engine === 'cursor' ? 'cursor-agent' : engine));
      expect(started.args).toEqual(engine === 'gemini' ? ['--approval-mode=default', '--prompt-interactive=hello'] : engine === 'copilot' ? ['--interactive=hello'] : ['hello']);
      // Each CLI loses its own credential variables (another CLI's are not its business).
      expect(started.env[engine === 'gemini' ? 'GEMINI_API_KEY' : engine === 'copilot' ? 'GH_TOKEN' : 'CURSOR_API_KEY']).toBeUndefined();
      expect(session).toMatchObject({ engine, auth: { kind: 'account' }, branch: expect.stringMatching(/^ai\//) });
      expect(session.worktree).toContain(join('home', 'worktrees'));
      await vi.waitFor(() => expect(d.manager.get(session.id).status).toBe('running'), { timeout: 10_000 });
    }
    await expect(d.manager.create({ engine: 'cursor', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'dontAsk' })).rejects.toThrow();
    // Gemini CLI's Don't ask: its yolo mode with its sandbox, flags only from env.ts.
    await d.manager.create({ engine: 'gemini', model: 'flash', auth: { kind: 'account' }, cwd: d.repo, permission: 'dontAsk' });
    expect(d.spawned.at(-1)?.args).toEqual(['--approval-mode=yolo', '--sandbox', '--model=flash']);
  });

  it('login runs the CLI\'s own login inside AI Term; a missing CLI says how to install it', async () => {
    const d = await setup();
    await d.manager.create({ engine: 'copilot', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', login: true });
    expect(d.spawned.at(-1)?.args).toEqual(['login']);
    await d.manager.create({ engine: 'cursor', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', login: true });
    expect(d.spawned.at(-1)?.args).toEqual(['login']);
    // Gemini CLI signs in from its own first screen (/auth): its login session is the CLI itself.
    await d.manager.create({ engine: 'gemini', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask', login: true });
    expect(d.spawned.at(-1)?.args).toEqual([]);
    await rm(join(d.bin, 'copilot'));
    await expect(d.manager.create({ engine: 'copilot', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask' })).rejects.toThrow('copilot not found in PATH · npm install -g @github/copilot');
  });

  it('a Gemini or Copilot account is a profile folder of its own; Cursor refuses one', async () => {
    const d = await setup({ accounts: [{ name: 'work', engine: 'gemini' }, { name: 'gh', engine: 'copilot' }] });
    await d.manager.create({ engine: 'gemini', model: null, auth: { kind: 'account', profile: 'work' }, cwd: d.repo, permission: 'ask' });
    expect(d.spawned.at(-1)?.env.GEMINI_CLI_HOME).toBe(join(d.paths.root, 'profiles', 'work'));
    await d.manager.create({ engine: 'copilot', model: null, auth: { kind: 'account', profile: 'gh' }, cwd: d.repo, permission: 'ask' });
    expect(d.spawned.at(-1)?.env.COPILOT_HOME).toBe(join(d.paths.root, 'profiles', 'gh'));
    await expect(d.manager.create({ engine: 'cursor', model: null, auth: { kind: 'account', profile: 'work' }, cwd: d.repo, permission: 'ask' })).rejects.toThrow('Account not found for this engine');
    expect(parseAccountCommand('/account add gemini work')).toEqual({ kind: 'add', engine: 'gemini', name: 'work' });
    expect(parseAccountCommand('/account add copilot gh')).toEqual({ kind: 'add', engine: 'copilot', name: 'gh' });
    expect(parseAccountCommand('/account add cursor x').kind).toBe('error');
  });

  it('/send to one is refused, since it reports no status; /resume says /retry', async () => {
    const d = await setup();
    const session = await d.manager.create({ engine: 'gemini', model: null, auth: { kind: 'account' }, cwd: d.repo, permission: 'ask' });
    await vi.waitFor(() => expect(d.manager.get(session.id).status).toBe('running'), { timeout: 10_000 });
    await expect(d.manager.send(session.id, 'hello')).rejects.toThrow('This CLI reports no status; open it (⏎) and type there');
    await d.manager.stop(session.id);
    await vi.waitFor(() => expect(['exited', 'error']).toContain(d.manager.get(session.id).status), { timeout: 10_000 });
    await expect(d.manager.resume(session.id)).rejects.toThrow("This CLI can't be resumed from AI Term; /retry starts it fresh");
  });

  it('the request validator takes the new engines with their own modes only', async () => {
    const id = '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', base = { id, kind: 'sessions.create', model: null, auth: { kind: 'account' }, cwd: '/tmp', effort: null };
    await expect(validateRequest({ ...base, engine: 'gemini', permission: 'dontAsk' })).resolves.toMatchObject({ engine: 'gemini' });
    await expect(validateRequest({ ...base, engine: 'copilot', permission: 'dontAsk' })).rejects.toThrow();
    await expect(validateRequest({ ...base, engine: 'cursor', permission: 'ask', effort: 'high' })).rejects.toThrow();
  });
});

describe('the card', () => {
  it('says its status comes from the CLI\'s output', () => {
    const now = Date.parse('2026-10-19T10:00:00.000Z');
    const info: SessionInfo = { id: '6f1c4f53-3a1e-4bb0-9a49-3f3f3f3f3f3f', title: 'Gemini CLI', engine: 'gemini', model: null, permission: 'ask', cwd: '/tmp', status: 'running', statusDetail: 'running', statusSince: '2026-10-19T09:59:58.000Z', createdAt: '2026-10-19T09:59:50.000Z', lastActivity: null, lastOutputAt: '2026-10-19T09:59:59.000Z', exitCode: null, ctxPercent: null, auth: { kind: 'account' } };
    expect(cardText(info, now, 120).activity).toEqual({ text: 'status from output', color: 'ink-3' });
    expect(cardText(info, now + 20_000, 120).activity?.text).toBe('quiet 21s · status from output');
    expect(cardText({ ...info, engine: 'codex' }, now, 120).activity).toBeNull();
    expect(cardText(info, now, 120).model).toContain('gemini cli');
  });
});


describe('in /login and /settings', () => {
  it('each CLI has a login row that starts its own login; /settings says installed or how to install', async () => {
    const { CredentialsPanel } = await import('../src/client/tui/credentials.js');
    const { randomUUID } = await import('node:crypto');
    const logins: string[] = [];
    const engines = { claudeCode: { installed: true, path: '/bin/claude', version: '2.1.0', loggedIn: true, authMethod: 'subscription' as const }, codex: { installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' as const },
      extra: { gemini: { installed: true, path: '/bin/gemini', version: '0.42.1', loggedIn: null, authMethod: 'unknown' as const }, copilot: { installed: false, path: null, version: null, loggedIn: null, authMethod: 'unknown' as const } } };
    const request = async (body: { kind: string }) => ({ id: randomUUID(), ok: true as const, ...(body.kind === 'engines.status' ? { engines } : body.kind === 'settings.get' ? { settings: { theme: 'graphite' as const } } : body.kind === 'keys.list' ? { keys: [] } : {}) });
    const login = new CredentialsPanel('login', { request, changed() {}, close() {}, login: async engine => { logins.push(engine); }, defaults() {}, theme: async () => {} });
    while (!login.lines().includes('› Gemini CLI · CLI login')) await login.key('down');
    expect(login.lines()[1]).toBe('signs in through Gemini CLI itself; AI Term never sees its login');
    await login.key('enter'); expect(logins).toEqual(['gemini']);
    const settings = new CredentialsPanel('settings', { request, changed() {}, close() {}, login: async () => {}, defaults() {}, theme: async () => {} });
    await settings.load();
    const text = settings.lines().join('\n');
    expect(text).toContain('Gemini CLI: ✓ installed 0.42.1 · login: in the CLI · /login');
    expect(text).toContain('Copilot CLI: ✗ not installed · npm install -g @github/copilot');
    expect(text).toContain('Cursor: not checked');
  });
});

describe('what AI Term won\'t do for them', () => {
  it('the client says plainly why /send is refused for these CLIs', async () => {
    const { AGENT_COMMAND_ERRORS } = await import('../src/daemon/session-manager.js');
    const { sendFailure } = await import('../src/client/tui/send-command.js');
    expect(AGENT_COMMAND_ERRORS).toContain('This CLI reports no status; open it (⏎) and type there');
    expect(sendFailure('Gemini CLI', 'This CLI reports no status; open it (⏎) and type there')).toBe("Gemini CLI reports no status, so /send can't tell what it shows · open it (⏎) and type there");
  });
});

describe('Part B review findings', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
  async function folder() { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-partb-r-'))); cleanups.push(() => rm(dir, { recursive: true, force: true })); return dir; }

  it('security MEDIUM: Gemini CLI never inherits the variables that turn its sandbox off or swap its profile', () => {
    const env = buildExtraEnv('gemini', { PATH: '/usr/bin', HOME: '/home/u', SANDBOX: 'sandbox-exec', GEMINI_SANDBOX: 'false', SEATBELT_PROFILE: 'mine' });
    for (const name of ['SANDBOX', 'GEMINI_SANDBOX', 'SEATBELT_PROFILE']) { expect(env[name], name).toBeUndefined(); expect(GEMINI_AUTH_VARS, name).toContain(name); }
  });

  it('security MEDIUM: Gemini CLI\'s Don\'t ask needs its sandbox runner (sandbox-exec on macOS, Docker or Podman elsewhere)', async () => {
    const empty = await folder(), withPodman = await folder(), withSeatbelt = await folder();
    for (const [dir, name] of [[withPodman, 'podman'], [withSeatbelt, 'sandbox-exec']] as const) { await writeFile(join(dir, name), '#!/bin/sh\n'); await chmod(join(dir, name), 0o755); }
    expect(await geminiSandboxRunner(empty, 'linux')).toBeNull();
    expect(await geminiSandboxRunner(withPodman, 'linux')).toBe(join(withPodman, 'podman'));
    expect(await geminiSandboxRunner(withSeatbelt, 'linux')).toBeNull();
    expect(await geminiSandboxRunner(withSeatbelt, 'darwin')).toBe(join(withSeatbelt, 'sandbox-exec'));
    expect(await geminiSandboxRunner(withPodman, 'darwin')).toBeNull();
  });

  it('security LOW: a one-word first message for Cursor could run one of its commands (logout, update), so it is refused', () => {
    for (const word of ['logout', 'update', 'status', 'mcp', 'hello', 'install-shell-integration'])
      expect(() => buildExtraArgs({ engine: 'cursor', model: null, permission: 'ask', firstMessage: word }), word).toThrow("Cursor would read a one-word first message as a command · add a word, or type it inside Cursor");
    expect(buildExtraArgs({ engine: 'cursor', model: null, permission: 'ask', firstMessage: 'fix the tests' })).toEqual(['fix the tests']);
    expect(buildExtraArgs({ engine: 'cursor', model: null, permission: 'ask', firstMessage: 'README.md?' })).toEqual(['README.md?']);
    // The other two take the message as --flag=<text>, which no word can turn into a command.
    expect(buildExtraArgs({ engine: 'copilot', model: null, permission: 'ask', firstMessage: 'logout' })).toEqual(['--interactive=logout']);
  });

  it('security LOW: a named Copilot account gets its own gh folder, so a new profile never falls back to your gh login', () => {
    const env = buildExtraEnv('copilot', { PATH: '/usr/bin', HOME: '/home/u', GH_CONFIG_DIR: '/home/u/.config/gh' }, { profileDir: '/home/u/.ai-term/profiles/gh' });
    expect(env.COPILOT_HOME).toBe('/home/u/.ai-term/profiles/gh');
    expect(env.GH_CONFIG_DIR).toBe(join('/home/u/.ai-term/profiles/gh', 'gh'));
    // Your own account keeps your gh as it is.
    expect(buildExtraEnv('copilot', { PATH: '/usr/bin', HOME: '/home/u', GH_CONFIG_DIR: '/home/u/.config/gh' }).GH_CONFIG_DIR).toBe('/home/u/.config/gh');
  });

  it('code MEDIUM: /model names the engine picked, not claude code', () => {
    const model = commandRegistry.find(command => command.name === '/model'); if (!model) throw new Error('no /model');
    const context = (engine: CommandContext['engine'], m: string | null): CommandContext => ({ engine, model: m, cwd: '/tmp', theme: 'slate' });
    expect(model.current(context('gemini', 'pro'))).toBe('pro · gemini cli');
    expect(model.current(context('cursor', null))).toBe('CLI default · cursor');
    expect(model.current(context('codex', null))).toBe('CLI default · codex');
  });

  it('code LOW: each CLI has its own card badge, not AI Term\'s AT or a model family it may not be', () => {
    const session = (engine: SessionInfo['engine'], model: string | null) => ({ engine, model }) as SessionInfo;
    expect(badge(session('cursor', null))).toBe('CU'); expect(badge(session('cursor', 'gpt-5'))).toBe('CU');
    expect(badge(session('gemini', 'pro'))).toBe('GE'); expect(badge(session('copilot', null))).toBe('CP');
    expect(badge(session('ai-term', 'kimi-k2'))).toBe('KI'); expect(badge(session('ai-term', null))).toBe('AT');
  });
});

describe('Part B review findings in the daemon', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); });
  async function setup(settings: Record<string, unknown> = {}) {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-partb-d-'))), paths = getPaths(join(root, 'home')); await preparePaths(paths);
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    await writeFile(join(paths.root, 'settings.json'), JSON.stringify({ theme: 'slate', worktrees: 'off', ...settings }), { mode: 0o600 });
    const bin = join(root, 'bin'); await mkdir(bin);
    for (const name of ['gemini', 'copilot', 'cursor-agent', 'docker']) { await writeFile(join(bin, name), '#!/bin/sh\necho "1.2.3"\n'); await chmod(join(bin, name), 0o755); }
    const work = join(root, 'work'); await mkdir(work);
    const oldPath = process.env.PATH; process.env.PATH = `${bin}:${oldPath ?? ''}`; cleanups.push(async () => { process.env.PATH = oldPath; });
    const vault = new Map<string, string>(), log = new Logger(paths.log);
    const keys = new KeyStore(paths.root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
    const make = async () => { const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, undefined, '/opt/ai-term/dist/cli/index.js'); await manager.load(); return manager; };
    const manager = await make(); cleanups.push(() => manager.shutdown());
    const spawned: { file: string; args: string[] }[] = [], real = pty.spawn;
    vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => { spawned.push({ file, args: Array.isArray(args) ? [...args] : [] }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
    return { paths, manager, make, work, spawned, keys };
  }
  const finished = async (manager: SessionManager, id: string) => { await manager.stop(id); await vi.waitFor(() => expect(['exited', 'error']).toContain(manager.get(id).status), { timeout: 10_000 }); };

  it('code MEDIUM (tests): a key picked for one of these CLIs starts AI Term\'s agent, never the CLI', async () => {
    const d = await setup();
    const key = await d.keys.add({ provider: 'deepseek', label: 'ds', secret: 'AITERMCANARY-partB-key-0123456789', deployments: ['deepseek-chat'] });
    await d.keys.saveTest(key.id, [{ model: 'deepseek-chat', status: 'ready' }]);
    for (const engine of EXTRA_ENGINES) {
      const session = await d.manager.create({ engine, model: 'deepseek-chat', auth: { kind: 'key', keyId: key.id }, cwd: d.work, permission: 'ask' });
      expect(session).toMatchObject({ engine: 'ai-term', auth: { kind: 'key', provider: 'deepseek' } });
      expect(d.spawned.at(-1)?.file).toBe(process.execPath);
    }
  });

  it('code MEDIUM (tests): /retry starts the same CLI fresh, with no resume and no first message; a restart keeps the record', async () => {
    const d = await setup();
    const session = await d.manager.create({ engine: 'gemini', model: 'flash', auth: { kind: 'account' }, cwd: d.work, permission: 'ask', firstMessage: 'hello' });
    await finished(d.manager, session.id);
    const next = await d.manager.retry(session.id);
    expect(next).toMatchObject({ engine: 'gemini', model: 'flash', permission: 'ask' });
    expect(d.spawned.at(-1)?.args).toEqual(['--approval-mode=default', '--model=flash']);
    await finished(d.manager, next.id);
    const again = await d.make(); cleanups.push(() => again.shutdown());
    expect(again.get(next.id)).toMatchObject({ engine: 'gemini', model: 'flash', auth: { kind: 'account' } });
  });

  it('code LOW: an add-on never starts on one of these CLIs', async () => {
    const d = await setup();
    await expect(d.manager.create({ engine: 'gemini', model: null, auth: { kind: 'account' }, cwd: d.work, permission: 'ask' }, undefined, undefined, { bundle: 'x', readOnly: true })).rejects.toThrow('Engine unavailable for this add-on');
  });

  it('code LOW: a handoff from one of these CLIs without a key says why, instead of "still working"', async () => {
    const d = await setup({ handoff: true });
    const session = await d.manager.create({ engine: 'copilot', model: null, auth: { kind: 'account' }, cwd: d.work, permission: 'ask' });
    await vi.waitFor(() => expect(d.manager.get(session.id).status).toBe('running'), { timeout: 10_000 });
    const why = 'This CLI reports no status, so it can\'t write the note · add an API key for the summary';
    await expect(d.manager.handoffPlan(session.id, 'claude-code')).rejects.toThrow(why);
    await expect(d.manager.handoff(session.id, 'claude-code')).rejects.toThrow(why);
  });
});

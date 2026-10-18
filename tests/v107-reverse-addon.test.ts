import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { parseAddon, validateAddonAsk, type AddonTarget } from '../src/shared/addons.js';
import { parseAddonResult } from '../src/shared/addon-results.js';
import { batchLines } from '../src/client/tui/addon-views.js';
import { AddonService, type ReversePlan } from '../src/daemon/addons.js';
import { buildAgentArgs } from '../src/daemon/env.js';
import { parseAgentArgs } from '../src/agent/main.js';
import { checkReverseCli } from '../src/daemon/addon-cli.js';
import { McpService } from '../src/daemon/mcp/service.js';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { Logger } from '../src/daemon/log.js';
import { validateSettingsPatch } from '../src/shared/validate.js';
import { Homepage } from '../src/client/tui/homepage.js';
import type { RequestBody } from '../src/client/connection.js';
import type { SessionInfo, SuccessResponse } from '../src/shared/protocol.js';

// v1.0.7 /reverse on the add-on core: one popup (D49), y starts, Ask mode, read-only, and the REA server for that agent only.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async (name: string) => { const path = await realpath(await mkdtemp(join(tmpdir(), name))); roots.push(path); return path; };
const DEFINITIONS = new URL('../addons/', import.meta.url).pathname;
const CLAUDE: AddonTarget = { engine: 'claude-code', model: null, auth: { kind: 'account' } };
const MCP = { command: '/usr/bin/env', args: ['-i', 'PATH=/usr/bin:/bin', '/usr/bin/sandbox-exec', '-f', '/x/p.sb', '--', '/opt/rea/bin/rea', 'mcp'] };
const RESULT = { kind: 'reverse', summary: 'Search builds a trigram index at launch', findings: [{ title: 'Index built in a background queue', detail: 'The indexer runs at launch.', evidence: 'Symbol -[Index build] at 0x1000, called from main' }], limits: ['Encrypted resources were not read'] };

it('the /reverse definition is a read-only add-on on every engine that takes a target', async () => {
  const addon = parseAddon(await readFile(join(DEFINITIONS, 'reverse', 'addon.md'), 'utf8'), 'reverse');
  expect(addon).toMatchObject({ input: 'target', readOnly: true, worktree: false, engines: ['claude-code', 'ai-term'] });
  expect(addon.prompt).toContain('{{args}}');
});

it('a /reverse result names each finding with its evidence and the limits; anything else is refused', () => {
  const result = parseAddonResult(JSON.stringify(RESULT), 'reverse');
  const lines = batchLines(result as Parameters<typeof batchLines>[0], { selected: 0, picked: new Set(), tests: null, ab: null, applied: null, quiz: 'hidden' });
  expect(lines).toContain('Search builds a trigram index at launch');
  expect(lines.join('\n')).toContain('Evidence: Symbol -[Index build] at 0x1000, called from main');
  expect(lines.join('\n')).toContain('Encrypted resources were not read');
  expect(lines.at(-1)).toContain('read-only');
  for (const bad of [{ ...RESULT, findings: [{ title: 't', detail: 'd' }] }, { ...RESULT, limits: 'none' }, { ...RESULT, summary: 'a\u001b[2Jb' }, { ...RESULT, extra: 1 }]) expect(() => parseAddonResult(JSON.stringify(bad), 'reverse')).toThrow();
});

async function service(plan: ReversePlan | Error = { target: '/apps/Notes.app', rea: '/opt/rea/bin/rea', identity: '1:2:3:4:5', mcp: MCP }) {
  const home = await temp('ai-rev-home-'), cwd = await temp('ai-rev-cwd-'), runs: Record<string, unknown>[] = [], asked: unknown[][] = [];
  const runner = {
    async create(request: Record<string, unknown>, _c?: undefined, _f?: undefined, addon?: unknown) { runs.push({ ...request, addon }); return { id: randomUUID(), title: String(request.title), status: 'running', cwd: String(request.cwd) } as SessionInfo; },
    text: vi.fn(), brainPlan: async () => null,
    async addonReverse(...args: unknown[]) { asked.push(args); if (plan instanceof Error) throw plan; return plan; },
  };
  return { cwd, runs, asked, service: new AddonService(home, DEFINITIONS, runner) };
}

it('the popup names the target, the REA it found and its sandbox, and asks you to confirm the target is yours; y starts REA for that agent only', async () => {
  const { cwd, runs, asked, service: s } = await service();
  const ask = validateAddonAsk(await s.plan('reverse', 'Notes.app', cwd, CLAUDE));
  expect(asked).toEqual([[cwd, 'Notes.app', CLAUDE]]);
  expect(ask).toMatchObject({ subject: 'target: /apps/Notes.app', readOnly: true, worktree: false });
  const facts = (ask.facts ?? []).join('\n');
  expect(facts).toContain('REA: /opt/rea/bin/rea');
  expect(facts).toContain('no network');
  expect(facts).toContain("y confirms this target is yours, or that you're allowed to analyze it");
  const started = await s.start(ask.receipt);
  if (!('session' in started)) throw new Error('expected a session');
  expect(runs[0]).toMatchObject({ permission: 'ask', useWorktree: false, addon: { readOnly: true, mcp: MCP } });
  expect(String(runs[0]?.firstMessage)).toContain('/apps/Notes.app');
});

it('missing REA or an engine without a per-session MCP option stops at the popup with one line', async () => {
  const { cwd, service: s } = await service(new Error("REA isn't installed · install it yourself with npm install --global rea-agents, or point to it with /reverse path <path>"));
  await expect(s.plan('reverse', 'Notes.app', cwd, CLAUDE)).rejects.toThrow('npm install --global rea-agents');
  // MEDIUM (security review): Codex merges -c mcp_servers into your own config, so it would keep your other servers.
  await expect(s.plan('reverse', 'Notes.app', cwd, { engine: 'codex', model: null, auth: { kind: 'account' } })).rejects.toThrow('Engine unavailable');
});

it('the installed CLI decides: Claude Code needs --mcp-config and --strict-mcp-config; Codex is never offered', async () => {
  const bin = await temp('ai-rev-cli-');
  const cli = async (name: string, help: string) => { const path = join(bin, name); await writeFile(path, `#!/bin/sh\ncat <<'EOF'\n${help}\nEOF\n`); await chmod(path, 0o755); return path; };
  await expect(checkReverseCli('claude-code', await cli('claude-new', '  --mcp-config <configs...>  Load MCP servers\n  --strict-mcp-config  Only use MCP servers from --mcp-config'))).resolves.toBeUndefined();
  await expect(checkReverseCli('claude-code', await cli('claude-old', '  --plugin-dir <path>'))).rejects.toThrow('per-session MCP');
  await expect(checkReverseCli('codex', await cli('codex-new', '  -c, --config <key=value>\n          Override a configuration value'))).rejects.toThrow('leaves out your own MCP servers');
  await expect(checkReverseCli('codex', await cli('codex-old', '  --model <MODEL>'))).rejects.toThrow('per-session MCP');
}, 30_000);

it('AI Term\'s agent gets a session MCP list: its own catalog is only REA, approved by the popup; other agents never see it', async () => {
  const state = await temp('ai-rev-mcp-'), cwd = join(state, 'work'); await mkdir(cwd);
  const vault: KeyVault = { read: async () => null, write: async () => {}, remove: async () => {} };
  const mcp = new McpService(new SettingsStore(state), new KeyStore(state, { vault }), new Logger(join(state, 'daemon.log')), state);
  const owner = randomUUID(), other = randomUUID();
  mcp.session(owner, MCP);
  const mine = (await mcp.query(owner, { kind: 'mcp.list', cwd })).mcp;
  expect(mine?.servers.map(s => [s.config.name, s.source, s.approved, s.enabled])).toEqual([['rea', 'this session', true, true]]);
  expect((await mcp.query(other, { kind: 'mcp.list', cwd })).mcp?.servers).toEqual([]);
  await mcp.stop(owner); mcp.endSession(owner);
  expect((await mcp.query(owner, { kind: 'mcp.list', cwd })).mcp?.servers).toEqual([]);
  // The flag only exists for read-only add-on agents; their tools are then read, search and the MCP pair.
  const bundle = '/tmp/home/addons/' + 'a'.repeat(64);
  const native = buildAgentArgs({ command: { node: '/usr/bin/node', entry: '/opt/ai-term/dist/cli/index.js' }, provider: 'anthropic', model: 'm1', models: ['m1'], theme: 'graphite', transcript: '/tmp/t.jsonl', permission: 'ask', addon: { bundle, readOnly: true, mcp: MCP } });
  expect(parseAgentArgs(native.args.slice(2))).toMatchObject({ readOnly: true, sessionMcp: true });
  expect(() => parseAgentArgs(['--provider=anthropic', '--model=m1', '--models=m1', '--session-mcp'])).toThrow();
});

it('/reverse path <path> saves where REA is; only an absolute path, and none clears it', async () => {
  expect(validateSettingsPatch({ reversePath: '/opt/rea/bin/rea' }, true)).toEqual({ reversePath: '/opt/rea/bin/rea' });
  expect(validateSettingsPatch({ reversePath: null }, true)).toEqual({ reversePath: null });
  expect(() => validateSettingsPatch({ reversePath: 'rea' }, true)).toThrow();
  const requests: RequestBody[] = [];
  const client = Object.assign(new EventEmitter(), { async request(body: RequestBody): Promise<SuccessResponse> {
    requests.push(body); const response: SuccessResponse = { id: randomUUID(), ok: true };
    if (body.kind === 'settings.get' || body.kind === 'settings.set') response.settings = { theme: 'graphite' }; if (body.kind === 'sessions.list') response.sessions = []; if (body.kind === 'keys.list') response.keys = [];
    return response;
  } });
  class TTY extends EventEmitter { isTTY = true; columns = 130; rows = 45; output = ''; setRawMode() {} resume() {} pause() {} write(s: string | Buffer) { this.output += String(s); return true; } }
  const tty = new TTY(), home = new Homepage(client, { stdin: tty, stdout: tty, signals: new EventEmitter(), cwd: '/tmp', terminalProgram: 'unknown' }); await home.start();
  try {
    tty.emit('data', Buffer.from('/reverse path /opt/rea/bin/rea\r'));
    await vi.waitFor(() => expect(requests.find(r => r.kind === 'settings.set')).toEqual({ kind: 'settings.set', patch: { reversePath: '/opt/rea/bin/rea' } }), { timeout: 10_000 });
    tty.emit('data', Buffer.from('/reverse path none\r'));
    await vi.waitFor(() => expect(requests.filter(r => r.kind === 'settings.set').at(-1)).toEqual({ kind: 'settings.set', patch: { reversePath: null } }), { timeout: 10_000 });
    expect(requests.some(r => r.kind === 'addons.plan')).toBe(false);
  } finally { await home.stop(); }
}, 30_000);

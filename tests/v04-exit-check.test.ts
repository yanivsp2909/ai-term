import { afterEach, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pty from 'node-pty';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { UsageService } from '../src/daemon/usage-service.js';
import { KeyStore } from '../src/daemon/keys.js';
import { buildBashEnv } from '../src/daemon/env.js';
import { Agent } from '../src/agent/agent.js';
import { AgentApp } from '../src/agent/app.js';
import { Screen } from '../src/agent/screen.js';
import { Transcript } from '../src/agent/transcript.js';
import { HttpReporter, readAgentSecrets, reporterEnv } from '../src/agent/report.js';
import { loadInstructions } from '../src/agent/instructions.js';
import { redactor } from '../src/agent/display.js';
import { killAllBash } from '../src/agent/bash.js';
import { createTheme } from '../src/client/tui/theme.js';

// The v0.4 exit check, headless: the daemon's real session manager, usage receiver, D48 reader and MCP service (with a
// real stdio MCP server), and AI Term's agent in-process with a stub model, driven by typed keys. No network, no real
// key, a temporary HOME. One agent on a temp repo uses a skill, a subagent and an MCP tool with every action approved
// through Ask; its cost reaches its own screen (which the card's preview mirrors) and Usage; a cap pauses it; Ctrl+K
// stops a running bash.
const SECRET = 'AITERMCANARY-exit-0123456789abcdef', ENDPOINT = 'https://narvis-resource.openai.azure.com/openai/v1', MODEL = 'gpt-6.1-sol';
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { killAllBash(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const usage = (input: number, output: number) => ({ inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: output, text: output, reasoning: undefined } });
const call = (toolName: string, input: unknown) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'tool-call' as const, toolCallId: `call-${toolName}-${Math.random()}`, toolName, input: JSON.stringify(input) }, { type: 'finish' as const, finishReason: { unified: 'tool-calls' as const, raw: undefined }, usage: usage(2000, 100) }]) });
const text = (delta: string) => ({ stream: convertArrayToReadableStream([{ type: 'stream-start' as const, warnings: [] }, { type: 'text-start' as const, id: 't' }, { type: 'text-delta' as const, id: 't', delta }, { type: 'text-end' as const, id: 't' }, { type: 'finish' as const, finishReason: { unified: 'stop' as const, raw: undefined }, usage: usage(2000, 50) }]) });
type Steps = NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>['doStream'];

// A minimal MCP server over stdio: initialize, one tool, and an echo that also proves it got no key.
const SERVER = `import {createInterface} from 'node:readline';
const tools=[{name:'echo',description:'Echo a message back',inputSchema:{type:'object',properties:{message:{type:'string'}},required:['message']}}];
createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'stub',version:'1'}}:m.method==='tools/list'?{tools}:
  {content:[{type:'text',text:'echo: '+m.params.arguments.message+' · key in env: '+Object.values(process.env).some(v=>v.includes('AITERMCANARY'))}]};
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`;

async function world(settings: Record<string, unknown> = {}) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ai-exit-')));
  cleanups.push(() => rm(home, { recursive: true, force: true }));
  // homedir() follows HOME: the reader's user roots and the MCP service's home are this empty temp home, never yours.
  vi.stubEnv('HOME', home);
  const root = join(home, 'state'), paths = getPaths(root); await mkdir(root, { mode: 0o700 }); await preparePaths(paths);
  await writeFile(join(root, 'settings.json'), JSON.stringify({ theme: 'graphite', worktrees: 'off', ...settings }), { mode: 0o600 });
  // The temp repo: a skill, a subagent and a project MCP server, committed like a real project.
  const repo = join(home, 'repo');
  await mkdir(join(repo, '.claude', 'skills', 'notes'), { recursive: true }); await mkdir(join(repo, '.claude', 'agents'), { recursive: true });
  await writeFile(join(repo, 'AGENTS.md'), '# Exit check repo\nKeep notes short.\n');
  await writeFile(join(repo, '.claude', 'skills', 'notes', 'SKILL.md'), '---\nname: notes\ndescription: How to write NOTES.md\n---\nNOTES SKILL BODY: one line per fact.\n');
  await writeFile(join(repo, '.claude', 'agents', 'scribe.md'), '---\nname: scribe\ndescription: Writes files it is asked to\n---\nSCRIBE INSTRUCTIONS: write exactly what you are given.\n');
  await writeFile(join(repo, 'server.mjs'), SERVER);
  await writeFile(join(repo, '.mcp.json'), JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [join(repo, 'server.mjs')] } } }));
  for (const args of [['init', '-q'], ['add', '-A'], ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']]) execFileSync('git', args, { cwd: repo, env: { PATH: '/usr/bin:/bin', HOME: home } });
  const log = new Logger(paths.log), usageService = new UsageService(root, log), vault = new Map<string, string>();
  const keys = new KeyStore(root, { vault: { read: async a => vault.get(a) ?? null, write: async (a, s) => { vault.set(a, s); }, remove: async a => { vault.delete(a); } } });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, usageService, '/opt/ai-term/dist/cli/index.js');
  await usageService.start(); await manager.load();
  cleanups.push(async () => { await manager.shutdown(); await usageService.close(); });
  // The PTY child stands in for `ai agent`; the agent itself runs in this process with the env the daemon built for it.
  const spawned: Record<string, string>[] = [], real = pty.spawn;
  vi.spyOn(pty, 'spawn').mockImplementation((file, args, options) => { spawned.push({ ...(options?.env as Record<string, string>) }); return real('/bin/sh', ['-c', 'printf ready; read done'], { ...options, env: { PATH: '/usr/bin:/bin' } }); });
  const key = await keys.add({ provider: 'foundry', label: 'narvis', secret: SECRET, endpoint: ENDPOINT, deployments: [MODEL] });
  await keys.saveTest(key.id, [{ model: MODEL, status: 'ready' }]);
  const session = await manager.create({ engine: 'ai-term', model: MODEL, auth: { kind: 'key', keyId: key.id }, cwd: repo, permission: 'ask' });
  await expect.poll(() => manager.get(session.id).status).toBe('running');
  const env = spawned.at(-1) ?? {};
  // Gate: the key reaches the agent in its 0600 secrets file, never in its env.
  expect(env.AITERM_AGENT_KEY).toBeUndefined(); expect(readAgentSecrets(env).AITERM_AGENT_KEY).toBe(SECRET);
  return { home, root, repo, manager, usage: usageService, session, env, log: paths.log };
}

async function agent(w: Awaited<ReturnType<typeof world>>, steps: Steps) {
  const reporter = new HttpReporter(reporterEnv(w.env), () => { throw new Error('reporting failed'); });
  const model = new MockLanguageModelV4({ doStream: steps }), transcriptPath = join(w.root, 'sessions', w.session.id, 'transcript.jsonl');
  const redact = redactor(SECRET), transcript = new Transcript(transcriptPath, redact, () => { throw new Error('transcript failed'); });
  const instructions = await loadInstructions(w.repo);
  let output = '';
  const quit = vi.fn();
  const app = new AgentApp({
    screen: new Screen({ write: s => { output += s; }, columns: 160, rows: 60 }, createTheme('graphite')), permission: 'ask', models: [MODEL], makeModel: async () => model,
    agent: io => new Agent({ root: w.repo, permission: 'ask', model, modelId: MODEL, instructions, reporter, transcript, io, redact, bashEnv: buildBashEnv(process.env), rg: null, extensions: reporter, mcp: reporter.mcp, models: [MODEL], makeModel: async () => model }),
    quit,
  });
  cleanups.push(async () => { app.close(); await vi.waitFor(() => expect(quit).toHaveBeenCalled()); await transcript.close(); });
  app.start();
  // Waits for the approval line, then answers with one typed key, as a person would.
  const answer = async (title: string, key: string) => { await vi.waitFor(() => expect(output).toContain(`● allow ${title}?`), { timeout: 5000 }); const before = output.length; app.input(key); await vi.waitFor(() => expect(output.slice(before)).toMatch(/✓ allowed|✗ denied/)); };
  return { app, model, reporter, transcriptPath, answer, get output() { return output; } };
}

it('one agent does a small task with a skill, a subagent and an MCP tool, every action approved through Ask; cost reaches Usage', async () => {
  const w = await world();
  const a = await agent(w, [
    call('skill', { name: 'notes' }),
    call('task', { name: 'scribe', prompt: 'Write NOTES.md with the line: exit check' }),
    call('write', { path: 'NOTES.md', content: 'exit check\n' }), text('Wrote NOTES.md.'),
    call('mcp_tools', { server: 'stub', tool: 'echo' }),
    call('mcp_call', { server: 'stub', tool: 'echo', arguments: { message: 'hello' } }),
    call('bash', { command: 'cat NOTES.md' }),
    text('All done: NOTES.md written and checked.'),
  ]);
  a.app.input('Write NOTES.md using the notes skill and the scribe, ping the stub MCP server, then cat the file\r');
  await a.answer('task scribe', '\r');
  await a.answer('write NOTES.md', 'y');
  await a.answer('MCP server stub', 'y');
  await a.answer('MCP stub/echo', 'y');
  await a.answer('bash · 120s limit', 'y');
  await vi.waitFor(() => expect(w.manager.get(w.session.id).status).toBe('done'), { timeout: 5000 });

  // The work happened, and only after five typed approvals: job, write, project server, MCP call, bash.
  expect(await readFile(join(w.repo, 'NOTES.md'), 'utf8')).toBe('exit check\n');
  expect(a.output.match(/● allow /g)).toHaveLength(5);
  expect(a.output.match(/✓ allowed/g)).toHaveLength(5);
  const prompts = a.model.doStreamCalls.map(c => JSON.stringify(c.prompt));
  expect(prompts).toHaveLength(8);
  expect(prompts[1]).toContain('NOTES SKILL BODY');                 // the skill loaded on use
  expect(prompts[2]).toContain('SCRIBE INSTRUCTIONS');              // the subagent's own conversation
  expect(prompts[2]).not.toContain('NOTES SKILL BODY');
  expect(prompts[4]).toContain('Wrote NOTES.md.');                  // only its final answer returns to the parent
  expect(prompts[6]).toContain('echo: hello · key in env: false');  // the MCP tool ran, without the key
  expect(prompts[7]).toContain('exit check');                       // bash output
  expect(w.manager.get(w.session.id)).toMatchObject({ status: 'done', model: MODEL });
  expect((await w.manager.text(w.session.id, true)).text).toBe('All done: NOTES.md written and checked.');

  // Cost: every request's tokens reached Usage, priced. The agent's turn lines (its own and the subagent's, which the
  // card's preview mirrors) add up to the same cost. The homepage card itself shows no cost (status, model, ctx %).
  const tokens = 8 * 2000 + 6 * 100 + 2 * 50;
  await vi.waitFor(() => expect(w.usage.summary().today.tokens).toBe(tokens));
  const today = w.usage.summary().today;
  expect(today.costUsd).toBeGreaterThan(0);
  expect(today.providers).toEqual([expect.objectContaining({ provider: 'foundry', tokens })]);
  expect(a.output).toMatch(/scribe: turn · 4\.0k in · 150 out · \$\d+\.\d{4}/);
  expect(a.output).toMatch(/turn · 12\.0k in · 550 out · \$\d+\.\d{4} · run 8\/100 turns/);
  const shown = [...a.output.matchAll(/turn · [^$\n]*\$(\d+\.\d{4})/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  expect(Math.abs(shown - today.costUsd)).toBeLessThan(0.0002);

  // The key never reached the transcript, the log or the screen.
  for (const text of [await readFile(a.transcriptPath, 'utf8'), await readFile(w.log, 'utf8').catch(() => ''), a.output]) expect(text).not.toContain(SECRET);
});

it('a turn cap pauses the agent before the next request, the card shows it waiting, and Esc stops without sending', async () => {
  const w = await world({ agentCaps: { turns: 2, spendUsd: 5 } });
  const a = await agent(w, [call('read', { path: 'AGENTS.md' }), call('read', { path: 'AGENTS.md' }), text('never sent')]);
  a.app.input('read AGENTS.md three times\r');
  await vi.waitFor(() => expect(a.output).toContain('● paused · cap reached: 2 turns this run'));
  await vi.waitFor(() => expect(w.manager.get(w.session.id)).toMatchObject({ status: 'waiting', statusDetail: 'question' }));
  expect(a.model.doStreamCalls).toHaveLength(2);
  a.app.input('\x1b');
  await vi.waitFor(() => expect(a.output).toContain('■ interrupted'));
  expect(a.model.doStreamCalls).toHaveLength(2);
});

it('Ctrl+K stops a running bash at once: its whole process group is gone and nothing more is sent', async () => {
  const w = await world();
  const a = await agent(w, [call('bash', { command: 'echo $$ > bash.pid; sleep 30 & wait' }), text('never sent')]);
  a.app.input('run something slow\r');
  await a.answer('bash · 120s limit', 'y');
  const pid = Number(await vi.waitFor(async () => { const text = await readFile(join(w.repo, 'bash.pid'), 'utf8'); expect(text).toMatch(/^\d+\n$/); return text; }));
  const started = Date.now();
  a.app.input('\x0b');
  await vi.waitFor(() => expect(() => process.kill(-pid, 0)).toThrow());
  expect(Date.now() - started).toBeLessThan(2000);
  await vi.waitFor(() => expect(a.app.running).toBe(false));
  expect(a.output).toContain('killed: the request and 1 running command');
  expect(a.model.doStreamCalls).toHaveLength(1);
});

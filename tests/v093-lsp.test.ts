import { afterEach, expect, it, vi } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspPool, findServer, formatDiagnostics, languageOf, LSP_IDLE_MS, LSP_SETTLE_MS } from '../src/agent/lsp.js';
import type { Deadline } from '../src/shared/deadline.js';
import { buildBashEnv, buildAgentArgs } from '../src/daemon/env.js';
import { parseAgentArgs } from '../src/agent/main.js';

// v0.9.3 LSP diagnostics for AI Term's agent (D55, off by default: they add tokens to every write). After a write or edit
// the agent gets that file's errors from a language server, capped at 40 lines. Only servers on PATH outside the
// worktree and node_modules/.bin (the agent can write those); run under the bash sandbox (D57) with no keys; no sandbox,
// no server, said once. One server per language per agent, stopped at exit or after 10 idle minutes.
const MAC = process.platform === 'darwin', roots: string[] = [], pools: LspPool[] = [];
afterEach(async () => { for (const pool of pools.splice(0)) await pool.stopAll(); vi.useRealTimers(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-lsp-'))); roots.push(dir); return dir; }

// A tiny language server: answers initialize, and for each opened or changed file publishes one error per line that
// says ERROR, plus a log of its own env so a test can see what reached it.
const FAKE = `#!${process.execPath}
let buf = Buffer.alloc(0);
const send = m => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b); };
process.stdin.on('data', d => { buf = Buffer.concat([buf, d]); for (;;) { const h = buf.indexOf('\\r\\n\\r\\n'); if (h < 0) return; const len = Number(/Content-Length: (\\d+)/.exec(buf.subarray(0, h).toString())[1]); if (buf.length < h + 4 + len) return; const msg = JSON.parse(buf.subarray(h + 4, h + 4 + len).toString()); buf = buf.subarray(h + 4 + len); handle(msg); } });
function handle(m) {
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {}, serverInfo: { name: 'fake', env: Object.keys(process.env).filter(k => /KEY|TOKEN|AITERM/.test(k)) } } });
  if (m.method === 'shutdown') send({ jsonrpc: '2.0', id: m.id, result: null });
  if (m.method === 'exit') process.exit(0);
  const doc = m.params && m.params.textDocument; if (!doc) return;
  const text = m.method === 'textDocument/didOpen' ? doc.text : m.params.contentChanges && m.params.contentChanges[0].text; if (text === undefined) return;
  const diagnostics = text.split('\\n').flatMap((line, i) => line.includes('ERROR') ? [{ range: { start: { line: i, character: 2 }, end: { line: i, character: 5 } }, severity: 1, code: 'X' + i, message: 'bad thing on line ' + (i + 1) }] : []);
  send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: doc.uri, diagnostics } });
}
`;
// B31: the 8 s deadline never fires and the settle ends on the next tick, so the answer is the server's, not the clock's.
const answersOnly: Deadline = (ms, fire) => { if (ms !== LSP_SETTLE_MS) return () => {}; const tick = setImmediate(fire); return () => clearImmediate(tick); };
async function setup() {
  const dir = await temp(), bin = join(dir, 'bin'), tree = join(dir, 'home', '.ai-term', 'worktrees', 'r', 'a'), aiTerm = join(dir, 'home', '.ai-term');
  await mkdir(bin); await mkdir(tree, { recursive: true });
  await writeFile(join(bin, 'typescript-language-server'), FAKE); await chmod(join(bin, 'typescript-language-server'), 0o755);
  const env = { ...buildBashEnv(process.env), PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(dir, 'home') };
  return { dir, bin, tree, aiTerm, env };
}

it('languages by extension: TS/JS, Python, Go, Rust; anything else none', () => {
  expect(languageOf('src/a.ts')).toMatchObject({ id: 'typescript', server: 'typescript-language-server' });
  expect(languageOf('a.jsx')).toMatchObject({ id: 'typescript' });
  expect(languageOf('a.py')).toMatchObject({ id: 'python' });
  expect(languageOf('main.go')).toMatchObject({ id: 'go', server: 'gopls' });
  expect(languageOf('lib.rs')).toMatchObject({ id: 'rust', server: 'rust-analyzer' });
  expect(languageOf('README.md')).toBeNull();
});

it('a server comes only from PATH outside the worktree and never from node_modules/.bin', async () => {
  const { bin, tree } = await setup();
  await mkdir(join(tree, 'node_modules', '.bin'), { recursive: true });
  await writeFile(join(tree, 'node_modules', '.bin', 'typescript-language-server'), FAKE); await chmod(join(tree, 'node_modules', '.bin', 'typescript-language-server'), 0o755);
  await writeFile(join(tree, 'gopls'), FAKE); await chmod(join(tree, 'gopls'), 0o755);
  expect(await findServer('typescript-language-server', `${join(tree, 'node_modules', '.bin')}:${bin}`, tree)).toBe(join(bin, 'typescript-language-server'));
  expect(await findServer('gopls', tree, tree)).toBeNull();
  expect(await findServer('typescript-language-server', join('/elsewhere', 'node_modules', '.bin'), tree)).toBeNull();
});

it('diagnostics read as one short block, at most 40 lines', () => {
  const many = Array.from({ length: 60 }, (_, i) => ({ range: { start: { line: i, character: 0 }, end: { line: i, character: 1 } }, severity: 1, message: `problem ${i}\nsecond line` }));
  const text = formatDiagnostics('src/a.ts', many);
  expect(text.split('\n').length).toBeLessThanOrEqual(40);
  expect(text.split('\n')[0]).toBe('diagnostics for src/a.ts: 60 errors');
  expect(text).toContain('1:1 error problem 0 second line');
  expect(text.split('\n').at(-1)).toBe('… 22 more');
  expect(formatDiagnostics('src/a.ts', [])).toBe('diagnostics for src/a.ts: none');
});

it.skipIf(!MAC)('macOS: after a write the agent gets the file\'s errors from a sandboxed server with no keys; one server per language; idle 10 minutes stops it', async () => {
  const { tree, aiTerm, env } = await setup();
  const pool = new LspPool({ root: tree, env: { ...env, AITERM_AGENT_KEY: 'sk-ant-should-not-pass' }, sandbox: { home: aiTerm, user: join(tree, '..', '..', '..', '..') }, deadline: answersOnly }); pools.push(pool);
  await writeFile(join(tree, 'a.ts'), 'const x = 1;\nERROR here\n');
  const first = await pool.diagnose('a.ts');
  expect(first).toBe('diagnostics for a.ts: 1 error\n2:3 error X1 bad thing on line 2');
  await writeFile(join(tree, 'a.ts'), 'fine\n');
  expect(await pool.diagnose('a.ts')).toBe('diagnostics for a.ts: none');
  expect(pool.running()).toEqual(['typescript']);
  expect(pool.serverEnv('typescript')).toEqual([]);
  expect(LSP_IDLE_MS).toBe(10 * 60_000);
  await pool.idleCheck(Date.now() + LSP_IDLE_MS + 1);
  expect(pool.running()).toEqual([]);
}, 30_000);

it('without a sandbox no server starts, and the agent is told once; a file with no server says nothing', async () => {
  const { tree, env } = await setup();
  const pool = new LspPool({ root: tree, env, sandbox: { home: join(tree, 'x'), platform: 'win32' } }); pools.push(pool);
  await writeFile(join(tree, 'a.ts'), 'ERROR\n');
  expect(await pool.diagnose('a.ts')).toBe("diagnostics are off for this agent: language servers run only in AI Term's sandbox, and Windows has none AI Term can use");
  expect(await pool.diagnose('a.ts')).toBe('');
  expect(await pool.diagnose('README.md')).toBe('');
  expect(pool.running()).toEqual([]);
});

it('the switch: off by default; the daemon passes --lsp only when it is on; the agent reads it', () => {
  const base = { command: { node: '/usr/bin/node', entry: '/opt/ai/dist/cli/index.js' }, provider: 'anthropic' as const, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], permission: 'ask' as const, theme: 'graphite' as const, transcript: '/tmp/t.jsonl' };
  expect(buildAgentArgs(base).args).not.toContain('--lsp');
  expect(buildAgentArgs({ ...base, lsp: true }).args).toContain('--lsp');
  expect(parseAgentArgs(['--provider=anthropic', '--model=claude-sonnet-5-5', '--lsp']).lsp).toBe(true);
  expect(parseAgentArgs(['--provider=anthropic', '--model=claude-sonnet-5-5']).lsp).toBe(false);
});

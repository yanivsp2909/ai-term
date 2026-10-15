import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspPool, formatDiagnostics } from '../src/agent/lsp.js';
import { buildBashEnv } from '../src/daemon/env.js';

// v0.9.3 review (typescript-reviewer, fresh context): each failed before its fix.
const MAC = process.platform === 'darwin', roots: string[] = [], pools: LspPool[] = [];
afterEach(async () => { for (const pool of pools.splice(0)) await pool.stopAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function setup(server: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-lsp-rev-'))); roots.push(dir);
  const bin = join(dir, 'bin'), tree = join(dir, 'home', '.ai-term', 'worktrees', 'r', 'a'), aiTerm = join(dir, 'home', '.ai-term');
  await mkdir(bin); await mkdir(tree, { recursive: true });
  await writeFile(join(bin, 'typescript-language-server'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(join(tree, 'starts.log'))}, 'x');\n${server}\n`); await chmod(join(bin, 'typescript-language-server'), 0o755);
  await writeFile(join(tree, 'a.ts'), 'ERROR\n');
  const env = { ...buildBashEnv(process.env), PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: join(dir, 'home') };
  const pool = new LspPool({ root: tree, env, sandbox: { home: aiTerm }, waitMs: 500 }); pools.push(pool);
  const starts = async () => (await readFile(join(tree, 'starts.log'), 'utf8').catch(() => '')).length;
  return { pool, starts };
}

it.skipIf(!MAC)('HIGH: a server that never answers initialize can\'t hold a write: it gives up in time, and an interrupted turn stops waiting at once', async () => {
  const { pool } = await setup("process.stdin.resume(); setInterval(() => {}, 1000);");
  const begun = Date.now();
  expect(await pool.diagnose('a.ts')).toBe("diagnostics for a.ts: the language server didn't answer in time");
  expect(Date.now() - begun).toBeLessThan(5000);
  const abort = new AbortController(); setTimeout(() => abort.abort(), 100);
  const again = Date.now();
  expect(await pool.diagnose('a.ts', abort.signal)).toBe('');
  expect(Date.now() - again).toBeLessThan(400);
}, 20_000);

it.skipIf(!MAC)('MEDIUM: a server that crashes at start answers at once, is said once, and isn\'t started again on every write', async () => {
  const { pool, starts } = await setup('process.exit(1);');
  const begun = Date.now();
  expect(await pool.diagnose('a.ts')).toBe("diagnostics for a.ts: typescript-language-server stopped; diagnostics for this language are off until the agent restarts");
  expect(await pool.diagnose('a.ts')).toBe('');
  expect(Date.now() - begun).toBeLessThan(3000);
  expect(await starts()).toBe(1);
}, 20_000);

it.skipIf(!MAC)('MEDIUM: two writes at once start one server, and stopping leaves none behind', async () => {
  const { pool, starts } = await setup("process.stdin.resume(); setInterval(() => {}, 1000);");
  const abort = new AbortController(); setTimeout(() => abort.abort(), 300);
  await Promise.all([pool.diagnose('a.ts', abort.signal), pool.diagnose('a.ts', abort.signal)]);
  expect(await starts()).toBe(1);
  expect(pool.running()).toEqual(['typescript']);
}, 20_000);

it('LOW: a diagnostic without a column, with an odd code or severity still reads plainly', () => {
  const text = formatDiagnostics('a.ts', [{ range: { start: { line: 0 } }, severity: 'bad', code: { value: 'x' }, message: 'm' } as never]);
  expect(text).toBe('diagnostics for a.ts: 1 error\n1:1 error m');
});

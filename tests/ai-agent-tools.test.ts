import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTool, writeTool, editTool, searchTool, findRipgrep, diffPreview } from '../src/agent/tools.js';
import { runBash, bashReport, bashPreview } from '../src/agent/bash.js';
import { buildAgentEnv, buildBashEnv } from '../src/daemon/env.js';

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function folder() { const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-tools-'))); roots.push(root); return root; }

it('read numbers lines, pages with offset and says when more is left', async () => {
  const root = await folder();
  await writeFile(join(root, 'f.txt'), Array.from({ length: 3000 }, (_, i) => `line ${i + 1}`).join('\n'));
  const first = await readTool(root, { path: 'f.txt' });
  expect(first.split('\n')[0]).toBe('    1  line 1');
  expect(first).toContain('1000 more lines (read again with offset 2001)');
  expect(await readTool(root, { path: 'f.txt', offset: 2999, limit: 5 })).toBe(' 2999  line 2999\n 3000  line 3000');
  await writeFile(join(root, 'bin'), Buffer.from([1, 0, 2]));
  expect(await readTool(root, { path: 'bin' })).toContain('binary');
  await expect(readTool(root, { path: 'missing.txt' })).rejects.toThrow('File not found');
});

it('write creates folders inside the folder; edit replaces exactly one match unless told otherwise', async () => {
  const root = await folder();
  expect(await writeTool.run(root, { path: 'src/new/a.ts', content: 'const a = 1;\nconst b = 2;\n' })).toBe('wrote src/new/a.ts (3 lines)');
  expect((await writeTool.preview(root, { path: 'src/new/a.ts', content: 'const a = 1;\nconst b = 3;\n' })).body).toBe('from line 2\n- const b = 2;\n+ const b = 3;');
  expect((await writeTool.preview(root, { path: 'fresh.txt', content: 'hi' })).body).toBe('new file\n+ hi');
  await expect(editTool.run(root, { path: 'src/new/a.ts', old: 'const', new: 'let' })).rejects.toThrow('appears 2 times');
  await expect(editTool.run(root, { path: 'src/new/a.ts', old: 'nope', new: 'x' })).rejects.toThrow('not found');
  expect(await editTool.run(root, { path: 'src/new/a.ts', old: 'b = 2', new: 'b = $&' })).toBe('edited src/new/a.ts (1 replacement)');
  expect(await readFile(join(root, 'src/new/a.ts'), 'utf8')).toBe('const a = 1;\nconst b = $&;\n');
  expect(await editTool.run(root, { path: 'src/new/a.ts', old: 'const', new: 'let', replaceAll: true })).toBe('edited src/new/a.ts (2 replacements)');
  await expect(writeTool.run(root, { path: 'big', content: 'x'.repeat(1024 * 1024 + 1) })).rejects.toThrow('up to');
});

it('an approval shows escape sequences and invisible characters instead of letting them hide text', () => {
  const body = bashPreview('echo safe\r\x1b[2Krm -rf ~ ‮', 120_000).body;
  expect(body).toBe('echo safe\\r␛[2Krm -rf ~ <U+202E>');
  expect(diffPreview('a', 'a\n\x1b]52;c;eA==\x07')).toContain('␛]52;c;eA==<U+0007>');
});

it('search finds text with the plain fallback, skipping .git, node_modules and symlinks', async () => {
  const root = await folder();
  await mkdir(join(root, 'src')); await mkdir(join(root, '.git')); await mkdir(join(root, 'node_modules'));
  await writeFile(join(root, 'src', 'a.ts'), 'needle here\nnothing\n'); await writeFile(join(root, '.git', 'x'), 'needle'); await writeFile(join(root, 'node_modules', 'y'), 'needle');
  const outside = await folder(); await writeFile(join(outside, 'z'), 'needle'); await symlink(outside, join(root, 'out'));
  expect(await searchTool(root, { pattern: 'needle' }, null)).toBe('src/a.ts:1:needle here');
  expect(await searchTool(root, { pattern: 'absent' }, null)).toBe('no matches');
  await expect(searchTool(root, { pattern: 'needle', path: 'out' }, null)).rejects.toThrow('outside the folder');
});

it('search uses ripgrep when it is installed', async () => {
  const rg = await findRipgrep();
  if (!rg) return; // Not installed on this machine: the fallback test above covers search.
  const root = await folder();
  await writeFile(join(root, 'a.txt'), 'alpha\nbeta 42\n');
  expect(await searchTool(root, { pattern: 'beta \\d+' }, rg)).toBe('a.txt:2:beta 42');
});

it('normalizes ripgrep relative prefixes without changing a match that contains ./', async () => {
  const root = await folder(), rg = join(root, 'fake-rg');
  await writeFile(rg, '#!/usr/bin/env node\nprocess.stdout.write("./a.txt:2:beta ./path\\nsub/b.txt:1:beta\\n");\n');
  await chmod(rg, 0o700);
  expect(await searchTool(root, { pattern: 'beta' }, rg)).toBe('a.txt:2:beta ./path\nsub/b.txt:1:beta');
});

it('bash runs in the folder with no key, no credential and nothing of AI Term\'s in its env', async () => {
  const root = await folder(), key = 'AITERMCANARY-bash-0123456789abcdef';
  const agentEnv = buildAgentEnv({ PATH: process.env.PATH, HOME: '/tmp' }, { secret: key, endpoint: 'https://r.openai.azure.com/openai/v1', status: { port: 1234, credential: 'a'.repeat(64) }, usage: { port: 1234, credential: 'b'.repeat(64) }, entry: '/x/dist/cli/index.js' });
  const result = await runBash('pwd; env', { cwd: root, env: buildBashEnv({ ...agentEnv, OPENAI_API_KEY: 'sk-x' }) });
  expect(result.exitCode).toBe(0);
  expect(result.stdout.split('\n')[0]).toBe(root);
  expect(result.stdout).not.toContain(key); expect(result.stdout).not.toMatch(/AITERM|AI_TERM|OPENAI|TOKEN/);
});

it('bash stops the whole process group at the timeout and caps output', async () => {
  const root = await folder(), started = Date.now();
  const slow = await runBash('sleep 30 & sleep 30; echo never', { cwd: root, env: buildBashEnv(process.env), timeoutMs: 1000 });
  expect(slow.timedOut).toBe(true); expect(Date.now() - started).toBeLessThan(5000);
  expect(bashReport(slow, 1000)).toContain('timed out after 1s');
  const loud = await runBash('yes hello | head -c 200000', { cwd: root, env: buildBashEnv(process.env), maxBytes: 1000 });
  expect(loud.stdout.length).toBe(1000); expect(loud.cut).toBe(true);
  expect(bashReport(loud, 120_000)).toContain('output cut at');
  expect((await runBash('exit 3', { cwd: root, env: buildBashEnv(process.env) })).exitCode).toBe(3);
});

it('bash stops at once when the turn is interrupted', async () => {
  const root = await folder(), abort = new AbortController(), started = Date.now();
  setTimeout(() => abort.abort(), 200);
  const result = await runBash('sleep 30', { cwd: root, env: buildBashEnv(process.env), signal: abort.signal });
  expect(result.interrupted).toBe(true); expect(Date.now() - started).toBeLessThan(3000);
});

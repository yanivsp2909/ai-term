import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { parseTs, parsePy, renderBrain, brainPrompt, parseSummaries, BRAIN_MAX_LINES, brainMention, validateBrainPlan, type BrainIndex } from '../src/shared/brain.js';
import { scanRepo, brainPaths, readBrain, writeBrain, removeBrain } from '../src/daemon/brain.js';
import { buildArgs, buildAgentArgs } from '../src/daemon/env.js';
import { parseAgentArgs } from '../src/agent/main.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { validateRequest } from '../src/shared/validate.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v1.0.2 /brain: a map of the repository, built only when you run it. A free local pass (tree, imports and exports for
// TS/JS and Python, who imports whom; ignored, binary, >256 KB, .env and secret-flagged files skipped), an optional model
// pass that asks first; brain.md (≤2,000 lines) and brain.json (hashes) under ~/.ai-term/brain/<repo id>, never in the repo.
const run = promisify(execFile), roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const ID = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
async function repo() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-brain-'))); roots.push(root);
  const top = join(root, 'proj'), home = join(root, 'home'); await mkdir(join(top, 'src'), { recursive: true }); await mkdir(join(top, 'py', 'pkg'), { recursive: true }); await mkdir(home, { mode: 0o700 });
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', top]);
  await writeFile(join(top, 'src', 'a.ts'), "import { x } from './b';\nimport fs from 'node:fs';\nexport function foo() { return x; }\nexport class Bar {}\n");
  await writeFile(join(top, 'src', 'b.ts'), "export const x = 1;\nexport default function main() {}\nexport { x as y };\n");
  await writeFile(join(top, 'src', 'c.js'), "const b = require('./b');\nmodule.exports = { c: 1 };\n");
  await writeFile(join(top, 'py', 'pkg', '__init__.py'), '');
  await writeFile(join(top, 'py', 'pkg', 'm.py'), 'import os\nfrom .n import helper\nfrom pkg import n\n\ndef run():\n    pass\n\nclass Thing:\n    pass\n\ndef _private():\n    pass\n');
  await writeFile(join(top, 'py', 'pkg', 'n.py'), 'def helper():\n    return 1\n');
  await writeFile(join(top, 'README.md'), '# proj\n');
  await writeFile(join(top, '.env'), 'TOKEN=abc\n');
  await writeFile(join(top, 'logo.bin'), Buffer.from([0x89, 0x50, 0x00, 0x01, 0x02]));
  await writeFile(join(top, 'huge.txt'), 'x'.repeat(300 * 1024));
  await writeFile(join(top, 'leak.ts'), 'export const key = "AKIAIOSFODNN7EXAMPLQ";\n');
  await writeFile(join(top, '.gitignore'), 'build/\n');
  await mkdir(join(top, 'build')); await writeFile(join(top, 'build', 'out.js'), 'ignored');
  await run('/usr/bin/git', [...ID, 'add', '--', '.'], { cwd: top }); await run('/usr/bin/git', [...ID, 'commit', '-qm', 'i', '--'], { cwd: top });
  return { root, top, home };
}

it('TS/JS: imports and exports, ESM and CommonJS', () => {
  expect(parseTs("import { x } from './b';\nimport type { T } from \"./t\";\nexport * from './all';\nconst m = await import('./lazy');\nconst r = require('./req');\nexport function foo() {}\nexport const a = 1, b = 2;\nexport default class Main {}\nexport { q as w, e };\nexport interface Shape {}\nexport type Id = string;\n")).toEqual({
    imports: ['./b', './t', './all', './lazy', './req'], exports: ['foo', 'a', 'b', 'default', 'w', 'e', 'Shape', 'Id'],
  });
});

it('Python: imports (relative too) and public top-level names, or __all__', () => {
  expect(parsePy('import os, sys\nfrom .n import helper\nfrom ..up import thing\nfrom pkg.sub import z\n\ndef run():\n    pass\nclass Thing:\n    pass\ndef _hidden():\n    pass\nVALUE = 1\n')).toEqual({ imports: ['os', 'sys', '.n', '..up', 'pkg.sub'], exports: ['run', 'Thing', 'VALUE'] });
  expect(parsePy('__all__ = ["a", \'b\']\ndef a(): pass\ndef b(): pass\ndef c(): pass\n').exports).toEqual(['a', 'b']);
});

it('the local pass: tracked and untracked files git does not ignore; binaries, >256 KB, .env and secret-flagged files are skipped; local imports resolved', async () => {
  const { top } = await repo();
  await writeFile(join(top, 'src', 'new.ts'), "import { foo } from './a.js';\n");
  const { index, parsed } = await scanRepo(top, null);
  expect(Object.keys(index.files).sort()).toEqual(['.gitignore', 'README.md', 'py/pkg/__init__.py', 'py/pkg/m.py', 'py/pkg/n.py', 'src/a.ts', 'src/b.ts', 'src/c.js', 'src/new.ts']);
  expect(index.skipped).toEqual({ binary: 1, large: 1, env: 1, secret: 1 });
  expect(index.files['src/a.ts']).toMatchObject({ lang: 'ts', exports: ['foo', 'Bar'], local: ['src/b.ts'] });
  expect(index.files['src/new.ts']?.local).toEqual(['src/a.ts']);
  expect(index.files['src/c.js']?.local).toEqual(['src/b.ts']);
  expect(index.files['py/pkg/m.py']).toMatchObject({ lang: 'py', exports: ['run', 'Thing'], local: ['py/pkg/n.py', 'py/pkg/__init__.py'] });
  expect(index.files['README.md']).toMatchObject({ lang: 'other', exports: [], local: [] });
  expect(index.files['src/a.ts']?.hash).toMatch(/^[0-9a-f]{64}$/);
  expect(parsed.length).toBe(9);
});

it('again: only changed files are parsed; removed files leave the map', async () => {
  const { top } = await repo();
  const first = await scanRepo(top, null);
  const same = await scanRepo(top, first.index);
  expect(same.parsed).toEqual([]); expect(same.removed).toEqual([]);
  await writeFile(join(top, 'src', 'b.ts'), 'export const x = 2;\n'); await rm(join(top, 'README.md'));
  const next = await scanRepo(top, first.index);
  expect(next.parsed).toEqual(['src/b.ts']); expect(next.removed).toEqual(['README.md']);
  expect(next.index.files['src/b.ts']?.exports).toEqual(['x']);
});

it('brain.md: tree, modules with exports, imports and importers, design notes; never past 2,000 lines', async () => {
  const { top } = await repo();
  const { index } = await scanRepo(top, null);
  const text = renderBrain({ ...index, design: ['One daemon owns every PTY'], files: { ...index.files, 'src/a.ts': { ...index.files['src/a.ts']!, summary: 'Entry helpers.' } } }, new Date());
  expect(text).toContain('# Brain: proj');
  expect(text).toContain('## Design');
  expect(text).toContain('- One daemon owns every PTY');
  expect(text).toContain('### src/a.ts');
  expect(text).toContain('Entry helpers.');
  expect(text).toContain('exports: foo, Bar');
  expect(text).toContain('imports: src/b.ts');
  expect(text).toMatch(/### src\/b\.ts[\s\S]*imported by: src\/a\.ts, src\/c\.js/);
  expect(text).toContain('skipped: 1 binary, 1 over 256 KB, 1 .env, 1 flagged by the secret scan');
  const many: BrainIndex = { ...index, files: Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`src/f${i}.ts`, { hash: 'a'.repeat(64), lang: 'ts' as const, bytes: 10, exports: ['a', 'b'], local: [`src/f${(i + 1) % 3000}.ts`] }])) };
  const big = renderBrain(many, new Date());
  expect(big.split('\n').length).toBeLessThanOrEqual(BRAIN_MAX_LINES);
  expect(big).toContain('brain.json');
});

it('it lives under ~/.ai-term/brain/<repo id> (0700 folder, 0600 files), never in the repository; rm deletes it', async () => {
  const { top, home } = await repo();
  const { index } = await scanRepo(top, null);
  const paths = brainPaths(home, top);
  expect(paths.dir.startsWith(join(home, 'brain') + '/')).toBe(true);
  await writeBrain(home, top, index);
  expect((await stat(paths.dir)).mode & 0o777).toBe(0o700);
  expect((await stat(paths.markdown)).mode & 0o777).toBe(0o600);
  expect((await stat(paths.json)).mode & 0o777).toBe(0o600);
  expect((await readBrain(home, top))?.files['src/a.ts']?.hash).toBe(index.files['src/a.ts']?.hash);
  expect((await run('/usr/bin/git', ['status', '--porcelain'], { cwd: top })).stdout).toBe('');
  await removeBrain(home, top);
  expect(await readBrain(home, top)).toBeNull();
});

it('the model pass prompt: file text with secrets removed, one summary line per path; the answer read back', () => {
  const prompt = brainPrompt([{ path: 'src/a.ts', text: 'const token = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";\nexport function foo() {}\n' }]);
  expect(prompt).not.toContain('sk-ant-api03-AAAA');
  expect(prompt).toContain('<file path="src/a.ts">');
  const read = parseSummaries('src/a.ts :: Helpers for the entry point.\nDECISION :: One process owns every PTY.\nnot/asked.ts :: no\n', ['src/a.ts']);
  expect(read.summaries).toEqual({ 'src/a.ts': 'Helpers for the entry point.' });
  expect(read.decisions).toEqual(['One process owns every PTY.']);
});

it('requests are validated', async () => {
  const id = randomUUID();
  await expect(validateRequest({ id, kind: 'brain.plan', cwd: tmpdir() })).resolves.toMatchObject({ kind: 'brain.plan' });
  await expect(validateRequest({ id, kind: 'brain.build', cwd: tmpdir(), fingerprint: 'a'.repeat(64) })).resolves.toMatchObject({ kind: 'brain.build' });
  await expect(validateRequest({ id, kind: 'brain.build', cwd: tmpdir(), fingerprint: 'a'.repeat(64), model: { keyId: randomUUID(), model: 'claude-haiku-5' } })).resolves.toMatchObject({ kind: 'brain.build' });
  await expect(validateRequest({ id, kind: 'brain.show', cwd: tmpdir() })).resolves.toMatchObject({ kind: 'brain.show' });
  await expect(validateRequest({ id, kind: 'brain.remove', cwd: tmpdir() })).resolves.toMatchObject({ kind: 'brain.remove' });
  await expect(validateRequest({ id, kind: 'brain.build', cwd: 'relative', fingerprint: 'a'.repeat(64) })).rejects.toThrow();
  expect(() => validateBrainPlan({ repo: 'x' })).toThrow();
});

it('agents get it: Claude Code through --append-system-prompt-file as one argv element, AI Term\'s agent reads it at start, Codex gets a first-message mention', () => {
  const file = '/Users/me/.ai-term/brain/proj-0123456789/brain.md';
  const claude = buildArgs({ engine: 'claude-code', model: null, permission: 'ask', brainFile: file });
  expect(claude).toContain(`--append-system-prompt-file=${file}`);
  expect(buildArgs({ engine: 'codex', model: null, permission: 'ask', brainFile: file }).join(' ')).not.toContain('brain');
  const base = { command: { node: '/usr/bin/node', entry: '/opt/ai/dist/cli/index.js' }, provider: 'anthropic' as const, model: 'claude-sonnet-5-5', models: ['claude-sonnet-5-5'], permission: 'ask' as const, theme: 'graphite' as const, transcript: '/tmp/t.jsonl' };
  expect(buildAgentArgs({ ...base, brainFile: file }).args).toContain(`--brain=${file}`);
  expect(parseAgentArgs(['--provider=anthropic', '--model=claude-sonnet-5-5', `--brain=${file}`]).brain).toBe(file);
  expect(brainMention(file, 'fix the tests')).toBe(`Before you start, read the repository map AI Term made at ${file}.\n\nfix the tests`);
});

it('the card shows when a brain was given and how old it is', () => {
  const now = Date.now(), at = new Date(now - 2 * 3600_000).toISOString();
  const session = { id: randomUUID(), title: 'fixer', engine: 'claude-code', model: 'opus', auth: { kind: 'account' }, cwd: '/w', permission: 'ask', status: 'running', statusDetail: 'running', statusSince: at, createdAt: at, lastOutputAt: at, exitCode: null, ctxPercent: null, lastActivity: null, brain: { builtAt: at } } as unknown as SessionInfo;
  const card = cardText(session, now, 80);
  expect(card.model).toContain('brain · 2h old');
});

it('reads back the markdown it wrote', async () => {
  const { top, home } = await repo();
  const { index } = await scanRepo(top, null);
  await writeBrain(home, top, index);
  expect(await readFile(brainPaths(home, top).markdown, 'utf8')).toContain('# Brain: proj');
});

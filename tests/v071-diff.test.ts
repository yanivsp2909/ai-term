import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, symlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { worktreeDiff } from '../src/daemon/diff.js';
import { DIFF_FILE_LINES, DIFF_LINE_CHARS, diffLine, validateAgentDiff, type AgentDiff } from '../src/shared/diff.js';
import { DiffView } from '../src/client/tui/diff-view.js';
import { Grid, plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';
import { cardText } from '../src/client/tui/agent-card.js';
import { validateRequest } from '../src/shared/validate.js';
import type { SessionInfo } from '../src/shared/protocol.js';
import { useFakeEngines } from './fixtures/fake-engines.js';
import { AS_ROOT } from './platform.js';
useFakeEngines();

// v0.7.1: a read-only diff of an agent's worktree against its base (committed + uncommitted + untracked), from git's own
// output as text only, capped, in a popup; d on a card or /diff [agent].
const run = promisify(execFile), roots: string[] = [], managers: SessionManager[] = [];
afterEach(async () => { for (const m of managers.splice(0)) await m.shutdown(); vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]) => run('/usr/bin/git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd });
async function repo() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-diff-'))); roots.push(temp);
  const dir = join(temp, 'repo'); await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\n'); await writeFile(join(dir, 'gone.txt'), 'bye\n'); await writeFile(join(dir, '.gitignore'), 'secret.log\n');
  await run('/usr/bin/git', ['init', '--', dir]); await git(dir, 'add', '--', '.'); await git(dir, 'commit', '-m', 'initial', '--');
  const base = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  return { temp, dir, base };
}

it('the diff covers committed, uncommitted and untracked work against the base; ignored files and symlink targets stay out', async () => {
  const { temp, dir, base } = await repo();
  await writeFile(join(dir, 'src', 'a.ts'), 'one\nTWO\nthree\nfour\n'); await git(dir, 'commit', '-am', 'agent work', '--');
  await writeFile(join(dir, 'src', 'a.ts'), 'one\nTWO\nthree\nfour\nfive\n');
  await rm(join(dir, 'gone.txt'));
  await writeFile(join(dir, 'new.md'), '# hi\n\x1b]52;c;QUFBQQ==\x07evil\x1b[2J\n'); await writeFile(join(dir, 'secret.log'), 'ignored\n');
  await writeFile(join(temp, 'outside.txt'), 'OUTSIDE CONTENT\n'); await symlink(join(temp, 'outside.txt'), join(dir, 'link'));
  await writeFile(join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
  const diff = await worktreeDiff(dir, base);
  expect(diff.files.map(f => [f.path, f.status])).toEqual([['gone.txt', 'deleted'], ['src/a.ts', 'modified'], ['blob.bin', 'untracked'], ['link', 'untracked'], ['new.md', 'untracked']]);
  const a = diff.files.find(f => f.path === 'src/a.ts');
  expect(a).toMatchObject({ added: 3, removed: 1 }); expect(a?.lines).toEqual(expect.arrayContaining(['-two', '+TWO', '+four', '+five']));
  const text = JSON.stringify(diff);
  expect(text).not.toContain('\\u001b'); expect(text).not.toContain('\\u0007'); expect(text).not.toContain('OUTSIDE CONTENT'); expect(text).not.toContain('ignored');
  expect(diff.files.find(f => f.path === 'link')?.lines).toEqual([`+→ symlink (not followed)`]);
  expect(diff.files.find(f => f.path === 'new.md')?.lines).toEqual(['+# hi', '+evil']);
  expect(diff.files.find(f => f.path === 'blob.bin')).toMatchObject({ binary: true, added: 0, lines: ['+(binary file, not shown)'] });
  expect(diff).toMatchObject({ added: 3 + 2 + 1, removed: 1 + 1, capped: false });
});

it('a huge diff is capped with a note: lines per file, characters per line', async () => {
  const { dir, base } = await repo();
  await writeFile(join(dir, 'big.txt'), Array.from({ length: DIFF_FILE_LINES + 500 }, (_, i) => `line ${i}`).join('\n') + '\n');
  await writeFile(join(dir, 'wide.txt'), 'x'.repeat(DIFF_LINE_CHARS * 3) + '\n');
  const diff = await worktreeDiff(dir, base), big = diff.files.find(f => f.path === 'big.txt');
  expect(big?.lines).toHaveLength(DIFF_FILE_LINES); expect(big?.cut).toBe(true); expect(big?.added).toBe(DIFF_FILE_LINES + 500);
  expect(diff.files.find(f => f.path === 'wide.txt')?.lines[0]?.length).toBe(DIFF_LINE_CHARS + 1);
  expect(diff.capped).toBe(true);
});

it('git options in the repo can\'t run commands: no external diff, no textconv, no hooks', async () => {
  const { temp, dir, base } = await repo();
  const marker = join(temp, 'ran');
  await git(dir, 'config', 'diff.external', `/usr/bin/touch ${marker}`); await git(dir, 'config', 'diff.x.textconv', `/usr/bin/touch ${marker}`);
  await writeFile(join(dir, '.gitattributes'), '*.ts diff=x\n'); await writeFile(join(dir, 'src', 'a.ts'), 'changed\n');
  await worktreeDiff(dir, base);
  await expect(import('node:fs/promises').then(fs => fs.access(marker))).rejects.toThrow();
});

it('diffLine keeps text only: no escapes or controls, tabs as spaces, cut with an ellipsis', () => {
  expect(diffLine('+a\tb\x1b[31mred\x1b[0m‮\x07')).toBe('+a    bred');
  expect(diffLine('+' + 'y'.repeat(DIFF_LINE_CHARS + 10))).toHaveLength(DIFF_LINE_CHARS + 1);
});

it('the daemon diffs an agent\'s own worktree against its recorded start; an agent with no worktree is refused', async () => {
  const { temp, dir } = await repo();
  const home = join(temp, 'home'); await mkdir(home, { mode: 0o700 });
  const paths = getPaths(home); await preparePaths(paths);
  const m = new SessionManager(paths, new Logger(paths.log)); managers.push(m); await m.load();
  const agent = await m.create({ engine: 'codex', model: 'gpt-test', auth: { kind: 'account' }, cwd: dir, permission: 'ask', title: 'fixer' });
  expect(agent.worktree).toBeTruthy();
  await writeFile(join(agent.worktree ?? '', 'added.ts'), 'export const x = 1;\n');
  const diff = await m.diff(agent.id);
  expect(diff).toMatchObject({ title: 'fixer', branch: 'ai/fixer', files: [{ path: 'added.ts', status: 'untracked', added: 1 }] });
  expect(diff.base).toMatch(/^(master|main) @ [0-9a-f]{7}$/);
  const shell = await m.create({ cwd: dir });
  await expect(m.diff(shell.id)).rejects.toThrow('This agent has no worktree to diff');
  await expect(validateRequest({ id: randomUUID(), kind: 'sessions.diff', sessionId: 'nope' })).rejects.toThrow();
});

const sample: AgentDiff = { title: 'fixer', branch: 'ai/fixer', base: 'main @ abc1234', added: 3, removed: 1, capped: false, files: [
  { path: 'src/a.ts', status: 'modified', added: 2, removed: 1, lines: ['@@ -1,3 +1,4 @@', ' one', '-two', '+TWO', '+four'] },
  { path: 'new.md', status: 'untracked', added: 1, removed: 0, lines: ['+# hi'] },
] };

it('the popup lists files left and the unified diff right; ↑↓ files, PgUp/PgDn scroll, Esc closes; m and x hand off', () => {
  const theme = createTheme('graphite'), calls: string[] = [];
  const view = new DiffView(validateAgentDiff(sample), { changed: () => calls.push('changed'), close: () => calls.push('close'), merge: () => calls.push('merge'), discard: () => calls.push('discard') });
  const text = () => plainText(view.draw(new Grid(120, 40, theme).cells, theme));
  expect(text()).toContain('Diff fixer · ai/fixer vs main @ abc1234 · 2 files +3 −1');
  expect(text()).toContain('› M src/a.ts +2 −1'); expect(text()).toContain('+TWO'); expect(text()).toContain('m merges · x discards · Esc closes');
  view.key('down'); expect(text()).toContain('› U new.md +1'); expect(text()).toContain('+# hi'); expect(text()).not.toContain('+TWO');
  view.key('m'); view.key('x'); view.key('escape');
  expect(calls).toEqual(expect.arrayContaining(['merge', 'discard', 'close']));
});

it('a diff from the daemon is validated: text cells only, bounded', () => {
  expect(() => validateAgentDiff({ ...sample, files: [{ ...sample.files[0], lines: ['\x1b[2Jboom'] }] })).toThrow('Invalid diff');
  expect(() => validateAgentDiff({ ...sample, files: [{ ...sample.files[0], path: '../x\nevil' }] })).toThrow('Invalid diff');
  expect(() => validateAgentDiff({ ...sample, extra: 1 })).toThrow('Invalid diff');
});

it('a finished agent with changes says +N −M · ready to review on its card', () => {
  const now = new Date().toISOString();
  const done: SessionInfo = { id: randomUUID(), title: 'fixer', engine: 'codex', model: 'gpt', auth: { kind: 'account' }, cwd: '/tmp', worktree: '/tmp/w', branch: 'ai/fixer', permission: 'ask', status: 'done', statusDetail: 'done', statusSince: now, createdAt: now, lastOutputAt: now, exitCode: null, ctxPercent: null, lastActivity: null, diffStat: { added: 40, removed: 22, files: 3 } };
  expect(cardText(done, Date.now(), 60).line3).toContain('+40 −22 · ready to review');
  expect(cardText({ ...done, diffStat: { added: 0, removed: 0, files: 0 } }, Date.now(), 60).line3).toContain('no changes · ready to review');
});

it('HIGH (found while reviewing): a clean filter named in .gitattributes and the repo config never runs during a diff', async () => {
  const { temp, dir, base } = await repo();
  const marker = join(temp, 'filter-ran');
  await writeFile(join(dir, '.gitattributes'), '*.ts filter=evil\n*.md filter=evil\n');
  await git(dir, 'config', 'filter.evil.clean', `/usr/bin/touch ${marker}; /bin/cat`); await git(dir, 'config', 'filter.evil.smudge', `/usr/bin/touch ${marker}; /bin/cat`);
  await writeFile(join(dir, 'src', 'a.ts'), 'changed by the agent\n'); await writeFile(join(dir, 'new.md'), 'new\n');
  const { worktreeStat } = await import('../src/daemon/diff.js');
  await worktreeDiff(dir, base); await worktreeStat(dir, base);
  await expect(import('node:fs/promises').then(fs => fs.access(marker))).rejects.toThrow();
});

// ---- Part C review findings (fresh typescript-reviewer and security-reviewer) ----
it('HIGH (security review): no filter runs even when named from .git/info/attributes or core.attributesFile', async () => {
  const { temp, dir, base } = await repo();
  const marker = join(temp, 'ran2');
  await mkdir(join(dir, '.git', 'info'), { recursive: true });
  await writeFile(join(dir, '.git', 'info', 'attributes'), '*.ts filter=evil2\n');
  await writeFile(join(temp, 'attrs'), '*.md filter=evil2\n'); await git(dir, 'config', 'core.attributesFile', join(temp, 'attrs'));
  await git(dir, 'config', 'filter.evil2.clean', `/usr/bin/touch ${marker}; /bin/cat`); await git(dir, 'config', 'filter.evil2.process', `/usr/bin/touch ${marker}`); await git(dir, 'config', 'filter.evil2.required', 'true');
  await writeFile(join(dir, 'src', 'a.ts'), 'changed\n'); await writeFile(join(dir, 'x.md'), 'new\n');
  const { worktreeStat } = await import('../src/daemon/diff.js');
  const diff = await worktreeDiff(dir, base); await worktreeStat(dir, base);
  expect(diff.files.find(f => f.path === 'src/a.ts')?.lines).toContain('+changed');
  await expect(import('node:fs/promises').then(fs => fs.access(marker))).rejects.toThrow();
});

it('HIGH (TS review): a file that became a symlink keeps every file\'s diff with its own file', async () => {
  const { dir, base } = await repo();
  await writeFile(join(dir, 'b.txt'), 'b\n'); await git(dir, 'add', '--', 'b.txt'); await git(dir, 'commit', '-m', 'b', '--');
  const head = (await git(dir, 'rev-parse', 'HEAD')).stdout.trim();
  await rm(join(dir, 'gone.txt')); await symlink('b.txt', join(dir, 'gone.txt'));
  await writeFile(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree\nAFTER\n');
  const diff = await worktreeDiff(dir, head);
  expect(diff.files.map(f => f.path)).toEqual(['gone.txt', 'src/a.ts']);
  expect(diff.files.find(f => f.path === 'src/a.ts')?.lines).toEqual(expect.arrayContaining(['+AFTER']));
  expect(diff.files.find(f => f.path === 'src/a.ts')?.lines.join('\n')).not.toContain('bye');
  expect(diff.files.find(f => f.path === 'gone.txt')?.lines).toEqual(expect.arrayContaining(['-bye', '+b.txt']));
  void base;
});

it.skipIf(AS_ROOT)('MEDIUM (TS review): an unreadable untracked file or an unprintable name doesn\'t break the diff (skipped as root: file modes do not stop root)', async () => {
  const { dir, base } = await repo();
  await writeFile(join(dir, 'locked.txt'), 'secret\n', { mode: 0o000 });
  await writeFile(join(dir, '​'), 'zero width name\n');
  const diff = await worktreeDiff(dir, base);
  expect(diff.files.find(f => f.path === 'locked.txt')?.lines).toEqual(['+(unreadable: no permission)']);
  expect(diff.files.map(f => f.path)).toContain('(unprintable name)');
  expect(() => validateAgentDiff({ title: 't', branch: 'ai/t', base: 'b', ...diff })).not.toThrow();
});

it('MEDIUM (both reviews): untracked files past the file cap are never read, and the answer fits one frame', async () => {
  const { dir, base } = await repo();
  const long = 'd'.repeat(200);
  await mkdir(join(dir, long), { recursive: true });
  for (let i = 0; i < 620; i++) await writeFile(join(dir, long, `${'f'.repeat(40)}-${i}.txt`), 'x\n'.repeat(50));
  const diff = await worktreeDiff(dir, base);
  expect(diff.files.length).toBeLessThanOrEqual(500); expect(diff.capped).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(diff))).toBeLessThan(2 * 1024 * 1024);
}, 30_000);

it('HIGH (fix review): the diff never reads the repo\'s config at all, so swapping it mid-diff can\'t add a filter', async () => {
  const { temp, dir, base } = await repo();
  // A config that includes a FIFO hangs any git that reads it; a diff that finishes never read it.
  const fifo = join(temp, 'hang'); await run('/usr/bin/mkfifo', [fifo]);
  await git(dir, 'config', 'include.path', fifo);
  await writeFile(join(dir, '.gitattributes'), '* filter=evil\n'); await writeFile(join(dir, 'src', 'a.ts'), 'changed\n');
  const { worktreeStat } = await import('../src/daemon/diff.js');
  const started = Date.now(), diff = await worktreeDiff(dir, base), stat = await worktreeStat(dir, base);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(diff.files.find(f => f.path === 'src/a.ts')?.lines).toContain('+changed'); expect(stat.files).toBeGreaterThan(0);
}, 30_000);


it('MEDIUM (second fix review): a repo with a split index still diffs', async () => {
  const { dir, base } = await repo();
  await git(dir, 'update-index', '--split-index'); await writeFile(join(dir, 'src', 'a.ts'), 'split\n');
  const diff = await worktreeDiff(dir, base);
  expect(diff.files.find(f => f.path === 'src/a.ts')?.lines).toContain('+split');
});

it('MEDIUM (second fix review): an index entry that leads outside the worktree refuses the diff, nothing outside is shown', async () => {
  const { temp, dir, base } = await repo();
  await writeFile(join(temp, 'secret.txt'), 'OUTSIDE SECRET\n');
  // The agent can write its own index: an entry named ../secret.txt (git itself never adds one).
  const blob = (await run('/usr/bin/git', ['hash-object', '-w', '--', join(temp, 'secret.txt')], { cwd: dir })).stdout.trim();
  const crafted = await craftIndex(dir, blob);
  await import('node:fs/promises').then(fs => fs.writeFile(join(dir, '.git', 'index'), crafted));
  await expect(worktreeDiff(dir, base)).rejects.toThrow();
  const { worktreeStat } = await import('../src/daemon/diff.js');
  await expect(worktreeStat(dir, base)).rejects.toThrow();
});
// An index with one entry whose name is ../secret.txt: written by git's own plumbing into a scratch index with a safe
// name of the same length, then the name bytes are swapped and the trailing checksum recomputed.
async function craftIndex(dir: string, blob: string): Promise<Buffer> {
  const scratch = join(dir, '.git', 'scratch-index'), name = '../secret.txt', stand = 'x'.repeat(name.length);
  await run('/usr/bin/git', ['update-index', '--add', '--cacheinfo', `100644,${blob},${stand}`], { cwd: dir, env: { ...process.env, GIT_INDEX_FILE: scratch } });
  const fs = await import('node:fs/promises'), { createHash } = await import('node:crypto');
  const bytes = await fs.readFile(scratch), at = bytes.indexOf(Buffer.from(stand));
  Buffer.from(name).copy(bytes, at);
  createHash('sha1').update(bytes.subarray(0, bytes.length - 20)).digest().copy(bytes, bytes.length - 20);
  await fs.rm(scratch);
  return bytes;
}

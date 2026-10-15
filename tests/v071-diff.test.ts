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
  expect(text()).toContain('› M src/a.ts +2 −1'); expect(text()).toContain('+TWO'); expect(text()).toContain('m merge · x discard · Esc later');
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

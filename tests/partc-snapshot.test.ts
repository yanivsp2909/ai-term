import { afterEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error -- a plain .mjs build script with no type declarations
import { build, commit, keepable, markers, permissive } from '../scripts/public-snapshot.mjs';

// Part C review: the public snapshot script. A tree with a personal marker, an unfilled verification or a link never
// becomes a commit, and the commit never takes anything from this machine's git setup.
const run = promisify(execFile);
const cleanups: string[] = [];
afterEach(async () => { for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true }); });
async function folder() { const dir = await mkdtemp(join(tmpdir(), 'ai-partc-snap-')); cleanups.push(dir); return dir; }
const SNAPSHOT = `# Public source snapshot\n\nFrom private \`main\` at commit \`${'a'.repeat(40)}\`.\n\n## Verification\n\nnpm test: 2 passed.\n`;
async function tree(extra: Record<string, string> = {}) {
  const out = join(await folder(), 'out'); await mkdir(join(out, 'docs'), { recursive: true });
  for (const [path, text] of Object.entries({ 'PUBLIC_SNAPSHOT.md': SNAPSHOT, 'README.md': '# x\n', 'docs/a.md': 'a\n', 'src.ts': 'export {};\n', ...extra })) await writeFile(join(out, path), text);
  return out;
}
const words = (...parts: string[]) => parts.join('');

describe('the license check', () => {
  it('security LOW: reads only the header License line, and only a plain permissive one', () => {
    const copy = (license: string, body = '') => `---\nname: x\ndescription: y\n---\nSource: s.\nLicense: ${license}\nWhat changed: c.\n\n${body}`;
    for (const license of ['MIT.', 'Apache 2.0 (stated in the source).', 'Apache-2.0', 'BSD-3-Clause.']) expect(permissive(copy(license)), license).toBe(true);
    for (const license of ['not stated in the source definition; no redistribution grant inferred.', 'MIT for one part, the other source states none.', 'the source states none; a second source is Apache 2.0.'])
      expect(permissive(copy(license)), license).toBe(false);
    expect(permissive(copy('not stated.', 'License: MIT\n'))).toBe(false);
  });
});

describe('the marker check', () => {
  it('security LOW: any letter case, /home and C:\\Users paths, file names, and files it can\'t read as text', async () => {
    const out = await tree({
      'a.md': `mail ${words('G', 'mail.COM')}\n`, 'b.md': `user ${words('YANIV', 'SP')}\n`, 'c.ts': `const p = '/home/${words('real', 'person')}/x';\n`,
      'd.ts': `const p = 'C:\\\\Users\\\\${words('Real', 'Person')}\\\\x';\n`, 'e.bin': 'a\u0000b', [`${words('yaniv', 'sp')}-notes.md`]: 'fine\n',
      'ok.ts': "const fakes = ['/home/me', '/home/u', 'C:\\\\Users\\\\me', 'yanivsp2909'];\n",
    });
    const found: string[] = await markers(out);
    for (const file of ['a.md:1', 'b.md:1', 'c.ts:1', 'd.ts:1', 'e.bin']) expect(found.some(line => line.startsWith(file)), file).toBe(true);
    expect(found.some(line => line.includes('-notes.md') && line.includes('name'))).toBe(true);
    expect(found.some(line => line.startsWith('ok.ts'))).toBe(false);
  });
});

describe('the commit', () => {
  it('security MEDIUM: refuses a tree with a personal marker, a link or an unfilled verification, and commits nothing', async () => {
    const marked = await tree({ 'x.md': `${words('narvis', '-resource')}\n` });
    await expect(commit(marked, { PATH: process.env.PATH })).rejects.toThrow(/personal markers/i);
    const linked = await tree(); await symlink('/etc/hosts', join(linked, 'docs', 'hosts'));
    await expect(commit(linked, { PATH: process.env.PATH })).rejects.toThrow(/link/i);
    const unverified = await tree({ 'PUBLIC_SNAPSHOT.md': SNAPSHOT.replace('npm test: 2 passed.', 'Not verified yet: run the checks below, then record their last lines here before the commit.') });
    await expect(commit(unverified, { PATH: process.env.PATH })).rejects.toThrow(/not verified/i);
    for (const out of [marked, linked, unverified]) await expect(readFile(join(out, '.git', 'HEAD'), 'utf8')).rejects.toThrow();
  });

  it('security MEDIUM: nothing of this machine\'s git setup reaches it (ignore file, GIT_DIR, hooks, time zone)', async () => {
    const out = await tree(), home = await folder(), other = join(await folder(), 'other');
    await mkdir(join(home, 'git'), { recursive: true }); await writeFile(join(home, 'git', 'ignore'), '*.md\n');
    await run('git', ['init', '-q', '--', other]);
    const hooks = join(home, 'hooks'); await mkdir(hooks); await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\ntouch "$0.ran"\n', { mode: 0o755 });
    await commit(out, { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.hooksPath', GIT_CONFIG_VALUE_0: hooks, TZ: 'Asia/Tokyo' });
    const files = (await run('git', ['-C', out, 'ls-files'], { env: { PATH: process.env.PATH } })).stdout.trim().split('\n').sort();
    expect(files).toEqual(['PUBLIC_SNAPSHOT.md', 'README.md', 'docs/a.md', 'src.ts']);
    expect((await run('git', ['-C', out, 'log', '-1', '--format=%an <%ae> %ai'], { env: { PATH: process.env.PATH } })).stdout).toMatch(/^Yaniv <77485644\+yanivsp2909@users\.noreply\.github\.com> .* \+0000\n$/);
    await expect(readFile(join(hooks, 'pre-commit.ran'))).rejects.toThrow();
    await expect(run('git', ['-C', other, 'rev-parse', '--verify', 'HEAD'], { env: { PATH: process.env.PATH } })).rejects.toThrow();
  });
});

describe('the packaging review', () => {
  it('MEDIUM: a guide is kept only when its header names a public upstream, so its attribution can be complete', () => {
    const copy = (source: string) => `---\nname: x\ndescription: y\n---\nSource: ${source}\nLicense: Apache 2.0 (stated in the source).\nWhat changed: c.\n`;
    expect(keepable(copy('~/.claude/skills/impeccable/SKILL.md (2026-10-18), its modes.'))).toBe(false);
    expect(keepable(copy('https://github.com/example/skills/blob/0123abc/x/SKILL.md (Copyright 2025 Example).'))).toBe(true);
    expect(keepable(copy('https://github.com/example/skills').replace('Apache 2.0 (stated in the source).', 'not stated.'))).toBe(false);
  });

  it('MEDIUM/LOW: the built tree has the public clone URL, no private links, and lists only what it left out', async () => {
    const out = join(await folder(), 'snapshot');
    await build(out, 'HEAD');
    const readme = await readFile(join(out, 'README.md'), 'utf8'), snapshot = await readFile(join(out, 'PUBLIC_SNAPSHOT.md'), 'utf8');
    expect(readme).toContain('git clone https://github.com/yanivsp2909/ai-term-public.git ai-term'); expect(readme).not.toContain('<this repository>');
    expect(await readFile(join(out, 'docs', 'design.md'), 'utf8')).not.toContain('claude.ai/artifact');
    expect(snapshot).not.toContain('`.codex`'); expect(snapshot).toContain('`docs/addons/inventory.md`');
    // v1.2: the add-on guides are AI Term's own (MIT), so the snapshot ships every one of them.
    expect((await readdir(join(out, 'addons', 'guides'))).filter(f => f.endsWith('.md'))).toHaveLength(35);
    await expect(readdir(join(out, 'addons', '_shared'))).rejects.toThrow();
    await expect(readFile(join(out, 'licenses', 'Apache-2.0.txt'))).rejects.toThrow();
    expect(snapshot).toContain('addons/guides/');
  }, 60_000);
});

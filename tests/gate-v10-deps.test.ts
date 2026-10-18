import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsQueries } from '../src/daemon/deps-query.js';

// v1.0 gate (code review, MEDIUM): /deps queries a temp folder with copies of the manifests only, so pip listed this
// Mac's own packages, npm reported nothing installed as outdated, and cargo couldn't parse a manifest without a target.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function tool(bin: string, name: string, body: string) { const path = join(bin, name); await writeFile(path, `#!/bin/sh\necho "$*" >> '${bin}/${name}.calls'\n${body}\n`); await chmod(path, 0o755); }
async function setup(files: Record<string, string>) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate10-deps-'))); roots.push(dir);
  const bin = join(dir, 'bin'), project = join(dir, 'p'); await mkdir(bin); await mkdir(project);
  for (const [name, text] of Object.entries(files)) await writeFile(join(project, name), text);
  return { dir, bin, project, calls: async (name: string) => (await readFile(join(bin, `${name}.calls`), 'utf8').catch(() => '')).trim() };
}

it('pip is never asked about this Mac\'s own packages; the facts say the agent reads the pins itself', async () => {
  const { dir, bin, project, calls } = await setup({ 'requirements.txt': 'requests==2.0\n' });
  await tool(bin, 'python3', `echo '[{"name":"setuptools","version":"60.0","latest_version":"80.0"}]'`);
  const result = await depsQueries(project, { path: bin, env: { PATH: bin, HOME: dir } });
  expect(await calls('python3')).toBe('');
  expect(result.facts).toEqual(["pip: no read-only query knows this project's installed versions; the agent compares the pins itself"]);
  expect(result.data).not.toContain('setuptools');
});

it('npm says which dependencies the copy has no installed version for, instead of calling them outdated', async () => {
  const { dir, bin, project } = await setup({ 'package.json': '{"dependencies":{"left-pad":"^1.0.0","a":"^1.0.0"}}' });
  await tool(bin, 'npm', `case "$1" in outdated) echo '{"left-pad":{"wanted":"1.3.0","latest":"1.3.0"},"a":{"current":"1.0.0","wanted":"1.0.0","latest":"2.0.0"}}'; exit 1;; audit) echo '{"vulnerabilities":{},"metadata":{"vulnerabilities":{}}}'; exit 0;; esac`);
  const result = await depsQueries(project, { path: bin, env: { PATH: bin, HOME: dir } });
  expect(result.facts).toEqual(['npm: 1 outdated · 1 with no installed version in AI Term\'s copy · audit: nothing found']);
  expect(result.data).toContain('a 1.0.0 → 2.0.0');
  expect(result.data).toContain('left-pad: no installed version in the copy · latest 1.3.0');
});

it('cargo outdated gets a manifest it can parse: the copy has an empty library target', async () => {
  const { dir, bin, project } = await setup({ 'Cargo.toml': '[package]\nname = "x"\nversion = "0.1.0"\n[dependencies]\nserde = "1.0"\n' });
  await tool(bin, 'cargo-outdated', 'exit 0');
  await tool(bin, 'cargo', `[ -f src/lib.rs ] || { echo 'error: no targets specified in the manifest' >&2; exit 101; }; echo '{"dependencies":[{"name":"serde","project":"1.0.0","latest":"1.0.200"}]}'`);
  const result = await depsQueries(project, { path: bin, env: { PATH: bin, HOME: dir } });
  expect(result.facts).toEqual(['cargo: 1 outdated']);
});

it('LOW (code review): a staged file named like a glob can\'t pull a left-out credential file into /commit\'s data', async () => {
  const { execFile } = await import('node:child_process'), { promisify } = await import('node:util'), run = promisify(execFile);
  const { stagedChanges } = await import('../src/daemon/addon-gather.js');
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate10-commit-'))); roots.push(dir);
  const git = (...args: string[]) => run('/usr/bin/git', ['-c', 'user.name=T', '-c', 'user.email=t@e.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir });
  await git('init', '-q', '-b', 'main'); await writeFile(join(dir, 'README.md'), 'x\n'); await git('add', '--', 'README.md'); await git('commit', '-qm', 'first');
  await writeFile(join(dir, '.env'), 'PLAIN_VALUE_NOT_FLAGGED=hello-world-123\n'); await writeFile(join(dir, '*'), 'glob\n');
  await git('add', '--', '.env', '*');
  const staged = await stagedChanges(dir);
  expect(staged.data).toContain('glob');
  expect(staged.data).not.toContain('hello-world-123');
});

import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { depsQueries } from '../src/daemon/deps-query.js';

// v1.1 batch 2 review findings (TypeScript and security reviewers), each reproduced before its fix.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-b2-review-'))); roots.push(dir); return dir; }
// A stand-in tool that records where it ran, what it saw there, its argv and the env names it got.
async function tool(bin: string, log: string, name: string, answer: string) {
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, name), `#!/bin/sh\n{ echo "cwd=$(pwd)"; echo "files=$(ls -A | tr '\\n' ' ')"; echo "argv=$*"; env | cut -d= -f1 | sort | tr '\\n' ' '; echo; env | grep -E '^(GOTOOLCHAIN|GOFLAGS|GOWORK|npm_config_ignore_scripts|npm_config_update_notifier|CARGO_BUILD_RUSTC_WRAPPER)='; } >> ${log}\n${answer}\n`);
  await chmod(join(bin, name), 0o755);
}

it('HIGH (both reviews): /deps queries run in a fresh folder holding only manifests and lockfiles, never the repository, with config that can run code switched off', async () => {
  const dir = await temp(), repo = join(dir, 'repo'), bin = join(dir, 'bin'), log = join(dir, 'log'); await mkdir(join(repo, 'pip'), { recursive: true });
  await writeFile(join(repo, 'package.json'), '{}'); await writeFile(join(repo, 'package-lock.json'), '{}'); await writeFile(join(repo, '.npmrc'), 'onload-script=./evil.js\n');
  await writeFile(join(repo, 'go.mod'), 'module x\n\ntoolchain go1.99.0\n'); await writeFile(join(repo, 'requirements.txt'), 'requests\n'); await writeFile(join(repo, 'pip', '__main__.py'), 'print("repo code ran")\n');
  await tool(bin, log, 'npm', 'echo "{}"'); await tool(bin, log, 'go', 'true'); await tool(bin, log, 'python3', 'echo "[]"');
  await depsQueries(repo, { path: bin, env: { PATH: bin, HOME: dir } });
  const text = await readFile(log, 'utf8');
  expect(text).not.toContain(`cwd=${repo}\n`);
  expect(text).not.toMatch(/files=[^\n]*(\.npmrc|pip )/);
  expect(text).toMatch(/files=[^\n]*package-lock\.json/);
  expect(text).toContain('argv=-I -m pip list --outdated --format=json --disable-pip-version-check --no-input');
  for (const pinned of ['GOTOOLCHAIN=local', 'GOFLAGS=-mod=readonly', 'GOWORK=off', 'npm_config_ignore_scripts=true', 'npm_config_update_notifier=false']) expect(text).toContain(pinned);
});

it('MEDIUM (TS review): an audit that answered with an error is said as incomplete, never as nothing found', async () => {
  const dir = await temp(), repo = join(dir, 'repo'), bin = join(dir, 'bin'); await mkdir(repo); await writeFile(join(repo, 'package.json'), '{}');
  await tool(bin, join(dir, 'log'), 'npm', `case "$1" in outdated) echo '{}';; audit) echo '{"error":{"code":"ENOTFOUND","summary":"offline"}}'; exit 1;; esac`);
  const result = await depsQueries(repo, { path: bin, env: { PATH: bin, HOME: dir } });
  expect(result.facts.join('\n')).toContain('npm: a query failed');
  expect(result.facts.join('\n')).not.toContain('nothing found');
});

it('LOW (TS review): /deps [path] queries that folder\'s manifests, and long results are cut to fit the first message', async () => {
  const dir = await temp(), repo = join(dir, 'repo'), bin = join(dir, 'bin'), log = join(dir, 'log'); await mkdir(join(repo, 'packages', 'api'), { recursive: true });
  await writeFile(join(repo, 'packages', 'api', 'package.json'), '{"name":"api"}');
  const many = Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`package-with-a-long-name-${i}`, { current: '1.0.0', wanted: '1.0.1', latest: '2.0.0' }]));
  await tool(bin, log, 'npm', `case "$1" in outdated) echo '${JSON.stringify(many)}';; audit) echo '{}';; esac`);
  const result = await depsQueries(join(repo, 'packages', 'api'), { path: bin, env: { PATH: bin, HOME: dir } });
  expect(await readFile(log, 'utf8')).toMatch(/files=[^\n]*package\.json/);
  expect(Buffer.byteLength(JSON.stringify(result.data))).toBeLessThanOrEqual(9000);
});

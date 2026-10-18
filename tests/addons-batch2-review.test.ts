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
  await writeFile(join(bin, name), `#!/bin/sh\n{ echo "cwd=$(pwd)"; echo "files=$(/bin/ls -A | /usr/bin/tr '\\n' ' ')"; echo "argv=$*"; /usr/bin/env | /usr/bin/grep -E '^(GOTOOLCHAIN|GOFLAGS|GOWORK|npm_config_ignore_scripts|npm_config_update_notifier|CARGO_BUILD_RUSTC_WRAPPER)='; } >> ${log}\n${answer}\n`);
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

it('HIGH (TS review): /context never reads a credential or env file an @import names, and never fails on a large or odd one', async () => {
  const { contextFiles } = await import('../src/daemon/addon-gather.js');
  const dir = await temp(), repo = join(dir, 'repo'); await mkdir(join(repo, 'config'), { recursive: true });
  await writeFile(join(repo, '.env'), 'DB_PASSWORD=hunter2\n'); await writeFile(join(repo, 'config', 'secrets.json'), '{"pw":"hunter3"}\n');
  await writeFile(join(repo, 'AGENTS.md'), `# Rules\n@.env\n@config/secrets.json\n@${'x'.repeat(400)}\n@bad\u001b[31mname\n`);
  await writeFile(join(repo, 'CLAUDE.md'), 'y'.repeat(70 * 1024));
  const found = await contextFiles(repo);
  expect(found.data).not.toContain('hunter2'); expect(found.data).not.toContain('hunter3');
  expect(found.facts).toEqual(expect.arrayContaining(['skipped: .env (a file that usually holds secrets)', 'skipped: config/secrets.json (a file that usually holds secrets)', 'skipped: CLAUDE.md (over 64 KB)']));
  expect(found.facts.every(fact => fact.length <= 200 && !/[\p{C}]/u.test(fact))).toBe(true);
  // LOW (security review): repository text reaches the model quoted, like GitHub's.
  expect(found.data.split('\n').filter(Boolean).every(line => line.startsWith('> '))).toBe(true);
});

it('LOW (TS review): /context and /opensource take no argument instead of quietly ignoring one', async () => {
  const { AddonService } = await import('../src/daemon/addons.js');
  const dir = await temp(), service = new AddonService(join(dir, 'home'), new URL('../addons/', import.meta.url).pathname, { create: async () => { throw new Error('no'); }, text: async () => { throw new Error('no'); }, brainPlan: async () => null, addonGather: async () => ({ data: 'd', subject: 's', facts: [] }) });
  const codex = { engine: 'codex' as const, model: null, auth: { kind: 'account' as const } };
  await expect(service.plan('context', 'src', dir, codex)).rejects.toThrow('/context takes no argument');
  await expect(service.plan('opensource', 'src', dir, codex)).rejects.toThrow('/opensource takes no argument');
  await expect(service.plan('context', '', dir, codex)).resolves.toMatchObject({ name: 'context' });
});

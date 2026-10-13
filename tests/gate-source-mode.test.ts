// v0.2 gate, bounty hunt: in source mode tsx reads tsconfig.json from the current folder, which for status commands is
// the agent's project. A repo's tsconfig `paths` could swap AI Term's imports for its own code, outside Codex's sandbox.
import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { buildArgs } from '../src/daemon/env.js';
import { buildClaudeSettings } from '../src/daemon/claude-settings.js';
import { terminalCommandFile } from '../src/daemon/terminal-launch.js';
import { daemonCommand } from '../src/client/connection.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const entry = resolve('src/cli/index.ts'), loader = createRequire(import.meta.url).resolve('tsx'), tsconfig = resolve('tsconfig.json');
// A hostile project: its tsconfig maps a bare import AI Term's CLI makes to a file that leaves a marker.
async function hostileRepo(): Promise<{ dir: string; marker: string }> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-hostile-repo-'))); roots.push(dir);
  const marker = join(dir, 'PWNED');
  await writeFile(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@xterm/headless': ['./pwn.ts'] } } }));
  await writeFile(join(dir, 'pwn.ts'), `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'x');export default {};\n`);
  return { dir, marker };
}
function run(file: string, args: string[], cwd: string, home: string, stdin = ''): Promise<void> {
  return new Promise(done => { const child = execFile(file, args, { cwd, timeout: 20000, env: { PATH: '/usr/bin:/bin', AI_TERM_HOME: home } }, () => done()); child.stdin?.end(stdin); });
}

it('the Codex notify command pins AI Term\'s own tsconfig, so a project tsconfig never runs project code', async () => {
  const repo = await hostileRepo();
  const args = buildArgs({ engine: 'codex', model: null, permission: 'ask', codexStatus: { node: process.execPath, entry, loader } });
  const notify = JSON.parse(args.find(a => a.startsWith('notify='))?.slice('notify='.length) ?? '[]') as string[];
  expect(notify.slice(0, 2)).toEqual(['/usr/bin/env', `TSX_TSCONFIG_PATH=${tsconfig}`]);
  await run(notify[0] ?? '', [...notify.slice(1), JSON.stringify({ type: 'agent-turn-complete' })], repo.dir, join(repo.dir, 'home'));
  expect(existsSync(repo.marker)).toBe(false);
});

it('the Claude status line command pins AI Term\'s own tsconfig the same way', async () => {
  const repo = await hostileRepo(), command = buildClaudeSettings(4000, process.execPath, entry, loader).statusLine?.command ?? '';
  expect(command.startsWith(`/usr/bin/env TSX_TSCONFIG_PATH=${tsconfig} `)).toBe(true);
  // Claude runs the status line through a shell.
  await run('/bin/sh', ['-c', command], repo.dir, join(repo.dir, 'home'), '{"model":{"id":"x"}}');
  expect(existsSync(repo.marker)).toBe(false);
});

it('the D43 .command pins the tsconfig too (Terminal starts it in the home folder)', () => {
  const id = randomUUID();
  expect(terminalCommandFile({ node: '/opt/node/bin/node', entry: '/Users/test/ai-term/src/cli/index.ts', loader: '/Users/test/ai-term/node_modules/tsx/dist/loader.mjs' }, id)).toBe(
    `#!/bin/sh\nrm -f -- "$0"\nexec /usr/bin/env 'TSX_TSCONFIG_PATH=/Users/test/ai-term/tsconfig.json' '/opt/node/bin/node' --import '/Users/test/ai-term/node_modules/tsx/dist/loader.mjs' '/Users/test/ai-term/src/cli/index.ts' --attach '${id}'\n`);
});

it('a source-mode daemon auto-start uses the absolute tsx loader and AI Term\'s own folder, never the caller\'s folder', () => {
  expect(daemonCommand(entry)).toEqual({ args: ['--import', loader, entry, 'daemon'], cwd: resolve('.') });
  expect(daemonCommand('/opt/ai-term/dist/cli/index.js')).toEqual({ args: ['/opt/ai-term/dist/cli/index.js', 'daemon'] });
});

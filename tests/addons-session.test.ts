import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, realpath, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import pty from 'node-pty';
import { SessionManager } from '../src/daemon/session-manager.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Logger } from '../src/daemon/log.js';
import { KeyStore } from '../src/daemon/keys.js';
import * as engines from '../src/daemon/engines.js';
import { withAddon } from '../src/agent/addon-bundle.js';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const f of cleanups.splice(0).reverse()) await f(); vi.restoreAllMocks(); });
const run = promisify(execFile);
it('the three pilots use normal Ask sessions and a real PTY stub; a saves and s alone starts an isolated step', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-addon-session-'))); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'repo'), home = join(root, 'home'); await mkdir(repo); await mkdir(home);
  await writeFile(join(repo, 'a.ts'), 'export const a = 1;');
  const git = ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false'];
  await run('/usr/bin/git', ['init', '-q', '-b', 'main', '--', repo]); await run('/usr/bin/git', [...git, 'add', '--', '.'], { cwd: repo }); await run('/usr/bin/git', [...git, 'commit', '-qm', 'initial', '--'], { cwd: repo });
  const paths = getPaths(home); await preparePaths(paths); const log = new Logger(paths.log);
  const vault = { read: async () => null, write: async () => {}, remove: async () => {} }, keys = new KeyStore(home, { vault });
  const manager = new SessionManager(paths, log, undefined, undefined, undefined, keys, undefined, new URL('../src/cli/index.ts', import.meta.url).pathname); await manager.load(); cleanups.push(() => manager.shutdown());
  vi.spyOn(engines, 'checkEngine').mockResolvedValue({ installed: true, path: process.execPath, loggedIn: true, version: 'stub', authMethod: 'subscription' });
  const spawn = pty.spawn, argv: string[][] = [];
  vi.spyOn(pty, 'spawn').mockImplementation((_file, args, options) => {
    argv.push([...args]); const prompt = args.at(-1) ?? '', nonce = prompt.match(/RESULT_([a-f0-9]{32})_BEGIN/)?.[1] ?? '';
    const result = prompt.includes('kind="plan"') ? { kind: 'plan', title: 'Update a', steps: [{ title: 'Update', prompt: 'Read a.ts, test and change a; verify and stop.' }] } : prompt.includes('kind="prompt"') ? { kind: 'prompt', issues: ['Missing stop condition'], diff: '--- original\n+++ improved\n@@ -1 +1 @@\n-build\n+Build and stop.' } : { kind: 'explain', why: 'a exposes one value.', diagram: ['a.ts -> importer'], chunks: [['One value.', 'Example: a.ts:1 exports a = 1.', 'You are here: a.ts.', 'Quick check: what is a?']], recap: ['a is exported.', 'It equals one.', 'Importers read a.'] };
    return spawn(process.execPath, ['-e', 'process.stdout.write("\\r\\nRESULT_"+process.argv[1]+"_BEGIN\\r\\n"+process.argv[2]+"\\r\\nRESULT_"+process.argv[1]+"_END\\r\\n")', nonce, JSON.stringify(result)], { ...options, env: { PATH: '/usr/bin:/bin', HOME: root } });
  });
  let planId = '';
  for (const name of ['plan', 'prompt', 'explain']) {
    const ask = await manager.addons.plan(name, 'trace a.ts', repo, { engine: 'codex', model: null, auth: { kind: 'account' } });
    const session = await manager.addons.start(ask.receipt); if (name === 'plan') planId = session.id;
    expect(session.permission).toBe('ask'); expect(session.worktree).toBeUndefined(); expect(argv.at(-1)).toContain('--sandbox=read-only');
    await vi.waitFor(async () => expect((await manager.addons.result(session.id))?.kind).toBe(name));
    const path = argv.at(-1)?.at(-1)?.match(/"([^"\n]+\/addons\/[a-f0-9]{64})\/[^"\n]+"/)?.[1];
    if (!path) throw new Error('No bundle path');
    const instructions = await withAddon({ text: '', files: [], notes: [] }, path); expect(instructions.text).toContain('Source:');
  }
  const saved = await manager.addons.approve(planId); expect(JSON.parse(await readFile(saved, 'utf8')).kind).toBe('plan'); expect(argv).toHaveLength(3);
  const step = await manager.addons.step(planId, 0); expect(step.worktree).toBeDefined(); expect(step.permission).toBe('ask'); expect(argv).toHaveLength(4);
});

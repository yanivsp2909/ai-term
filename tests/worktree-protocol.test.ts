import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { validateRequest, validateSuccess } from '../src/shared/validate.js';
const roots: string[] = [], cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); for (const root of roots.splice(0)) await rm(root, { recursive:true, force:true }); });
const id = randomUUID(), fingerprint = 'a'.repeat(64);
it('worktree requests take only a safe absolute path, a 64-hex fingerprint and an ai/ branch confirmation', async () => {
 await expect(validateRequest({ id, kind:'worktrees.list' })).resolves.toMatchObject({ kind:'worktrees.list' });
 await expect(validateRequest({ id, kind:'worktrees.check', path:'/tmp/tree' })).resolves.toMatchObject({ path:'/tmp/tree' });
 await expect(validateRequest({ id, kind:'worktrees.delete', path:'/tmp/tree', fingerprint, confirm:'ai/agent' })).resolves.toMatchObject({ confirm:'ai/agent' });
 for (const bad of [
  { kind:'worktrees.check', path:'relative/tree' }, { kind:'worktrees.check', path:'/tmp/../etc' }, { kind:'worktrees.check', path:'/tmp/a\nb' },
  { kind:'worktrees.delete', path:'/tmp/tree' }, { kind:'worktrees.delete', path:'/tmp/tree', fingerprint:'A'.repeat(64) },
  { kind:'worktrees.delete', path:'/tmp/tree', fingerprint, confirm:'main' }, { kind:'worktrees.delete', path:'/tmp/tree', fingerprint, confirm:'ai/-x' },
  { kind:'worktrees.delete', path:'/tmp/tree', fingerprint, force:true }, { kind:'worktrees.list', path:'/tmp/tree' },
 ]) await expect(validateRequest({ id, ...bad })).rejects.toThrow();
});
it('worktree views from the daemon are validated field by field', () => {
 const view = { path:'/tmp/tree', branch:'ai/agent', agent:{ id, title:'agent', status:'exited' }, loss:{ changed:1, untracked:2, ignored:0, commits:3, base:'main', baseSource:'recorded', missing:false }, fingerprint };
 expect(validateSuccess({ id, ok:true, worktrees:[view, { path:'/tmp/other', refusal:"Not in AI Term's record" }] }).worktrees).toHaveLength(2);
 for (const bad of [{ ...view, refusal:'anything else' }, { ...view, extra:1 }, { ...view, loss:{ ...view.loss, changed:-1 } }, { ...view, loss:{ ...view.loss, base:'main)%(x' } }, { ...view, agent:{ ...view.agent, pid:1 } }, { ...view, path:'tree' }])
  expect(() => validateSuccess({ id, ok:true, worktree:bad })).toThrow();
 expect(() => validateSuccess({ id, ok:true, deletedWorktree:'relative' })).toThrow();
});
it('the daemon answers worktree requests with fixed texts and never acts on an unrecorded path', async () => {
 const root = await mkdtemp(join(tmpdir(), 'ai-term-trees-')); roots.push(root);
 const paths = getPaths(root); await preparePaths(paths);
 const manager = new SessionManager(paths, new Logger(paths.log)); await manager.load();
 const server = new DaemonServer(paths, manager, new Logger(paths.log)); await server.listen();
 const client = await Connection.connect(paths, { entry:resolve('src/cli/index.ts'), autoStart:false });
 cleanup.push(async () => { client.close(); await server.close(); await manager.shutdown(); });
 expect((await client.request({ kind:'worktrees.list' })).worktrees).toEqual([]);
 expect((await client.request({ kind:'worktrees.check', path:'/tmp/not-ours' })).worktree).toEqual({ path:'/tmp/not-ours', refusal:"Not in AI Term's record" });
 await expect(client.request({ kind:'worktrees.delete', path:'/tmp/not-ours', fingerprint })).rejects.toThrow("Not in AI Term's record");
});

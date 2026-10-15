import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { lstat, mkdir, chmod, readdir } from 'node:fs/promises';
import { ownedByMe } from './owner.js';
import { checkMine, restrictToMe } from './win-acl.js';
export interface Paths {
    root: string;
    run: string;
    logs: string;
    state: string;
    pid: string;
    socket: string;
    log: string;
}
export function getPaths(root = process.env.AI_TERM_HOME ?? join(homedir(), '.ai-term')): Paths {
    if (!isAbsolute(root) || root.includes('\0'))
        throw new Error('AI_TERM_HOME must be an absolute path');
    return { root, run: join(root, 'run'), logs: join(root, 'logs'), state: join(root, 'state.json'), pid: join(root, 'run/daemon.pid'), socket: join(root, 'run/daemon.sock'), log: join(root, 'logs/daemon.log') };
}
export function isFsError(error: unknown, code: string): boolean {
    return error instanceof Error && 'code' in error && error.code === code;
}
// Returns whether it was made just now. On Windows (v0.8.2) mode bits mean nothing and the folder inherits the AI Term
// folder's ACL, which preparePaths sets and checks.
export async function privateDirectory(path: string): Promise<boolean> {
    let created = true;
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        if (!isFsError(error, 'EEXIST'))
            throw error;
        created = false;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByMe(stat))
        throw new Error('Private directory must be a real directory owned by this user');
    if (process.platform !== 'win32') await chmod(path, 0o700);
    return created;
}
// Windows: a client that makes the AI Term folder gives it an ACL for your SID alone (icacls); the daemon reads the folder
// and each folder in it back (one PowerShell run: owned by you, every entry yours) and won't run on anything else. Only
// the daemon pays for PowerShell, once per start (review), so typing `ai` stays quick.
export function aclPlan(state: { created: boolean; daemon: boolean }): 'restrict' | 'verify' | 'none' {
    return state.daemon ? 'verify' : state.created ? 'restrict' : 'none';
}
const NOT_PRIVATE = 'Private directory must be a real directory owned by this user';
export async function preparePaths(paths: Paths, options: { daemon?: boolean } = {}): Promise<void> {
    const created = await privateDirectory(paths.root);
    await privateDirectory(paths.run);
    await privateDirectory(paths.logs);
    if (process.platform !== 'win32') return;
    const plan = aclPlan({ created, daemon: options.daemon === true });
    if (plan === 'none') return;
    if (created) await restrictToMe(paths.root);
    if (plan === 'restrict') return;
    const folders = async () => [paths.root, ...(await readdir(paths.root, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => join(paths.root, entry.name))];
    if (await checkMine(await folders())) return;
    // A folder made before v0.8.2 (or by hand) gets the ACL once; one someone else made inside it can't be fixed this way.
    await restrictToMe(paths.root);
    if (!await checkMine(await folders())) throw new Error(NOT_PRIVATE);
}

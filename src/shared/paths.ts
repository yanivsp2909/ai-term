import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { lstat, mkdir, chmod } from 'node:fs/promises';
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
export async function privateDirectory(path: string): Promise<void> {
    try {
        await mkdir(path, { mode: 0o700 });
    }
    catch (error) {
        if (!isFsError(error, 'EEXIST'))
            throw error;
    }
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory() || !ownedByMe(stat))
        throw new Error('Private directory must be a real directory owned by this user');
    if (process.platform === 'win32') { await privateOnWindows(path); return; }
    await chmod(path, 0o700);
}
// Windows (v0.8.2): mode bits mean nothing there. The folder gets an ACL for your SID alone (icacls), then is read back:
// owned by you with no other entry, or AI Term refuses to use it. Checked once per folder per process (PowerShell is slow).
const checked = new Set<string>();
async function privateOnWindows(path: string): Promise<void> {
    if ([...checked].some(root => path.startsWith(`${root}\\`))) return;
    if (checked.has(path)) return;
    if (!await checkMine(path)) await restrictToMe(path);
    if (!await checkMine(path)) throw new Error('Private directory must be a real directory owned by this user');
    checked.add(path);
}
export async function preparePaths(paths: Paths): Promise<void> {
    await privateDirectory(paths.root);
    await privateDirectory(paths.run);
    await privateDirectory(paths.logs);
}

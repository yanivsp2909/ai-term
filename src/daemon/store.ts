import { constants } from 'node:fs';
import { chmod, copyFile, lstat, open, rename, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { dirname, join, basename } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { ownedByMe } from '../shared/owner.js';
export async function atomicWrite(path: string, value: unknown): Promise<void> {
    return atomicWriteText(path, JSON.stringify(value) + '\n');
}
// The same, for text that isn't JSON (v1.0.2 brain.md).
export async function atomicWriteText(path: string, text: string): Promise<void> {
    const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
    const file = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
        await file.writeFile(text);
        await file.sync();
    }
    catch (error) {
        await file.close();
        await unlink(temporary);
        throw error;
    }
    await file.close();
    try {
        await rename(temporary, path);
    }
    catch (error) {
        await unlink(temporary);
        throw error;
    }
    // Windows can't fsync a folder (EPERM; found by the v0.8 CI): NTFS keeps the rename in its own journal.
    if (process.platform === 'win32') return;
    const folder = await open(dirname(path), constants.O_RDONLY);
    try {
        await folder.sync();
    }
    finally {
        await folder.close();
    }
}
export async function readState(path: string): Promise<unknown> {
    let file;
    try {
        file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    }
    catch (error) {
        if (isFsError(error, 'ENOENT'))
            return { sessions: [] };
        throw error;
    }
    try {
        const stat = await file.stat();
        if (!stat.isFile() || !ownedByMe(stat) || stat.size > 16 * 1024 * 1024)
            throw new Error('Unsafe or oversized state file');
        await file.chmod(0o600);
        return JSON.parse(await file.readFile('utf8')) as unknown;
    }
    finally {
        await file.close();
    }
}
// B24: the stage an unreadable agent list failed at; the only detail that is ever logged about it.
export type StateStage = 'read' | 'parse' | 'validate' | 'migrate';
export class StateLoadError extends Error {
    constructor(readonly stage: StateStage) { super(`State ${stage} failed`); }
}
// Moves an unreadable state file to `<path>.corrupt-<timestamp>` without reading or rewriting it, so the next state
// write can never overwrite the user's only copy. `private` is false when the moved file's mode couldn't be set.
export async function moveAside(path: string, now = new Date()): Promise<{ path: string; private: boolean }> {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (let attempt = 0; attempt < 100; attempt++) {
        const target = `${path}.corrupt-${stamp}${attempt ? `-${attempt}` : ''}`;
        try { await lstat(target); continue; }
        catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
        await rename(path, target);
        // chmod follows symlinks, so only a regular file of ours is tightened; ~/.ai-term is 0700, so nobody else can
        // swap the name between lstat and chmod.
        try {
            const stat = await lstat(target);
            if (stat.isFile() && ownedByMe(stat)) await chmod(target, 0o600);
            return { path: target, private: stat.isFile() && ownedByMe(stat) };
        }
        catch { return { path: target, private: false }; }
    }
    throw new Error('No free name for the moved-aside state file');
}
// A private copy of a state file that loaded only in part, under the same `.corrupt-<timestamp>` name, before the next
// save writes the readable part back. COPYFILE_EXCL never replaces an existing copy.
export async function keepCopy(path: string, now = new Date()): Promise<string> {
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    for (let attempt = 0; attempt < 100; attempt++) {
        const target = `${path}.corrupt-${stamp}${attempt ? `-${attempt}` : ''}`;
        try { await copyFile(path, target, constants.COPYFILE_EXCL); }
        catch (error) { if (isFsError(error, 'EEXIST')) continue; throw error; }
        await chmod(target, 0o600);
        return target;
    }
    throw new Error('No free name for the copied state file');
}

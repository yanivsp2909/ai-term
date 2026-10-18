import { execFile } from 'node:child_process';
import { statSync } from 'node:fs';
import { lstat, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { removeTree } from './temp-clone.js';

// B33: /bisect's temporary copy gets its own copy-on-write clone of each installed dependency folder, so a test runner
// that writes a cache inside node_modules (Vitest's node_modules/.vite) writes into the clone. APFS clonefile (macOS)
// and reflinks (Linux) share the data blocks until one side writes, so a clone takes seconds whatever the size, and a
// write lands in the clone's own blocks: your folder never changes. Where the disk can't clone, the caller falls back
// to B32's read-only link.
export const CLONE_TIMEOUT_MS = 10 * 60_000;
// why: a few fixed words for the daemon's log (never cp's own output, which names paths).
export type CloneResult = { ok: true } | { ok: false; why: string };
const NO_CLONE: CloneResult = { ok: false, why: "this disk can't clone" };
// Linux has no fixed place for cp (NixOS has neither of these); without one there is no clone.
const linuxCp = (): string | null => ['/usr/bin/cp', '/bin/cp'].find(path => { try { return statSync(path).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } }) ?? null;
// -P: no link is followed, not even the source itself (also cp's default with -R), so a link inside the folder is
// copied as a link and nothing outside it is read. --reflink=always rather than auto: auto quietly makes a full copy
// where the file system can't share blocks; always fails instead, and the folder is linked read-only.
export function cloneCommand(platform: NodeJS.Platform, source: string, dest: string, cp: string | null = platform === 'linux' ? linuxCp() : null): { file: string; args: string[] } | null {
  if (platform === 'darwin') return { file: '/bin/cp', args: ['-c', '-P', '-R', '--', source, dest] };
  if (platform === 'linux' && cp) return { file: cp, args: ['--reflink=always', '-P', '-R', '--', source, dest] };
  return null;
}
// null when the program exited 0, else why it didn't (its exit code, a timeout, or the error code that kept it from starting).
const failure = (file: string, args: readonly string[], timeout: number): Promise<string | null> => new Promise(done => {
  execFile(file, args, { timeout, env: { PATH: '/usr/bin:/bin' }, maxBuffer: 1024 * 1024 }, error => {
    const name = file.split('/').at(-1) ?? 'cp';
    if (!error) done(null);
    else if (error.killed) done(`${name} timed out`);
    else if (typeof error.code === 'number') done(`${name} exited ${error.code}`);
    else done(`${name} couldn't start (${typeof error.code === 'string' && /^E[A-Z_]+$/.test(error.code) ? error.code : 'error'})`);
  });
});
// clonefile and reflinks work only within one file system: the same device. macOS's cp -c also falls back to a full
// copy on a disk that isn't APFS (which could take minutes and fill the temp disk), so df must list the volume as
// APFS there (df -T apfs exits 1 for any other file system).
async function cloneable(source: string, folder: string, platform: NodeJS.Platform): Promise<boolean> {
  let from: number, to: number;
  // A folder gone since the plan checked it can't be cloned; the link step re-checks it.
  try { [from, to] = (await Promise.all([stat(source), stat(folder)])).map(info => info.dev) as [number, number]; } catch (error) { if (isFsError(error, 'ENOENT')) return false; throw error; }
  return from === to && (platform !== 'darwin' || await failure('/bin/df', ['-T', 'apfs', '-P', '--', folder], 10_000) === null);
}
// ok when dest is now a real folder cloned from source. Anything else (no clone on this disk, cp failed midway, or the
// source was swapped for a link after it was checked, which cp copies as a link) leaves nothing at dest.
export async function cloneFolder(source: string, dest: string, platform: NodeJS.Platform = process.platform): Promise<CloneResult> {
  const command = cloneCommand(platform, source, dest);
  if (!command || !await cloneable(source, dirname(dest), platform)) return NO_CLONE;
  const why = await failure(command.file, command.args, CLONE_TIMEOUT_MS);
  if (!why) {
    try { if ((await lstat(dest)).isDirectory()) return { ok: true }; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  // removeTree removes a link itself, never what it points to.
  await removeTree(dest);
  return { ok: false, why: why ?? 'it is a link now' };
}

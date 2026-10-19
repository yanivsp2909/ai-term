import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { errorKind } from './log.js';
import { OWNER_FILE, OWNER_LINE } from './own-temp.js';
import { removeTree } from './temp-clone.js';

export { OWNER_FILE, ownTempFolder } from './own-temp.js';

// Backlog F2: at daemon start, the temporary folders a stopped AI Term left behind (it died mid-/bisect, say) are removed.
// Only a folder that is all of these: named like AI Term's own (ai-term-<kind>-XXXXXX, as mkdtemp names them), a real
// folder (never a link) owned by you, holding AI Term's owner file (a regular file of yours, read without following a
// link) that names a process that no longer runs. Anything else in the temp folder is left as it is. removeTree never
// follows a link inside a folder it removes.
const NAME = /^ai-term-(?:clone|test|deps|diff)-[A-Za-z0-9]{6}$/;
const MARKER_BYTES = 64;
// A process that runs, or one this user can't signal (EPERM: someone else's), counts as alive: its folders stay.
export function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (isFsError(error, 'ESRCH')) return false; if (isFsError(error, 'EPERM')) return true; throw error; }
}
const uid = (): number | null => typeof process.getuid === 'function' ? process.getuid() : null;
async function ownerOf(folder: string, me: number): Promise<number | null> {
  let marker;
  try { marker = await open(join(folder, OWNER_FILE), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP') || isFsError(error, 'ENOTDIR')) return null; throw error; }
  try {
    const info = await marker.stat();
    if (!info.isFile() || info.uid !== me || info.size > MARKER_BYTES) return null;
    const pid = Number((await marker.readFile('utf8')).match(OWNER_LINE)?.[1]);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } finally { await marker.close(); }
}
// dir: the system temp folder by default (tests pass their own). Returns how many folders were removed.
export async function sweepTemp(options: { dir?: string; log: (text: string) => void; alive?: (pid: number) => boolean }): Promise<number> {
  const me = uid(); if (me === null) return 0; // Windows: no owner to check, so nothing is removed.
  const dir = options.dir ?? await realpath(tmpdir()), alive = options.alive ?? processAlive;
  let removed = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!NAME.test(entry.name) || !entry.isDirectory()) continue;
    const folder = join(dir, entry.name);
    try {
      const info = await lstat(folder);
      if (!info.isDirectory() || info.uid !== me) continue;
      const pid = await ownerOf(folder, me);
      if (pid === null || pid === process.pid || alive(pid)) continue;
      await removeTree(folder); removed++;
    } catch (error) {
      // One folder that can't be read or removed doesn't stop the rest (it may have gone meanwhile).
      if (isFsError(error, 'ENOENT')) continue;
      options.log(`Temp sweep: a leftover temporary folder could not be removed (${errorKind(error)})`);
    }
  }
  if (removed) options.log(`Temp sweep: removed ${removed} temporary folder${removed === 1 ? '' : 's'} a stopped AI Term left behind`);
  return removed;
}

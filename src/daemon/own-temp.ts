import { constants } from 'node:fs';
import { mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Backlog F2: every temporary folder AI Term makes for a run (/bisect's and /perf's copy, a test sandbox's temp folder,
// /deps' manifests, a diff's private git dir) carries an owner file naming the process that made it. A daemon that dies
// mid-run leaves its folders behind; the next daemon's start-up sweep (temp-sweep.ts) removes only folders marked this
// way whose process no longer runs.
export const OWNER_FILE = '.ai-term-owner';
export type TempKind = 'clone' | 'test' | 'deps' | 'diff';
export const OWNER_LINE = /^ai-term (\d{1,10})\n$/;
// base: where the folder goes (the system temp folder's real path by default).
export async function ownTempFolder(kind: TempKind, base?: string): Promise<string> {
  const folder = await mkdtemp(join(base ?? await realpath(tmpdir()), `ai-term-${kind}-`));
  try {
    const marker = await open(join(folder, OWNER_FILE), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await marker.writeFile(`ai-term ${process.pid}\n`); } finally { await marker.close(); }
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
  return folder;
}

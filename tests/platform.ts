import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { BWRAP_PATHS } from '../src/daemon/bwrap.js';

// B34: what this machine can't do, so a test that needs it skips with the reason in its name instead of failing.
// Each title carries the reason whether or not it skips, like the existing "macOS (skipped elsewhere: …)" titles.

// Root reads and writes past file modes, so a test that proves "can't read" or "can't write" with chmod can't fail
// the way it means to.
export const AS_ROOT = process.getuid?.() === 0;

// Linux runs tests and Don't ask bash only inside bubblewrap. It must be installed and able to start here (a container
// without user namespaces has the binary but can't run it).
function bwrapRuns(): boolean {
  const program = BWRAP_PATHS.find(path => existsSync(path));
  if (!program) return false;
  try { execFileSync(program, ['--ro-bind', '/', '/', '--dev', '/dev', '/bin/true'], { stdio: 'ignore', timeout: 10_000 }); return true; }
  catch { return false; }
}
export const NO_LINUX_SANDBOX = process.platform === 'linux' && !bwrapRuns();

// Whether any process of a group still runs. A killed process stays a zombie until its parent reaps it, and an orphan's
// new parent is the init process: in a container whose init isn't a real one that can take seconds, while the process
// is already dead. Linux tells the states apart through /proc; elsewhere a signal 0 to the group decides.
export function groupRuns(pgid: number): boolean {
  try { process.kill(-pgid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  for (const entry of readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    let stat: string;
    try { stat = readFileSync(`/proc/${entry}/stat`, 'utf8'); } catch { continue; }
    // pid (comm) state ppid pgrp …; comm may hold spaces and parentheses, so read after its last ')'.
    const [state, , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(group) === pgid && state !== 'Z') return true;
  }
  return false;
}

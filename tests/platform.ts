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

// Whether a process, or any process of a group, still runs. A killed process stays a zombie until its parent reaps it,
// and an orphan's new parent is the init process: in a container whose init isn't a real one (Docker's default runs
// your command as PID 1) that can take seconds or never happen, while the process is already dead. Linux tells the
// states apart through /proc; elsewhere a signal 0 decides.
function procState(pid: string): { state: string; group: number } | null {
  let stat: string;
  try { stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch { return null; }
  // pid (comm) state ppid pgrp …; comm may hold spaces and parentheses, so read after its last ')'.
  const [state = '', , group] = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return { state, group: Number(group) };
}
export function processRuns(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  return process.platform !== 'linux' || (procState(String(pid))?.state ?? 'Z') !== 'Z';
}
export function groupRuns(pgid: number): boolean {
  try { process.kill(-pgid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  return readdirSync('/proc').some(entry => { if (!/^\d+$/.test(entry)) return false; const found = procState(entry); return found !== null && found.group === pgid && found.state !== 'Z'; });
}

// The terminal tests drive a real vim, at its usual path.
export const NO_VIM = !existsSync('/usr/bin/vim');

// PID 1 is root's on a normal machine, but yours when you are root or in a container started as you.
export const PID1_MINE = (() => { try { process.kill(1, 0); return true; } catch { return false; } })();

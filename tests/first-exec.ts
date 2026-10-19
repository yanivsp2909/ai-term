import { spawn } from 'node:child_process';

// macOS assesses a new executable the first time it runs, one at a time across the machine (~250 ms each), so a timed
// check of a fresh stub CLI can miss its timeout when the whole suite runs at once (v1.2.0 Mac check). Running each
// stub once first takes that out of the timed part. Its output and exit code don't matter; it is stopped after 3 s.
const LIMIT_MS = 3000;
export function runOnce(path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(path, ['--version'], { stdio: 'ignore', env: { PATH: '/usr/bin:/bin' } });
    const timer = setTimeout(() => { child.kill('SIGKILL'); }, LIMIT_MS);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', () => { clearTimeout(timer); resolve(); });
  });
}

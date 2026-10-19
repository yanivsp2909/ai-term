import { execFileSync } from 'node:child_process';
import { GIT } from '../src/daemon/git-path.js';

// B34: AI Term needs git 2.41 or newer (`--attr-source` from 2.40, `%(ahead-behind)` from 2.41). With an older git about
// a hundred tests fail one by one with "git could not read the worktree"; this says why once, before any test runs.
export default function checkGit(): void {
  if (!GIT) throw new Error('The tests need git; none was found');
  const version = execFileSync(GIT, ['--version'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' } });
  const [major = 0, minor = 0] = (version.match(/(\d+)\.(\d+)/)?.slice(1) ?? []).map(Number);
  if (major < 2 || major === 2 && minor < 41) throw new Error(`AI Term and its tests need git 2.41 or newer; this machine has ${version.trim()}`);
}

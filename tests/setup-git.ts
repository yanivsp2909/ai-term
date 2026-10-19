import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// B34: every git a test runs (directly, or through a child that inherits this env) reads this file instead of the
// machine's ~/.gitconfig and /etc/gitconfig, so a default branch of `master`, a signing setup or a missing user.name
// on the machine never changes a result. AI Term's own git calls set GIT_CONFIG_GLOBAL=/dev/null themselves.
const folder = mkdtempSync(join(tmpdir(), 'vitest-git-'));
const config = join(folder, 'gitconfig');
writeFileSync(config, '[init]\n\tdefaultBranch = main\n[user]\n\tname = Test\n\temail = test@example.invalid\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n', { mode: 0o600 });
process.env.GIT_CONFIG_GLOBAL = config;
process.env.GIT_CONFIG_NOSYSTEM = '1';
process.on('exit', () => rmSync(folder, { recursive: true, force: true }));

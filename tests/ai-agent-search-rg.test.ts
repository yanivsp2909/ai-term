import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchTool } from '../src/agent/tools.js';

// search through ripgrep: argv only, no config file, the pattern as --regexp's value (so "-e" or "--files" is a pattern,
// never an option), `--` before the path, and rg's own exit codes (1 = no matches, 2 = error) read correctly.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

async function stubRg(reply: string, code: number) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-rg-'))); roots.push(root);
  const rg = join(root, 'rg'), log = join(root, 'argv'), work = join(root, 'work');
  await (await import('node:fs/promises')).mkdir(work);
  await writeFile(rg, `#!/bin/sh\nfor a in "$@"; do printf '%s\\n' "$a"; done > '${log}'\nprintf '%s' '${reply}'\nexit ${code}\n`); await chmod(rg, 0o755);
  return { rg, log, work };
}

it('passes the pattern only as --regexp\'s value and the path after --', async () => {
  const { rg, log, work } = await stubRg('a.txt:3:--files here', 0);
  expect(await searchTool(work, { pattern: '--files' }, rg)).toBe('a.txt:3:--files here');
  expect((await readFile(log, 'utf8')).trim().split('\n')).toEqual(['--no-config', '--line-number', '--no-heading', '--color=never', '--max-count=50', '--max-filesize=1M', '--regexp', '--files', '--', '.']);
});

it('reads exit 1 as no matches and exit 2 as a failed search', async () => {
  expect(await searchTool((await stubRg('', 1)).work, { pattern: 'x' }, (await stubRg('', 1)).rg)).toBe('no matches');
  const broken = await stubRg('', 2);
  await expect(searchTool(broken.work, { pattern: '(' }, broken.rg)).rejects.toThrow('search failed (check the pattern)');
});

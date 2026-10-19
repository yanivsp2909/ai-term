import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { helpLines } from '../src/client/tui/commands.js';

// The keys the backlog fixes added (F1 x, F3 r) are in /help and the README, and the user guide says what they do.
it('/help, the README and the user guide name x for /bisect and the A/B, and r in /study\'s due list', async () => {
  const help = helpLines({ engine: 'claude-code', model: null, cwd: '/tmp', theme: 'graphite' }).join('\n');
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8'), guide = await readFile(new URL('../docs/user-guide.md', import.meta.url), 'utf8');
  for (const keys of ['/bisect · /perf x', '/study r']) { expect(help, keys).toContain(keys); expect(readme, keys).toContain(keys); }
  for (const words of ['press `x` to stop it', '`/bisect` alone opens it again', '`r` reopens your last one', 'names the file it kept them in']) expect(guide, words).toContain(words);
});

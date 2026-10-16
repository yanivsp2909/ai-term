import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { commandRegistry, helpLines } from '../src/client/tui/commands.js';

it('pilot commands preserve the default model/folder menu actions and document their popup keys', async () => {
  expect(commandRegistry.slice(0, 2).map(command => command.name)).toEqual(['/model', '/cd']);
  const context = { engine: 'claude-code' as const, model: null, cwd: '/tmp', theme: 'graphite' as const };
  const help = helpLines(context).join('\n'), readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  for (const text of [help, readme]) {
    expect(text).toContain('Add-on e / m / b / y / Enter / Esc');
    expect(text).toContain('/plan a / ↑↓ / PgUp/PgDn / s');
    expect(text).toContain('/prompt c · /explain Space');
  }
});

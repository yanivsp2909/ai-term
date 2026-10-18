import { expect, it } from 'vitest';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { commandRegistry, helpLines } from '../src/client/tui/commands.js';

// v0.9.3 consistency polish (mechanical): the same wording for a command in /help and the README, one-line refusals,
// key hints in one verb form, colors only from tokens.
const context = { engine: 'claude-code' as const, model: 'opus', cwd: '/tmp/work', theme: 'graphite' as const, effort: 'high' as const, permission: 'ask' as const };
async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  return entries.filter(e => e.isFile() && e.name.endsWith('.ts')).map(e => join(e.parentPath, e.name));
}

it('every command reads the same in /help and in its README row', async () => {
  const readme = (await readFile(new URL('../README.md', import.meta.url), 'utf8')).split('\n'), help = helpLines(context).join('\n');
  for (const command of commandRegistry) {
    expect(help, command.name).toContain(command.description);
    const rows = readme.filter(line => line.startsWith('| `') && (line.split(' | ')[0] ?? '').match(/`(\/[a-z0-9-]+)/g)?.some(name => name === '`' + command.name));
    expect(rows.some(row => row.includes(command.description)), `${command.name}: README row should say "${command.description}"`).toBe(true);
  }
});

it('refusals and errors are one plain line', async () => {
  const messages = /new \w*Error\((['"`])((?:\\.|(?!\1).)*)\1/g;
  for (const file of [...await sources('src/daemon'), ...await sources('src/shared'), ...await sources('src/client'), ...await sources('src/agent')]) {
    for (const match of (await readFile(file, 'utf8')).matchAll(messages)) expect(match[2], file).not.toContain('\\n');
  }
});

it('key hints use one verb form: Esc closes, cancels or goes back; never "Esc close" or "Esc cancel"', async () => {
  for (const file of [...await sources('src/client'), ...await sources('src/agent')]) {
    const text = await readFile(file, 'utf8');
    expect(text, file).not.toMatch(/Esc (close|cancel|deny|discard)\b(?!s)/);
    expect(text, file).not.toMatch(/⏎ (save|select|pick|run)\b(?!s)/);
  }
});

it('colors come only from the theme: no raw hex in the client or the app', async () => {
  const files = [...await sources('src/client'), ...await sources('src/agent'), ...await sources('app/renderer'), ...await sources('app/main')].filter(file => !file.endsWith('theme.ts'));
  for (const file of files) expect(await readFile(file, 'utf8'), file).not.toMatch(/['"`]#[0-9a-fA-F]{6}\b/);
});

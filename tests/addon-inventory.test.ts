import { expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';

it('Part B: inventory rows have provenance, purpose, quality, overlap, license and a command; suggestions remain bounded', async () => {
  const text = await readFile(new URL('../docs/addons/inventory.md', import.meta.url), 'utf8');
  const rows = text.split('\n').filter(line => line.startsWith('| ') && !line.startsWith('| Name ') && !line.startsWith('| ---'));
  expect(rows.length).toBeGreaterThan(0);
  const paths = new Set<string>();
  for (const row of rows) {
    const cells = row.slice(1, -1).split('|').map(cell => cell.trim());
    expect(cells).toHaveLength(7);
    expect(cells.every(Boolean)).toBe(true);
    expect(cells[3]).toMatch(/^[1-5]\/5 — .+/);
    expect(paths.has(cells[1] ?? '')).toBe(false);
    paths.add(cells[1] ?? '');
  }
  const count = Number(text.match(/Definitions inventoried: (\d+)/)?.[1]);
  expect(rows).toHaveLength(count);
  const suggestions = text.split('## Additional command suggestions')[1] ?? '';
  expect(suggestions.split('\n').filter(line => line.startsWith('- `/'))).toHaveLength(10);
});


it('Part B review: harmless skill names keep exact provenance and overlaps require shared subject matter', async () => {
  const text = await readFile(new URL('../docs/addons/inventory.md', import.meta.url), 'utf8');
  expect(text).toContain('~/.agents/skills/ask-sonner/SKILL.md');
  expect(text).not.toContain('a[redacted]');
  const adRow = text.split('\n').find(line => line.startsWith('| ad-manager ')) ?? '';
  expect(adRow).not.toContain('adhd');
});

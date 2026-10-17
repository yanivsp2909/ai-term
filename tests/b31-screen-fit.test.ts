import { expect, it } from 'vitest';
import { Screen } from '../src/agent/screen.js';
import { createTheme } from '../src/client/tui/theme.js';
import { textWidth } from '../src/shared/unicode-width.js';

// B31: a 17 KB bash command took 1.6 s of CPU to fit on one line (a character at a time, re-measured each time), so a
// loaded machine pushed its test past the timeout. The cut is one pass now; what it shows stays the same.
function screen(columns: number) {
  const writes: string[] = [];
  const s = new Screen({ write: t => { writes.push(t); }, columns, rows: 30 }, createTheme('graphite'));
  // The text each row ends up showing: escape sequences dropped, and a line redrawn in place (\r) read as its last draw.
  // eslint-disable-next-line no-control-regex -- the escape sequences are what is removed.
  const shown = () => writes.join('').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').split('\n').map(line => line.split('\r').at(-1) ?? '').filter(Boolean);
  return { s, shown };
}

it('a long summary is cut to the row with an ellipsis, wide characters whole', () => {
  const { s, shown } = screen(40);
  s.toolStart('bash', 'echo ' + 'x'.repeat(17 * 1024));
  s.toolStart('bash', '漢字'.repeat(40));
  s.toolStart('bash', 'short');
  const [long, wide, short] = shown();
  expect(long).toBe(`· bash echo ${'x'.repeat(40 - 7 - 1 - 1 - 5)}…`);
  expect(wide).toMatch(/^· bash (漢字)+漢?…$/);
  expect(textWidth(wide ?? '')).toBeLessThanOrEqual(39);
  expect(short).toBe('· bash short');
});

it('a long prompt shows its last part that fits, wide characters whole', () => {
  const { s, shown } = screen(20);
  s.prompt('a'.repeat(17 * 1024) + 'END');
  expect(shown().at(-1)).toBe(`› ${'a'.repeat(14)}END`);
  s.prompt('漢'.repeat(30));
  expect(shown().at(-1)).toBe(`› ${'漢'.repeat(8)}`);
});

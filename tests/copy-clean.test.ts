import { expect, it } from 'vitest';
import { cleanSessionText } from '../src/client/tui/copy-clean.js';

it('strips all box-drawing edge variants, drops decorative lines and collapses empty runs', () => {
  expect(cleanSessionText('\n┌──┐\n│ answer │\n║ next ║\n╭ rounded ╮\n╰──╯\n⠋ ⠙ ⠹ ◐\n---\n═══\n\n\n│ final │\n')).toBe('answer\nnext\nrounded\n\nfinal');
});
it('keeps prose, markdown, code indentation, internal borders and nondecorative Unicode', () => {
  const text = '╭────╮\n│ ```ts             │\n│   const s = "a│b"; │\n│ ```               │\n╰────╯\n\n- useful list\n| table | value |\n> quote\n界🙂\n⠋ working\n1 - 2 = -1';
  expect(cleanSessionText(text)).toBe('```ts\n  const s = "a│b";\n```\n\n- useful list\n| table | value |\n> quote\n界🙂\n⠋ working\n1 - 2 = -1');
});
it('is idempotent, handles CRLF and produces empty text for an empty decorative session', () => {
  expect(cleanSessionText(' \r\n┃ ┃\r\n⠿ ─\r\n')).toBe('');
  const once = cleanSessionText('│ one │\r\n\r\n│ two │');
  expect(once).toBe('one\n\ntwo'); expect(cleanSessionText(once)).toBe(once);
});
it('cleans long internal border runs without blocking input for a quadratic suffix search', () => {
  const text = 'prose ' + '─'.repeat(50000) + ' x';
  const started = performance.now(), cleaned = cleanSessionText(text);
  expect(cleaned).toBe(text); expect(performance.now() - started).toBeLessThan(500);
});

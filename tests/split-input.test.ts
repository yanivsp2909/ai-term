import { expect, it } from 'vitest';
import { SplitInput, type SplitInputEvent } from '../src/client/split-input.js';

const all = (input: SplitInput, ...chunks: (string | number[])[]): SplitInputEvent[] => chunks.flatMap(chunk => input.push(Buffer.from(typeof chunk === 'string' ? chunk : chunk)));
const text = (events: SplitInputEvent[]) => events.map(e => e.kind === 'keys' ? `keys:${e.data.toString('latin1')}` : e.kind === 'mouse' ? `mouse:${e.button},${e.x},${e.y},${e.release}` : e.kind).join('|');

it('plain typing passes through as keys for the focused pane, byte for byte', () => {
 expect(text(all(new SplitInput(), 'ab\x1b[A\r', 'é'))).toBe('keys:ab\x1b[A\r|keys:\xc3\xa9');
});
it('Ctrl+\\ in every encoding is the pane key; Ctrl+E in every encoding is home', () => {
 for (const pane of [[0x1c], '\x1b[92;5u', '\x1b[92;5:1u', '\x1b[92;5:2u', '\x1b[27;5;92~']) expect(text(all(new SplitInput(), pane))).toBe('pane');
 for (const home of [[5], '\x1b[101;5u', '\x1b[27;5;101~']) expect(text(all(new SplitInput(), home))).toBe('home');
 expect(text(all(new SplitInput(), 'a', [0x1c], 'b'))).toBe('keys:a|pane|keys:b');
});
it('the pane key event keeps the exact bytes, so a double press can forward the real key', () => {
 const [event] = all(new SplitInput(), '\x1b[92;5u');
 expect(event).toEqual({ kind:'pane', data:Buffer.from('\x1b[92;5u') });
});
it('a kitty key release is swallowed and never counts as a press', () => {
 expect(text(all(new SplitInput(), '\x1b[92;5:3u'))).toBe('');
});
it('sequences split across reads are still recognized', () => {
 expect(text(all(new SplitInput(), '\x1b[9', '2;5u'))).toBe('pane');
 expect(text(all(new SplitInput(), '\x1b[<0;1', '0;5M'))).toBe('mouse:0,9,4,false');
});
it('SGR mouse reports become 0-based mouse events, presses and releases', () => {
 expect(text(all(new SplitInput(), '\x1b[<0;3;2M\x1b[<0;3;2m\x1b[<64;1;1M'))).toBe('mouse:0,2,1,false|mouse:0,2,1,true|mouse:64,0,0,false');
});
it('inside a bracketed paste nothing is a pane key, home or mouse; it all goes to the focused pane', () => {
 const events = all(new SplitInput(), '\x1b[200~a\x1c\x05\x1b[<0;3;2Mb\x1b[201~', [0x1c]);
 expect(text(events)).toBe('keys:\x1b[200~a\x1c\x05\x1b[<0;3;2Mb\x1b[201~|pane');
});
it('a lone Escape waits for the ambiguity timeout, then flushes as a key', () => {
 const input = new SplitInput();
 expect(all(input, [27])).toEqual([]);
 expect(text(input.flush())).toBe('keys:\x1b');
 expect(text(all(input, '\x1b', 'x'))).toBe('keys:\x1bx');
});
it('an unfinished long sequence is passed on rather than held', () => {
 expect(text(all(new SplitInput(), '\x1b[' + '1;'.repeat(60)))).toContain('keys:');
});

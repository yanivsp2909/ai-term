import { expect, it } from 'vitest';
import { encodeMouse } from '../src/client/split-mouse.js';

const press = { button:0, x:4, y:2, release:false }, release = { ...press, release:true }, drag = { ...press, button:32 }, hover = { ...press, button:35 }, wheel = { ...press, button:64 };
const enc = (event: typeof press, tracking: 'none' | 'x10' | 'vt200' | 'drag' | 'any', encoding: 'default' | 'utf8' | 'sgr' | 'urxvt' = 'sgr') => encodeMouse(event, { tracking, encoding })?.toString('latin1') ?? null;

it('pane-relative coordinates are encoded 1-based in the pane agent\'s own encoding', () => {
 expect(enc(press, 'vt200', 'sgr')).toBe('\x1b[<0;5;3M');
 expect(enc(release, 'vt200', 'sgr')).toBe('\x1b[<0;5;3m');
 expect(enc(press, 'vt200', 'default')).toBe('\x1b[M' + String.fromCharCode(32, 37, 35));
 expect(enc(release, 'vt200', 'default')).toBe('\x1b[M' + String.fromCharCode(35, 37, 35));
 expect(enc(press, 'vt200', 'urxvt')).toBe('\x1b[32;5;3M');
 expect(enc(release, 'vt200', 'urxvt')).toBe('\x1b[35;5;3M');
});
it('each tracking level gets only the events it asked for', () => {
 expect([press, release, drag, hover, wheel].map(e => enc(e, 'none'))).toEqual([null, null, null, null, null]);
 expect([press, release, drag, hover, wheel].map(e => enc(e, 'x10') !== null)).toEqual([true, false, false, false, true]);
 expect([press, release, drag, hover, wheel].map(e => enc(e, 'vt200') !== null)).toEqual([true, true, false, false, true]);
 expect([press, release, drag, hover, wheel].map(e => enc(e, 'drag') !== null)).toEqual([true, true, true, false, true]);
 expect([press, release, drag, hover, wheel].map(e => enc(e, 'any') !== null)).toEqual([true, true, true, true, true]);
});
it('X10 reports carry no modifiers', () => {
 expect(enc({ ...press, button:4 | 16 }, 'x10')).toBe('\x1b[<0;5;3M');
 expect(enc({ ...press, button:4 | 16 }, 'vt200')).toBe('\x1b[<20;5;3M');
});
it('legacy encodings drop what they cannot address; UTF-8 mode reaches further', () => {
 expect(enc({ ...press, x:300 }, 'vt200', 'default')).toBeNull();
 expect(encodeMouse({ ...press, x:300 }, { tracking:'vt200', encoding:'utf8' })).toEqual(Buffer.from('\x1b[M ' + String.fromCodePoint(333) + '#', 'utf8'));
});

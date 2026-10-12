// Throwaway spike code (v0.2.1b). Not product code.
// In redraw mode nothing the agent prints reaches the real terminal unless this file forwards it.
// Raw passthrough gets all of this for free; here each case is an explicit decision.
import headless from '@xterm/headless';
import type { Encoding } from './mouse.js';

export interface OuterFacts { foreground?: string; background?: string; kitty: boolean }
export interface Passthrough {
  cursorVisible: () => boolean;
  mouse: () => { tracking: boolean; encoding: Encoding };
  dropped: Record<string, number>;
  modeLog: string[];
}

// DECSET/DECRST modes that describe the real terminal's input or look, not the mirror's screen.
// 1 cursor keys, 9/1000/1002/1003 mouse tracking, 1005/1006/1015 mouse encoding, 1004 focus,
// 1007 alternate scroll, 2004 bracketed paste, 12 cursor blink, 66 keypad, 2031 dark/light
// theme-change reports (Claude Code turns it on).
const FORWARD_MODES = new Set([1, 9, 1000, 1002, 1003, 1005, 1006, 1015, 1004, 1007, 2004, 12, 66, 2031]);
const OSC_FORWARD = new Set([0, 1, 2, 7, 9, 777, 104, 110, 111, 112]);
const OSC52_LIMIT = 1024 * 1024;

export function installPassthrough(term: headless.Terminal, facts: OuterFacts, out: (data: string) => void, reply: (data: string) => void): Passthrough {
  let cursorVisible = true, encoding: Encoding = 'default';
  const kittyStack: number[] = [0];
  const dropped: Record<string, number> = {}, modeLog: string[] = [];
  const drop = (what: string): boolean => { dropped[what] = (dropped[what] ?? 0) + 1; return true; };
  const p = term.parser;

  for (const final of ['h', 'l'] as const) p.registerCsiHandler({ prefix: '?', final }, params => {
    const on = final === 'h', forward: number[] = [];
    if (modeLog.length < 200) modeLog.push(params.map(String).join(';') + final);
    for (const param of params) {
      if (typeof param !== 'number') continue;
      if (param === 25) cursorVisible = on;
      const enc: Encoding | null = param === 1005 ? 'utf8' : param === 1006 ? 'sgr' : param === 1015 ? 'urxvt' : null;
      if (enc && (on || encoding === enc)) encoding = on ? enc : 'default';
      if (FORWARD_MODES.has(param)) forward.push(param);
      // SGR-pixel coordinates can't be shifted by one row without the cell height; refuse it.
      if (param === 1016 && on) drop('mode 1016 sgr-pixels');
    }
    if (forward.length) out(`\x1b[?${forward.join(';')}${final}`);
    return false; // xterm still applies every mode to the mirror.
  });
  // The theme query (`CSI ? 996 n`) is about the real terminal; its reply comes back as input.
  // Other DSR queries (cursor position) stay with the mirror, which knows the agent's coordinates.
  p.registerCsiHandler({ prefix: '?', final: 'n' }, params => { if (params[0] !== 996) return false; out('\x1b[?996n'); return true; });
  // Keypad application/normal mode.
  p.registerEscHandler({ final: '=' }, () => { out('\x1b='); return false; });
  p.registerEscHandler({ final: '>' }, () => { out('\x1b>'); return false; });
  // Full reset: the real terminal must forget the forwarded modes too.
  p.registerEscHandler({ final: 'c' }, () => {
    cursorVisible = true; encoding = 'default'; kittyStack.splice(0, kittyStack.length, 0);
    out('\x1b[?1;9;1000;1002;1003;1005;1006;1015;1004;1007;2004;12;66;2031l\x1b>\x1b[0 q' + (facts.kitty ? '\x1b[=0u' : ''));
    return false;
  });
  // Cursor shape (DECSCUSR).
  p.registerCsiHandler({ intermediates: ' ', final: 'q' }, params => { out(`\x1b[${params.map(String).join(';')} q`); return false; });
  // xterm modifyOtherKeys (`CSI > 4 ; n m`) changes how the real keyboard encodes keys.
  p.registerCsiHandler({ prefix: '>', final: 'm' }, params => { out(`\x1b[>${params.map(String).join(';')}m`); return true; });
  // Kitty keyboard protocol. The mirror doesn't speak it, so answer queries from what the real
  // terminal said at startup, in order with the mirror's own DA1 answer.
  p.registerCsiHandler({ prefix: '?', final: 'u' }, () => { if (facts.kitty) reply(`\x1b[?${kittyStack.at(-1) ?? 0}u`); return true; });
  p.registerCsiHandler({ prefix: '>', final: 'u' }, params => {
    if (!facts.kitty) return drop('kitty push (outer terminal lacks it)');
    const flags = typeof params[0] === 'number' ? params[0] : 0; kittyStack.push(flags); out(`\x1b[>${flags}u`); return true;
  });
  p.registerCsiHandler({ prefix: '<', final: 'u' }, params => {
    if (!facts.kitty) return true;
    const n = typeof params[0] === 'number' && params[0] > 0 ? params[0] : 1;
    for (let i = 0; i < n && kittyStack.length > 1; i++) kittyStack.pop();
    out(`\x1b[<${n}u`); return true;
  });
  p.registerCsiHandler({ prefix: '=', final: 'u' }, params => {
    if (!facts.kitty) return true;
    const flags = typeof params[0] === 'number' ? params[0] : 0, how = typeof params[1] === 'number' ? params[1] : 1;
    const current = kittyStack.at(-1) ?? 0;
    kittyStack[kittyStack.length - 1] = how === 1 ? flags : how === 2 ? current | flags : current & ~flags;
    out(`\x1b[=${flags};${how}u`); return true;
  });
  // XTWINOPS: title stack goes out; a text-area size report is answered with the agent's size
  // (the real terminal would answer one row too many). Pixel reports are dropped.
  p.registerCsiHandler({ final: 't' }, params => {
    const op = params[0];
    if (op === 22 || op === 23) { out(`\x1b[${params.map(String).join(';')}t`); return true; }
    if (op === 18) { reply(`\x1b[8;${term.rows};${term.cols}t`); return true; }
    return drop(`XTWINOPS ${String(op)}`);
  });

  // OSC: titles, cwd, notifications and palette changes are position-free and go out unchanged.
  for (const ident of OSC_FORWARD) p.registerOscHandler(ident, data => { out(`\x1b]${ident}${data || ident < 100 ? ';' + data : ''}\x1b\\`); return false; });
  // Palette entry set goes out; a palette query can't be answered faithfully, so it's dropped.
  p.registerOscHandler(4, data => { if (data.includes('?')) return drop('OSC 4 query'); out(`\x1b]4;${data}\x1b\\`); return false; });
  // Default colors: sets go out; queries are answered from the real terminal's startup reply.
  for (const ident of [10, 11, 12]) p.registerOscHandler(ident, data => {
    if (data !== '?') { out(`\x1b]${ident};${data}\x1b\\`); return false; }
    const known = ident === 10 ? facts.foreground : ident === 11 ? facts.background : undefined;
    if (known) reply(`\x1b]${ident};${known}\x1b\\`); else drop(`OSC ${ident} query (no startup reply)`);
    return true;
  });
  // Clipboard: a write goes out (copy is position-free and raw mode allows it); a read is
  // dropped, because it would hand the clipboard to the agent.
  p.registerOscHandler(52, data => {
    const [, payload = ''] = data.split(';');
    if (payload === '?' ) return drop('OSC 52 read');
    if (data.length > OSC52_LIMIT) return drop('OSC 52 oversize');
    out(`\x1b]52;${data}\x1b\\`); return true;
  });
  // Hyperlinks: the mirror keeps the text but its link ids aren't public API, so the link target
  // is dropped (text stays; terminals still auto-detect plain URLs).
  p.registerOscHandler(8, () => { drop('OSC 8 hyperlink'); return false; });
  term.onBell(() => out('\x07'));

  return { cursorVisible: () => cursorVisible, mouse: () => ({ tracking: term.modes.mouseTrackingMode !== 'none', encoding }), dropped, modeLog };
}

// Ask the real terminal once, before the agent starts: default colors, kitty keyboard support,
// then DA1 as a sentinel. Every terminal answers DA1, so this rarely waits for the timeout.
export const OUTER_PROBE = '\x1b]10;?\x1b\\\x1b]11;?\x1b\\\x1b[?u\x1b[c';
export function parseProbe(text: string): { facts: OuterFacts; done: boolean; rest: string } {
  const facts: OuterFacts = { kitty: false };
  const fg = /\x1b\]10;(rgb:[0-9a-fA-F/]+)(?:\x07|\x1b\\)/.exec(text), bg = /\x1b\]11;(rgb:[0-9a-fA-F/]+)(?:\x07|\x1b\\)/.exec(text);
  if (fg?.[1]) facts.foreground = fg[1];
  if (bg?.[1]) facts.background = bg[1];
  facts.kitty = /\x1b\[\?\d+u/.test(text);
  const done = /\x1b\[\?[\d;]*c/.test(text);
  const rest = text.replace(/\x1b\](?:10|11);[^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[\?\d+u|\x1b\[\?[\d;]*c/g, '');
  return { facts, done, rest };
}

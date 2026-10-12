// Throwaway spike code (v0.2.1b). Fidelity test patterns: truecolor, 256 colors, 16 colors with
// every SGR attribute, wide characters and emoji, a title and a cursor shape. Waits for a key;
// Ctrl+C exits.
const out = s => process.stdout.write(s);
out('\x1b[2J\x1b[H\x1b]2;patterns title\x07\x1b[5 q');
const cols = Math.min(process.stdout.columns || 80, 120);
let line = '';
for (let x = 0; x < cols; x++) { const r = Math.round(255 * x / cols); line += `\x1b[48;2;${r};${255 - r};128m `; }
out(line + '\x1b[0m\r\n');
for (let row = 0; row < 4; row++) {
  let s = '';
  for (let i = 0; i < 64 && row * 64 + i < 256; i++) s += `\x1b[48;5;${row * 64 + i}m `;
  out(s + '\x1b[0m\r\n');
}
let sixteen = '';
for (let i = 0; i < 8; i++) sixteen += `\x1b[3${i}m F${i} \x1b[9${i}m B${i} \x1b[4${i}m  \x1b[10${i}m  \x1b[0m`;
out(sixteen + '\r\n');
const attrs = [[1, 'bold'], [2, 'dim'], [3, 'italic'], [4, 'underline'], [5, 'blink'], [7, 'inverse'], [8, 'hidden'], [9, 'strike'], [53, 'overline'], ['4:3', 'curly'], ['58;2;255;0;0;4', 'ul-color']];
out(attrs.map(([code, name]) => `\x1b[${code}m${name}\x1b[0m`).join(' ') + '\r\n');
out('CJK: 漢字かなカナ한국어 | end\r\n');
out('emoji: 🧪x 👍🏽x 👨‍👩‍👧x ❤️x 🇮🇱x ✓x é|é end\r\n');
out('box: ┌─┬─┐ │a│b│ └─┴─┘ ▁▂▃▄▅▆▇█ end\r\n');
out('\x1b]8;;https://example.com\x1b\\a hyperlink\x1b]8;;\x1b\\ end\r\n');
out('waiting for a key> ');
process.stdin.setRawMode(true);
process.stdin.on('data', data => { if (data.includes(3)) process.exit(0); out(`[${data.length}]`); });

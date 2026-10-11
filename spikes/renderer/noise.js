import { theme, rgb } from './theme.js';
let tick = 0;
function draw() {
  const rows = Math.max(2, process.stdout.rows || 20);
  const cols = Math.max(1, process.stdout.columns || 60);
  const row = 2 + (tick % (rows - 1));
  const color = tick % 2 ? theme.accent : theme['status-waiting'];
  const text = `generated ${String(tick).padStart(6, '0')} · parsing cells · 界 é`;
  process.stdout.write(`\x1b[1;1H\x1b[2K\x1b[1;38;2;${rgb(theme.ink)}mNOISE ${tick} · 30 ms\x1b[0m\x1b[${row};1H\x1b[2K\x1b[38;2;${rgb(color)}m${text.slice(0, cols - 1)}\x1b[0m`);
  tick++;
}
process.stdout.write('\x1b[2J\x1b[?25l');
draw();
setInterval(draw, 30);

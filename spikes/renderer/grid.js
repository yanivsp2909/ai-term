import { styleEscape } from './theme.js';
export function diffFrame(next, previous) {
  let output = '\x1b[?2026h';
  if (!previous) output += '\x1b[2J';
  for (let y = 0; y < next.length; y++) {
    let positioned = false, lastStyle = '';
    for (let x = 0; x < next[y].length; x++) {
      const cell = next[y][x], before = previous?.[y]?.[x];
      if (cell.width === 0) continue;
      if (before && cell.char === before.char && cell.fg === before.fg && cell.bg === before.bg && cell.bold === before.bold && cell.width === before.width) { positioned = false; continue; }
      if (!positioned) output += `\x1b[${y + 1};${x + 1}H`;
      const style = styleEscape(cell);
      if (lastStyle !== style) { output += style; lastStyle = style; }
      output += cell.char;
      positioned = true;
      if (cell.width === 2) x++;
    }
  }
  return `${output}\x1b[0m\x1b[?2026l`;
}

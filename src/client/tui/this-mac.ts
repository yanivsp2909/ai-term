import type { SystemStats } from '../../shared/protocol.js';
import type { Grid } from './grid.js';
import type { Theme } from './theme.js';
// This Mac panel (docs/design.md). Memory in binary GB/MB like Activity Monitor; network in decimal MB/s.
export const SPARKLINE_SAMPLES = 10;
const BARS = '▁▂▃▄▅▆▇█', GB = 1024 ** 3, MB = 1024 ** 2;
const percent = (value: number): string => `${Math.round(value)}%`;
const gigabytes = (bytes: number): string => (bytes / GB).toFixed(1);
const memory = (bytes: number): string => bytes >= GB ? `${gigabytes(bytes)} GB` : `${Math.round(bytes / MB)} MB`;
const rate = (bytesPerSecond: number): string => `${(bytesPerSecond / 1e6).toFixed(1)} MB/s`;
// Absolute scale (0–100%), so a quiet machine reads as quiet rather than stretched to full height.
export function sparkline(history: readonly number[]): string {
  return history.slice(-SPARKLINE_SAMPLES).map(value => BARS[Math.min(BARS.length - 1, Math.max(0, Math.floor(value / (100 / BARS.length))))] ?? '').join('');
}
export function agentUsage(stats: SystemStats | null | undefined, sessionId: string | undefined): string | null {
  const session = stats?.sessions.find(s => s.sessionId === sessionId);
  return session ? `cpu ${percent(session.cpuPercent)} · ${memory(session.rssBytes)}` : null;
}
export function drawThisMac(grid: Grid, x: number, y: number, width: number, stats: SystemStats | null | undefined, history: readonly number[], theme: Theme): void {
  const t = theme.colors, right = (row: number, text: string) => grid.text(x + width - text.length, row, text, t['ink-3'], t.bg);
  if (!stats) {
    ['CPU —             agents —', 'RAM —             agents —', 'NET ↓ —  ↑ —'].forEach((s, i) => grid.text(x, y + i, s, t['ink-3'], t.bg, false, width));
    return;
  }
  const agentsCpu = stats.sessions.reduce((sum, s) => sum + s.cpuPercent, 0), agentsRam = stats.sessions.reduce((sum, s) => sum + s.rssBytes, 0);
  const cpu = percent(stats.cpuPercent);
  grid.text(x, y, 'CPU', t['ink-3'], t.bg); grid.text(x + 4, y, cpu, t.ink, t.bg, true);
  grid.text(x + 5 + cpu.length, y, sparkline(history), t.accent, t.bg);
  right(y, `agents ${percent(agentsCpu)}`);
  grid.text(x, y + 1, 'RAM', t['ink-3'], t.bg);
  grid.text(x + 4, y + 1, `${gigabytes(stats.memUsedBytes)}/${gigabytes(stats.memTotalBytes).replace(/\.0$/, '')} GB`, t.ink, t.bg);
  right(y + 1, `agents ${memory(agentsRam)}`);
  grid.text(x, y + 2, 'NET', t['ink-3'], t.bg);
  grid.text(x + 4, y + 2, `↓ ${rate(stats.netRxBytesPerSec)}  ↑ ${rate(stats.netTxBytesPerSec)}`, t.ink, t.bg);
}

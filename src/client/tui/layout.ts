import type { SessionInfo, Status, AgentEngine } from '../../shared/protocol.js';
import { Grid, graphemes, type Frame } from './grid.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { Theme, ColorName } from './theme.js';
export interface Rect { x: number; y: number; w: number; h: number }
export function homepageLayout(cols: number, rows: number, visible = true) {
  const tiny = cols < 60 || rows < 16, compact = cols < 100 || rows < 30;
  const left = compact || !visible ? cols : 36, rightX = 38, rightW = cols - rightX;
  const previewHeight = rows - 14;
  return { tiny, compact, agents: { x: 0, y: 1, w: left, h: compact ? rows - 6 : !visible ? rows - 15 : rows - 6 },
    preview: !tiny && !compact && visible ? { x: rightX, y: 1, w: rightW, h: previewHeight } : null,
    terminal: { x: rightX + 2, y: 3, w: Math.max(2, rightW - 4), h: Math.max(1, previewHeight - 4) },
    statsY: rows - 12, statsX: visible ? rightX : 0, statsW: visible ? rightW : cols };
}
export function sortSessions(sessions: SessionInfo[]): SessionInfo[] { return [...sessions].sort((a, b) => Number(b.status === 'waiting') - Number(a.status === 'waiting') || Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id)); }
export function visibleStart(selected: number, capacity: number, start: number): number { return selected < start ? selected : selected >= start + capacity ? selected - capacity + 1 : start; }
export const commands = ['/model', '/cd', '/settings', '/login', '/theme', '/exit'];
export function filteredCommands(text: string): string[] { return commands.filter(command => command.startsWith(text.split(' ')[0] ?? '')); }
const marks: Record<Status, [string, ColorName, string]> = { starting: ['◐', 'status-running', 'starting'], running: ['◐', 'status-running', 'running'], waiting: ['●', 'status-waiting', 'waiting'], done: ['✓', 'status-done', 'to review'], idle: ['·', 'status-idle', 'idle'], exited: ['■', 'status-idle', 'exited'], error: ['✗', 'status-error', 'failed'] };
function age(session: SessionInfo, now: number): string { const minutes = Math.max(0, Math.floor((now - Date.parse(session.statusSince)) / 60000)); return minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
export interface HomepageView { cols: number; rows: number; sessions: SessionInfo[]; selectedId: string | null; input: string; note: string; warning?: string; previewVisible: boolean; cwd: string; engine?: AgentEngine; model?: string | null; now: number; listStart?: number; previewCells?: Frame; linesBack?: number; newLines?: number; copying?: boolean }
export function renderHomepage(view: HomepageView, theme: Theme): Frame {
  const { cols, rows } = view, t = theme.colors, grid = new Grid(cols, rows, theme), layout = homepageLayout(cols, rows, view.previewVisible);
  if (layout.tiny) { const label = 'make the window bigger'; grid.text(Math.floor((cols - label.length) / 2), Math.floor(rows / 2), label, t['ink-3']); return grid.cells; }
  grid.text(1, 0, 'AI Term', t.ink, t.bg, true); grid.text(8, 0, '_', t.accent);
  const counts: [string, string][] = [];
  for (const status of ['waiting', 'running', 'done', 'error'] as const) {
    const count = view.sessions.filter(s => s.status === status || status === 'running' && s.status === 'starting').length;
    if (count) { const [glyph, color, word] = marks[status]; counts.push([`${glyph} ${count} ${word}`, t[color]]); }
  }
  let countX = Math.max(12, cols - 1 - counts.reduce((n, [label]) => n + label.length + 2, -2));
  for (const [label, color] of counts) { grid.text(countX, 0, label, color); countX += label.length + 2; }
  const panel = layout.agents; grid.box(panel.x, panel.y, panel.w, panel.h, `Agents ${view.sessions.length}`);
  const sessions = sortSessions(view.sessions), capacity = Math.max(1, Math.floor((panel.h - 2) / 3)), index = sessions.findIndex(s => s.id === view.selectedId), start = visibleStart(Math.max(0, index), capacity, view.listStart ?? 0);
  for (const [i, session] of sessions.slice(start, start + capacity).entries()) {
    const y = 2 + i * 3, selected = session.id === view.selectedId, bg = selected ? t['surface-2'] : t.bg, [glyph, colorKey, word] = marks[session.status], color = t[colorKey];
    grid.fill(1, y, panel.w - 2, 3, bg);
    if (selected) for (let r = 0; r < 3; r++) grid.text(1, y + r, '▎', t.accent, bg);
    grid.text(2, y, ` ${session.engine === 'shell' ? 'SH' : session.engine === 'codex' ? 'GP' : 'CL'} `, t.ink, t['surface-2'], true);
    grid.text(2, y + 1, '    ', t.ink, t['surface-2']);
    const status = `${glyph} ${age(session, view.now)}`;
    grid.text(7, y, session.title, t.ink, bg, selected, panel.w - status.length - 9);
    grid.text(panel.w - status.length - 2, y, status, color, bg);
    grid.text(7, y + 1, session.engine === 'shell' ? 'shell' : `${session.model ?? 'CLI default'} · ${session.engine === 'codex' ? 'codex' : 'claude code'} · ${session.authMethod === 'subscription' ? 'sub' : session.authMethod === 'api-key' ? 'API key' : 'unknown'}`, t['ink-2'], bg, false, panel.w - 9);
    if (session.engine !== 'shell') { const authLabel = session.authMethod === 'subscription' ? 'sub' : session.authMethod === 'api-key' ? 'API key' : 'unknown'; grid.text(panel.w - authLabel.length - 2, y + 1, authLabel, t['ink-3'], bg); }
    const auth = session.authMethod === 'subscription' ? 'sub' : session.authMethod === 'api-key' ? 'API key' : session.engine === 'shell' ? '' : 'auth unknown';
    const detail = `${session.permission === 'dontAsk' ? "! don't ask · " : ''}${session.statusDetail === word ? word : `${word} · ${session.statusDetail}`}${auth ? ' · ' + auth : ''}`;
    grid.text(7, y + 2, detail, session.permission === 'dontAsk' ? t['status-error'] : session.status === 'error' || session.status === 'waiting' ? color : t['ink-3'], bg, false, panel.w - 9);
  }
  if (!sessions.length) grid.text(3, 3, 'No sessions yet', t['ink-3']);
  const selected = sessions.find(s => s.id === view.selectedId);
  if (layout.preview) {
    const p = layout.preview, area = layout.terminal;
    grid.box(p.x, p.y, p.w, p.h, '', t.surface);
    grid.text(p.x + 2, p.y, ` ${selected?.title ?? 'Preview'} `, t['ink-2'], t.surface, true, p.w - 23);
    const label = view.linesBack ? '◌ scrolled back' : '◉ live'; grid.text(p.x + p.w - label.length - 3, p.y, ` ${label} `, t.accent, t.surface);
    grid.text(p.x + 2, 2, selected?.engine === 'shell' ? 'shell' : selected ? `${selected.engine} · ${selected.model ?? 'CLI default'}` : 'Your agents, together in one terminal', t['ink-2'], t.surface, false, p.w - 4);
    for (let y = 0; y < area.h; y++) for (let x = 0; x < area.w; x++) { const cell = view.previewCells?.[y]?.[x]; if (cell) grid.put(area.x + x, area.y + y, cell); }
    if (!selected) { grid.text(area.x + 1, area.y + 2, 'Build with AI coding agents.', t['ink-3'], t.surface); grid.text(area.x + 1, area.y + 4, 'Type a task · ⏎ to start', t['ink-3'], t.surface); grid.text(area.x + 1, area.y + 6, 'Account logins · /model to choose', t['ink-3'], t.surface); }
    if (view.linesBack) { grid.fill(area.x, area.y, area.w, 1, t.surface); grid.text(area.x, area.y, `↑ ${view.linesBack} lines back · the agent keeps running  End follow live`, t['ink-2'], t.surface, false, area.w); }
    if (view.newLines) { grid.fill(area.x, area.y + area.h - 1, area.w, 1, t.surface); grid.text(area.x, area.y + area.h - 1, `● ${view.newLines} new lines below`, selected?.status === 'waiting' ? t['status-waiting'] : t.accent, t.surface); }
  } else if (!layout.compact) { grid.box(0, rows - 14, cols, 2, '▸ preview hidden · p'); }
  if (!layout.compact) {
    const w = layout.statsW, x = layout.statsX, macW = 36, usageW = w - macW - 2;
    grid.box(x, layout.statsY, usageW, 7, 'Usage'); grid.box(x + usageW + 2, layout.statsY, macW, 7, 'This Mac');
    ['    today week month', 'spend   —    —    —', 'tokens  —    —    —', 'budget  —    —    —', 'v0.1.8'].forEach((s, i) => grid.text(x + 2, layout.statsY + i + 1, s, t['ink-3'], t.bg, false, usageW - 4, i === 4));
    ['CPU —             agents —', 'RAM —             agents —', 'NET ↓ —  ↑ —', '', 'v0.1.8'].forEach((s, i) => grid.text(x + usageW + 4, layout.statsY + i + 1, s, t['ink-3'], t.bg, false, macW - 4, i === 4));
  }
  grid.box(0, rows - 4, cols, 3, '', t.surface); grid.text(2, rows - 3, '›', t.accent, t.surface);
  const input = graphemes(view.input); let width = textWidth(view.input);
  while (width > cols - 7) { const removed = input.shift(); if (removed) width -= textWidth(removed); }
  const end = grid.text(4, rows - 3, view.input ? input.join('') : 'What do you want to build?', view.input ? t.ink : t['ink-3'], t.surface, false, cols - 6);
  grid.text(end, rows - 3, '█', t.cursor, t.surface, false, 1);
  const hints = '↑↓ agents  ⏎ open  p preview  / commands', hintsX = cols - hints.length - 1;
  grid.text(1, rows - 1, `${view.engine ? `${view.model ?? 'CLI default'} · ${view.engine === 'codex' ? 'codex' : 'claude code'}` : 'shell'} · ${view.cwd}${view.engine ? ' · ask' : ''}`, t['ink-3'], t.bg, false, Math.max(0, hintsX - 2)); grid.text(hintsX, rows - 1, hints, t['ink-3']);
  if (view.input.startsWith('/')) {
    const choices = filteredCommands(view.input), h = choices.length + 2, y = rows - 4 - h;
    grid.box(0, y, Math.min(64, cols), h, 'Commands', t.surface);
    choices.forEach((command, i) => grid.text(3, y + 1 + i, command === '/theme' ? '/theme graphite|slate|ink|auto|light' : command, t['ink-2'], t.surface));
  }
  if (view.note) { grid.fill(0, rows - 5, cols, 1, view.copying ? t.accent : t.bg); grid.text(2, rows - 5, view.note, view.copying ? t['on-accent'] : t['ink-3'], view.copying ? t.accent : t.bg, false, cols - 4); }
  if (view.warning) { grid.fill(0, rows - 5, cols, 1, t.bg); grid.text(2, rows - 5, '✗ ' + view.warning, t['status-error'], t.bg, false, cols - 4); }
  return grid.cells;
}

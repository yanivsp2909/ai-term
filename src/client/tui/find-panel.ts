import type { FindMatch, SessionInfo } from '../../shared/protocol.js';
import { MAX_FIND_RESULTS } from '../../shared/protocol.js';
import { validateFindMatches } from '../../shared/validate.js';
import { safeText, type Frame } from './grid.js';
import type { Theme } from './theme.js';
import { overlay, type Request } from './worktree-question.js';
import { sortSessions } from './layout.js';

const NAME_W = 18;
// /find: every agent's mirror text searched by the daemon. One row per hit: agent name, then the line with the match
// highlighted. ↑↓ select, ⏎ selects that agent and scrolls its preview to the line, Esc closes.
export class FindPanel {
  private matches: FindMatch[] | null = null;
  private more = false;
  private row = 0;
  private error = '';
  constructor(readonly query: string, private readonly request: Request, private readonly sessions: () => readonly SessionInfo[], private readonly changed: () => void, private readonly close: () => void, private readonly show: (match: FindMatch) => void) {}
  async load(): Promise<void> {
    try {
      const result = await this.request({ kind: 'sessions.find', text: this.query });
      const order = sortSessions([...this.sessions()]).map(s => s.id);
      // List order, then newest first inside each agent as the daemon sent them.
      this.matches = validateFindMatches(result.matches).filter(m => order.includes(m.sessionId)).sort((a, b) => order.indexOf(a.sessionId) - order.indexOf(b.sessionId));
      this.more = result.moreMatches === true;
    } catch (error) { this.matches = []; this.error = error instanceof Error ? error.message : 'Find failed'; }
    this.changed();
  }
  key(key: string): void {
    if (key === 'escape') { this.close(); return; }
    const matches = this.matches ?? [];
    if (key === 'up' || key === 'down') { this.row = Math.max(0, Math.min(matches.length - 1, this.row + (key === 'up' ? -1 : 1))); this.changed(); return; }
    const match = matches[this.row];
    if (key === 'enter' && match) { this.close(); this.show(match); }
  }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), w = Math.min(grid.cols, 110), h = Math.max(8, grid.rows - 4), x = Math.floor((grid.cols - w) / 2), y = 1, width = w - 6, surface = theme.colors.surface;
    const matches = this.matches, capacity = Math.max(1, h - 5), start = Math.max(0, Math.min(this.row - capacity + 1, (matches?.length ?? 0) - capacity));
    const count = matches ? ` · ${matches.length}${this.more ? '+' : ''}` : '';
    grid.box(x, y, w, h, `Find “${safeText(this.query)}”${count}`, surface);
    if (!matches) grid.text(x + 3, y + 1, '· searching every agent', theme.colors['ink-3'], surface, false, width);
    else if (!matches.length) grid.text(x + 3, y + 1, this.error || 'no matches in any agent', theme.colors[this.error ? 'status-error' : 'ink-3'], surface, false, width);
    const titles = new Map(this.sessions().map(s => [s.id, s.title]));
    matches?.slice(start, start + capacity).forEach((match, i) => {
      const selected = start + i === this.row, bg = selected ? theme.colors['surface-2'] : surface, top = y + 1 + i, nameW = Math.min(NAME_W, Math.floor(width / 3));
      grid.fill(x + 1, top, w - 2, 1, bg);
      if (selected) grid.text(x + 1, top, '▎', theme.colors.accent, bg);
      grid.text(x + 3, top, titles.get(match.sessionId) ?? '', theme.colors.ink, bg, selected, nameW);
      // Before, match, after: the match in accent and bold, so it reads without color too.
      let at = grid.text(x + 4 + nameW, top, match.text.slice(0, match.start), theme.colors['ink-2'], bg, false, x + 3 + width - (x + 4 + nameW));
      at = grid.text(at, top, match.text.slice(match.start, match.start + match.length), theme.colors.accent, bg, true, x + 3 + width - at);
      grid.text(at, top, match.text.slice(match.start + match.length), theme.colors['ink-2'], bg, false, x + 3 + width - at);
    });
    if (this.more) grid.text(x + 3, y + h - 3, `showing the first ${matches?.length ?? MAX_FIND_RESULTS} · type a longer search to narrow it`, theme.colors['ink-3'], surface, false, width);
    grid.text(x + 3, y + h - 2, '↑↓ choose · ⏎ shows it in the preview · Esc closes', theme.colors['ink-3'], surface, false, width);
    return grid.cells;
  }
}

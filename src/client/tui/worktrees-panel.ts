import { homedir } from 'node:os';
import type { WorktreeView } from '../../shared/protocol.js';
import { wouldLose } from '../../shared/protocol.js';
import { validateWorktreeView } from '../../shared/validate.js';
import type { Frame } from './grid.js';
import { marks } from './agent-card.js';
import type { Theme } from './theme.js';
import { WorktreeQuestion, agentText, lossText, overlay, type Line, type Request } from './worktree-question.js';
import { sep } from 'node:path';

// Every state carries a glyph and a word; the tone only repeats what the text already says.
export function stateLine(view: WorktreeView): Line {
  const agent = agentText(view), suffix = agent ? ` · ${agent}` : '';
  if (view.refusal === 'Stop the agent first' && view.agent) { const [glyph, tone, word] = marks[view.agent.status]; return { text: `${glyph} ${word} · Stop the agent first · agent ${view.agent.title}`, tone }; }
  if (view.refusal === 'Worktree is locked') return { text: `■ Worktree is locked${view.loss && wouldLose(view.loss) ? ` · ${lossText(view.loss)}` : ''}${suffix}`, tone: 'ink-3' };
  if (view.refusal) return { text: `✗ ${view.refusal}${suffix}`, tone: 'status-error' };
  if (view.loss && wouldLose(view.loss)) return { text: `! ${lossText(view.loss)}${suffix}`, tone: 'status-waiting' };
  return { text: `✓ nothing would be lost${view.loss?.missing ? ' · folder already deleted' : ''}${suffix}`, tone: 'status-done' };
}
// /worktrees: every worktree AI Term created, including those whose agent is gone. ⏎ opens the same keep/delete question.
export class WorktreesPanel {
  private views: WorktreeView[] | null = null;
  private row = 0;
  private question?: WorktreeQuestion;
  private note = '';
  constructor(private readonly request: Request, private readonly changed: () => void, private readonly close: () => void, private readonly home = homedir()) {}
  async load(): Promise<void> {
    try {
      const list = (await this.request({ kind: 'worktrees.list' })).worktrees;
      if (!Array.isArray(list)) throw new Error('Worktrees could not load');
      this.views = list.map(validateWorktreeView);
    } catch (error) { this.views = []; this.note = error instanceof Error ? error.message : 'Worktrees could not load'; }
    this.row = Math.max(0, Math.min(this.row, this.views.length - 1)); this.changed();
  }
  async key(key: string): Promise<void> {
    if (this.question) { await this.question.key(key); return; }
    if (key === 'escape') { this.close(); return; }
    const views = this.views ?? [], view = views[this.row];
    if (key === 'up' || key === 'down') { this.row = Math.max(0, Math.min(views.length - 1, this.row + (key === 'up' ? -1 : 1))); this.changed(); return; }
    if (key !== 'enter' || !view) return;
    this.note = '';
    const question: WorktreeQuestion = new WorktreeQuestion(view.path, this.request, this.changed, note => { if (this.question === question) this.question = undefined; this.note = note; void this.load(); });
    this.question = question; await question.load();
  }
  private display(path: string): string { return path === this.home ? '~' : path.startsWith(`${this.home}${sep}`) ? `~${path.slice(this.home.length)}` : path; }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), w = Math.min(grid.cols, 110), h = Math.max(8, grid.rows - 4), x = Math.floor((grid.cols - w) / 2), y = 1;
    const views = this.views, capacity = Math.max(1, Math.floor((h - 5) / 2)), start = Math.max(0, Math.min(this.row - capacity + 1, (views?.length ?? 0) - capacity));
    grid.box(x, y, w, h, views ? `Worktrees ${views.length}` : 'Worktrees', theme.colors.surface);
    const width = w - 6, surface = theme.colors.surface;
    if (!views) grid.text(x + 3, y + 1, '· checking worktrees', theme.colors['ink-3'], surface, false, width);
    else if (!views.length) grid.text(x + 3, y + 1, 'No worktrees from AI Term', theme.colors['ink-3'], surface, false, width);
    views?.slice(Math.max(0, start), Math.max(0, start) + capacity).forEach((view, i) => {
      const index = Math.max(0, start) + i, selected = index === this.row, bg = selected ? theme.colors['surface-2'] : surface, top = y + 1 + i * 2, state = stateLine(view);
      grid.fill(x + 1, top, w - 2, 2, bg);
      if (selected) { grid.text(x + 1, top, '▎', theme.colors.accent, bg); grid.text(x + 1, top + 1, '▎', theme.colors.accent, bg); }
      grid.text(x + 3, top, `${view.branch ?? 'no branch on record'}  ${this.display(view.path)}`, theme.colors.ink, bg, selected, width);
      grid.text(x + 3, top + 1, state.text, theme.colors[state.tone], bg, false, width);
    });
    if (this.note) grid.text(x + 3, y + h - 3, this.note, theme.colors['ink-2'], surface, false, width);
    grid.text(x + 3, y + h - 2, '↑↓ choose · ⏎ keeps or deletes · Esc closes', theme.colors['ink-3'], surface, false, width);
    return this.question ? this.question.draw(grid.cells, theme) : grid.cells;
  }
}

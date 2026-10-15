import type { AgentDiff, DiffFile } from '../../shared/diff.js';
import type { Frame } from './grid.js';
import { mix, type Theme } from './theme.js';
import { overlay } from './worktree-question.js';

// v0.7.1 d / /diff: a read-only popup of what an agent changed. Files on the left (↑↓), the selected file's unified diff
// on the right (PgUp/PgDn); every line is text from the daemon, drawn as plain cells. design.md: added lines on accent at
// 16% over the surface, removed on status-error at 16%; the +/- glyph stays, so color is never the only sign.
// The review queue's choices sit in the footer: m merge, x discard (the v0.3.2 removal flow), Esc later.
export interface DiffActions { changed(): void; close(): void; merge(): void; discard(): void }
const LETTER: Record<DiffFile['status'], string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', untracked: 'U' };
const counts = (added: number, removed: number) => `${added ? `+${added}` : ''}${removed ? `${added ? ' ' : ''}−${removed}` : ''}`;
// Long paths keep their end (the file name), cut from the left.
const tail = (text: string, width: number) => [...text].length <= width ? text : '…' + [...text].slice(-(width - 1)).join('');

export class DiffView {
  private selected = 0;
  private offset = 0;
  private page = 1;
  constructor(private readonly diff: AgentDiff, private readonly actions: DiffActions) {}
  get title(): string { return this.diff.title; }
  key(key: string): void {
    const files = this.diff.files.length;
    if (key === 'escape') { this.actions.close(); return; }
    if (key === 'm') { this.actions.merge(); return; }
    if (key === 'x') { this.actions.discard(); return; }
    if ((key === 'up' || key === 'down') && files) { this.selected = (this.selected + (key === 'up' ? -1 : 1) + files) % files; this.offset = 0; this.actions.changed(); return; }
    if (key === 'page-up' || key === 'page-down') { this.offset = Math.max(0, this.offset + (key === 'page-up' ? -this.page : this.page)); this.actions.changed(); }
  }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), t = theme.colors, surface = t.surface;
    const w = Math.min(grid.cols, 160), h = Math.max(8, grid.rows - 4), x = Math.floor((grid.cols - w) / 2), y = 1;
    const d = this.diff, title = `Diff ${d.title} · ${d.branch} vs ${d.base} · ${d.files.length} file${d.files.length === 1 ? '' : 's'} ${counts(d.added, d.removed)}${d.capped ? ' · capped' : ''}`;
    grid.box(x, y, w, h, title, surface);
    const listW = Math.max(16, Math.min(40, Math.floor(w * 0.3))), bodyX = x + listW + 3, bodyW = w - listW - 5, rows = h - 3;
    this.page = Math.max(1, rows - 1);
    if (!d.files.length) grid.text(x + 2, y + 1, 'no changes since it started', t['ink-3'], surface, false, w - 4);
    // The file list scrolls to keep the selection in view.
    const first = Math.max(0, Math.min(this.selected - Math.floor(rows / 2), d.files.length - rows));
    d.files.slice(first, first + rows).forEach((file, i) => {
      const index = first + i, on = index === this.selected, bg = on ? t['surface-2'] : surface, stat = counts(file.added, file.removed);
      const name = tail(file.from ? `${file.from} → ${file.path}` : file.path, Math.max(4, listW - 5 - stat.length));
      grid.fill(x + 1, y + 1 + i, listW + 1, 1, bg);
      grid.text(x + 1, y + 1 + i, `${on ? '›' : ' '} ${LETTER[file.status]} ${name}${stat ? ` ${stat}` : ''}`, on ? t.ink : t['ink-2'], bg, on, listW + 1);
    });
    for (let r = y + 1; r < y + h - 2; r++) grid.text(x + listW + 2, r, '│', t.line, surface);
    const file = d.files[this.selected];
    if (file) {
      const added = mix(surface, t.accent, 0.16), removed = mix(surface, t['status-error'], 0.16);
      const lines = [...file.lines, ...(file.cut ? ['… the rest of this file is not shown (capped)'] : [])];
      this.offset = Math.min(this.offset, Math.max(0, lines.length - this.page));
      lines.slice(this.offset, this.offset + rows).forEach((line, i) => {
        const sign = line[0], bg = sign === '+' ? added : sign === '-' ? removed : surface, fg = sign === '@' || sign === '…' ? t['ink-3'] : sign === '+' || sign === '-' ? t.ink : t['ink-2'];
        if (bg !== surface) grid.fill(bodyX, y + 1 + i, bodyW, 1, bg);
        grid.text(bodyX, y + 1 + i, line, fg, bg, false, bodyW);
      });
    }
    grid.text(x + 2, y + h - 2, '↑↓ files · PgUp/PgDn scroll · m merge · x discard · Esc later', t['ink-3'], surface, false, w - 4);
    return grid.cells;
  }
}

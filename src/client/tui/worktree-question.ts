import { wouldLose, type SuccessResponse, type WorktreeLoss, type WorktreeView } from '../../shared/protocol.js';
import { validateWorktreeView } from '../../shared/validate.js';
import type { RequestBody } from '../connection.js';
import { Grid, type Frame } from './grid.js';
import { marks } from './agent-card.js';
import type { Theme, ColorName } from './theme.js';

export type Request = (body: RequestBody) => Promise<SuccessResponse>;
export interface Line { text: string; tone: ColorName }
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
export function lossText(loss: WorktreeLoss): string {
  const commits = plural(loss.commits, 'commit', 'commits');
  return [
    loss.changed ? plural(loss.changed, 'changed file', 'changed files') : '',
    loss.untracked ? `${loss.untracked} untracked` : '',
    loss.commits ? (loss.baseSource === 'start commit' ? `${commits} since its start (${loss.base})` : `${commits} not in ${loss.base}`) : '',
  ].filter(Boolean).join(' · ');
}
// What the user should know that is not lost work: how the base was chosen, a folder already gone, ignored files.
export function lossNotes(loss: WorktreeLoss): string[] {
  return [
    loss.repos ? `${plural(loss.repos, 'untracked folder is a git repository', 'untracked folders are git repositories')}; their history goes too` : '',
    loss.missing ? 'folder already deleted by hand; git still lists it' : '',
    loss.baseSource === 'start commit' ? 'its base branch is gone; commits counted from where it started' : '',
    loss.baseSource === 'checkout' ? `base not recorded; compared with your checkout's ${loss.base}` : '',
    loss.ignored ? `${plural(loss.ignored, 'ignored file', 'ignored files')} go with it` : '',
  ].filter(Boolean);
}
export function agentText(view: WorktreeView): string {
  if (!view.agent) return '';
  const [glyph, , word] = marks[view.agent.status];
  return `agent ${view.agent.title} · ${glyph} ${word}`;
}
export function overlay(frame: Frame, theme: Theme): Grid {
  const rows = frame.length, cols = frame[0]?.length ?? 0, grid = new Grid(cols, rows, theme);
  for (let y = 0; y < rows; y++) for (let x = 0; x < cols; x++) { const cell = frame[y]?.[x]; if (cell) grid.put(x, y, cell); }
  return grid;
}
const KEEP_KEYS = new Set(['k', 'enter']);
// One worktree's keep/delete question. Keep is the default: Esc, k or Enter keep. Clean trees delete with d; with loss
// the branch name must be typed (never pasted) and confirmed with Enter, so one keypress can never delete work.
export class WorktreeQuestion {
  private view?: WorktreeView;
  private typed = '';
  private error = '';
  private state: 'checking' | 'asking' | 'deleting' | 'done' = 'checking';
  constructor(readonly path: string, private readonly request: Request, private readonly changed: () => void, private readonly finish: (note: string) => void) {}
  private get kept(): string { return `worktree kept: ${this.path}`; }
  private get asking(): boolean { return this.state === 'asking'; }
  private end(note: string): void { this.state = 'done'; this.finish(note); }
  async load(): Promise<void> {
    this.state = 'checking'; this.changed();
    let view: WorktreeView;
    try { view = validateWorktreeView((await this.request({ kind: 'worktrees.check', path: this.path })).worktree); }
    catch (error) { this.end(`${this.kept} · ${error instanceof Error ? error.message : 'Worktree check failed'}`); return; }
    if (view.refusal || !view.loss || !view.fingerprint) { this.end(`${this.kept}${view.refusal ? ` · ${view.refusal}` : ''}`); return; }
    this.view = view; this.typed = ''; this.state = 'asking'; this.changed();
  }
  async key(key: string): Promise<void> {
    if (this.state === 'deleting' || this.state === 'done') return;
    if (key === 'escape') { this.end(this.kept); return; }
    const view = this.view;
    if (this.state !== 'asking' || !view?.loss) return;
    if (!wouldLose(view.loss)) { if (KEEP_KEYS.has(key)) this.end(this.kept); else if (key === 'd') await this.remove(view); return; }
    if (!this.typed && KEEP_KEYS.has(key)) { this.end(this.kept); return; }
    if (key === 'enter') { if (this.typed === view.branch) await this.remove(view, this.typed); else { this.error = `type ${view.branch} exactly to delete`; this.changed(); } return; }
    if (key === 'backspace') this.typed = [...this.typed].slice(0, -1).join('');
    else if ([...key].length === 1 && key >= ' ' && this.typed.length < 60) this.typed += key;
    else return;
    this.error = ''; this.changed();
  }
  private async remove(view: WorktreeView, confirm?: string): Promise<void> {
    if (!view.fingerprint) return;
    this.state = 'deleting'; this.changed();
    try {
      await this.request({ kind: 'worktrees.delete', path: this.path, fingerprint: view.fingerprint, ...(confirm ? { confirm } : {}) });
      this.end(`✓ deleted worktree and branch ${view.branch}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Worktree delete failed';
      if (message !== 'Changed since you confirmed; check again') { this.end(`${message} · ${view.branch}`); return; }
      // Show what is there now and ask again; nothing was touched.
      await this.load();
      if (this.asking) { this.error = message; this.changed(); }
    }
  }
  lines(): Line[] {
    const view = this.view, lines: Line[] = [{ text: this.path, tone: 'ink-3' }];
    if (this.state === 'checking' || !view?.loss) return [...lines, { text: '· checking what would be lost', tone: 'ink-3' }];
    if (view.agent) lines.push({ text: agentText(view), tone: 'ink-3' });
    const lossy = wouldLose(view.loss);
    lines.push(lossy ? { text: `! would be lost: ${lossText(view.loss)}`, tone: 'status-waiting' } : { text: '✓ nothing would be lost', tone: 'status-done' });
    for (const note of lossNotes(view.loss)) lines.push({ text: note, tone: 'ink-3' });
    if (this.state === 'deleting') lines.push({ text: '· deleting', tone: 'ink-3' });
    else if (lossy) lines.push({ text: `type ${view.branch} and ⏎ to delete · k or Esc keeps`, tone: 'ink' }, { text: `› ${this.typed}█`, tone: 'ink' });
    else lines.push({ text: `remove worktree and branch ${view.branch}? k keep · d delete`, tone: 'ink' });
    if (this.error) lines.push({ text: this.error, tone: 'status-error' });
    return lines;
  }
  draw(frame: Frame, theme: Theme): Frame {
    const grid = overlay(frame, theme), lines = this.lines(), w = Math.min(grid.cols, 96), h = lines.length + 2;
    const x = Math.floor((grid.cols - w) / 2), y = Math.max(1, grid.rows - 4 - h);
    grid.box(x, y, w, h, `Worktree ${this.view?.branch ?? ''}`.trim(), theme.colors.surface);
    lines.forEach((line, i) => grid.text(x + 3, y + 1 + i, line.text, theme.colors[line.tone], theme.colors.surface, false, w - 6));
    return grid.cells;
  }
}

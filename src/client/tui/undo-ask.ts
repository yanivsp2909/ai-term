import type { UndoPlan } from '../../shared/checkpoints.js';
import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { Line } from './worktree-question.js';

// v0.7.2 /undo and /redo: what will change before anything does. y restores (a typed key: a paste never reaches this
// popup), n or Esc keep everything as it is. The daemon keeps a snapshot of now first, so /redo can bring it back.
const MARK: Record<UndoPlan['changes'][number]['change'], string> = { modified: 'M', removed: '−', restored: '+' };
const time = (at: string) => { const d = new Date(at); return Number.isFinite(d.getTime()) ? `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; };
export function undoLines(plan: UndoPlan): Line[] {
  const total = plan.changes.length + plan.more, files = `${total} file${total === 1 ? '' : 's'} change${total === 1 ? 's' : ''}`;
  const head = plan.kind === 'undo' ? `Undo ${plan.title} → checkpoint ${plan.target ?? '?'}${time(plan.targetAt) ? ` (${time(plan.targetAt)})` : ''} · ${files}` : `Redo ${plan.title} → where it was before /undo · ${files}`;
  return [
    { text: head, tone: 'ink' },
    { text: 'only the agent\'s worktree changes; its branch, index and commits stay as they are', tone: 'ink-3' },
    ...plan.changes.map(change => ({ text: `${MARK[change.change]} ${change.path}`, tone: 'ink-2' as const })),
    ...(plan.more ? [{ text: `… and ${plan.more} more`, tone: 'ink-3' as const }] : []),
    { text: plan.kind === 'undo' ? 'y restores (/redo brings this back) · n or Esc keeps everything' : 'y restores · n or Esc keeps everything', tone: 'ink-3' },
  ];
}
export class UndoAsk {
  private readonly panel: TextPanel;
  constructor(plan: UndoPlan, changed: () => void, private readonly close: () => void, private readonly run: () => void) {
    this.panel = new TextPanel(plan.kind === 'undo' ? 'Undo' : 'Redo', changed, close);
    this.panel.set(undoLines(plan));
  }
  key(key: string): void {
    if (key === 'y') { this.close(); this.run(); return; }
    if (key === 'n') { this.close(); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

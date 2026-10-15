import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import { limitFields, queueLines, type QueueItem, type QueueLimit, type QueueRequest, type QueueTrigger } from '../../shared/queue.js';

// v0.9.1 /queue: each waiting agent with its trigger, limit, engine, folder and mode (Don't ask in red), and what became of
// it. ↑↓ choose, x removes, Esc closes.
export class QueuePanel {
  private items: QueueItem[] = [];
  private choice = 0;
  private note = '';
  private readonly panel: TextPanel;
  constructor(private readonly changed: () => void, private readonly close: () => void, private readonly remove: (id: string) => Promise<QueueItem[]>, private readonly enabled: boolean) {
    this.panel = new TextPanel('Queue', changed, close);
  }
  set(items: readonly QueueItem[]): void { this.items = [...items]; this.choice = Math.min(this.choice, Math.max(0, items.length - 1)); this.render(); }
  key(key: string): void {
    if (key === 'up' || key === 'down') { this.choice = Math.max(0, Math.min(this.items.length - 1, this.choice + (key === 'up' ? -1 : 1))); this.render(); return; }
    if (key === 'x') {
      const item = this.items[this.choice]; if (!item) return;
      void this.remove(item.id).then(items => { this.note = '✓ removed from the queue'; this.set(items); }, (error: unknown) => { this.note = `✗ ${error instanceof Error ? error.message : 'not removed'}`; this.render(); });
      return;
    }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
  private render(): void {
    const rows = queueLines(this.items).map((line, i) => ({ text: `${i === this.choice ? '›' : ' '} ${line.text}`, tone: line.tone }));
    this.panel.set([
      { text: 'Agents that start after an agent finishes, or at a time; each stops at its limit', tone: 'ink-3' },
      ...this.enabled ? [] : [{ text: 'the queue is off · nothing starts · turn it on in /settings (b)', tone: 'status-waiting' as const }],
      ...rows.length ? rows : [{ text: 'nothing queued · /queue add sets one up from the start box', tone: 'ink-3' as const }],
      ...this.note ? [{ text: this.note, tone: this.note.startsWith('✗') ? 'status-error' as const : 'ink-3' as const }] : [],
      { text: '↑↓ choose · x removes · Esc closes', tone: 'ink-3' },
    ]);
  }
}

// Typed answers: "after fixer", "at 21:30" (or "21:30"); "20 turns $3", "$2", "until 23:00" (or "23:00").
export function parseTrigger(text: string): QueueTrigger | null {
  const after = text.trim().match(/^after\s+(.{1,60})$/i);
  if (after?.[1]) return { kind: 'after', agent: after[1].trim() };
  const at = text.trim().match(/^(?:at\s+)?(\d{1,2}):(\d{2})$/i);
  if (at && Number(at[1]) < 24 && Number(at[2]) < 60) return { kind: 'at', time: `${String(at[1]).padStart(2, '0')}:${at[2]}` };
  return null;
}
export function parseLimit(text: string, request: Pick<QueueRequest, 'engine' | 'auth'>): QueueLimit | null {
  const needed = limitFields(request.engine, request.auth.kind), limit: QueueLimit = {};
  const turns = text.match(/(\d{1,4})\s*turns?\b/i), usd = text.match(/\$\s*(\d+(?:\.\d{1,2})?)/), until = text.match(/(?:until\s+)?\b(\d{1,2}):(\d{2})\b/i);
  if (needed.includes('turns') && turns?.[1]) limit.turns = Number(turns[1]);
  if (needed.includes('usd') && usd?.[1]) limit.usd = Number(usd[1]);
  if (needed.includes('until') && until && Number(until[1]) < 24 && Number(until[2]) < 60) limit.until = `${String(until[1]).padStart(2, '0')}:${until[2]}`;
  return needed.every(field => limit[field] !== undefined) ? limit : null;
}
export function limitHint(request: Pick<QueueRequest, 'engine' | 'auth'>): string {
  const needed = limitFields(request.engine, request.auth.kind);
  return needed.includes('turns') ? 'a turn cap and a $ budget, like 20 turns $3' : needed.includes('usd') ? 'a $ budget, like $2' : 'a stop time, like until 23:00';
}
// The two questions after the start box: when it starts, then its limit. ⏎ goes on, Esc goes back to the start box.
export class QueueForm {
  private step: 'trigger' | 'limit' = 'trigger';
  private buffer = '';
  private error = '';
  private trigger: QueueTrigger | null = null;
  private readonly panel: TextPanel;
  constructor(private readonly request: QueueRequest, private readonly agents: readonly string[], changed: () => void, private readonly back: () => void, private readonly submit: (trigger: QueueTrigger, limit: QueueLimit) => Promise<string | null>) {
    this.panel = new TextPanel('Queue this agent', changed, back);
    this.render();
  }
  key(key: string): void {
    if (key === 'escape') { if (this.step === 'limit') { this.step = 'trigger'; this.buffer = ''; this.error = ''; this.render(); return; } this.back(); return; }
    if (key === 'backspace') { this.buffer = [...this.buffer].slice(0, -1).join(''); this.render(); return; }
    if (key === 'enter') { void this.next(); return; }
    if ([...key].length === 1 && !/[\p{C}]/u.test(key) && this.buffer.length < 80) { this.buffer += key; this.error = ''; this.render(); }
  }
  type(text: string): void { const clean = [...text].filter(char => !/[\p{C}]/u.test(char)).join(''); this.buffer = (this.buffer + clean).slice(0, 80); this.error = ''; this.render(); }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
  private async next(): Promise<void> {
    if (this.step === 'trigger') {
      const trigger = parseTrigger(this.buffer);
      if (!trigger) { this.error = 'type after <agent> or at HH:MM'; this.render(); return; }
      this.trigger = trigger; this.step = 'limit'; this.buffer = ''; this.error = ''; this.render(); return;
    }
    const limit = parseLimit(this.buffer, this.request);
    if (!limit || !this.trigger) { this.error = `it needs ${limitHint(this.request)}`; this.render(); return; }
    const failed = await this.submit(this.trigger, limit);
    if (failed) { this.error = failed; this.render(); }
  }
  private render(): void {
    const agents = this.agents.length ? ` (now: ${this.agents.slice(0, 5).join(', ')})` : '';
    this.panel.set([
      this.step === 'trigger' ? { text: `When does it start? after <agent>${agents}, or at HH:MM`, tone: 'ink' } : { text: `Its limit: ${limitHint(this.request)}`, tone: 'ink' },
      { text: `› ${this.buffer}█`, tone: 'ink' },
      ...this.error ? [{ text: `✗ ${this.error}`, tone: 'status-error' as const }] : [],
      { text: this.step === 'trigger' ? '⏎ next · Esc back to the start box' : '⏎ queues it · Esc back', tone: 'ink-3' },
      ...this.request.permission === 'dontAsk' ? [{ text: "! don't ask · it will run without asking", tone: 'status-error' as const }] : [],
    ]);
  }
}

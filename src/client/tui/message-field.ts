import { isFirstMessage, MAX_FIRST_MESSAGE_BYTES } from '../../shared/validate.js';
import { graphemes, safeText } from './grid.js';

// One grapheme of typed text, or a whole paste token. Positions count units, so a token can never be cut in half.
type Unit = string | { text: string; lines: number };
export const FIRST_MESSAGE_TOO_LONG = 'too long for a first message (16 KB): start the agent, then paste inside';
// What the command bar draws: each unit's label, the caret before units[caret], the selected [start, end) range,
// and optionally the first unit on screen (the homepage keeps it between draws).
export interface FieldView { units: string[]; caret: number; selection: [number, number] | null; start?: number }
const unitText = (unit: Unit): string => typeof unit === 'string' ? unit : unit.text;
const isSpace = (unit: Unit | undefined): boolean => typeof unit === 'string' && /^\s$/u.test(unit);

// Token metadata stays with the draft through confirmation/pickers; only expanded text goes to the daemon.
export class MessageField {
  private units: Unit[] = [];
  private caret = 0;
  // The fixed end of a selection; the caret is its moving end.
  private anchor: number | null = null;
  get text(): string { return this.units.map(unitText).join(''); }
  set text(text: string) { this.units = graphemes(text); this.caret = this.units.length; this.anchor = null; }
  get hasPastes(): boolean { return this.units.some(u => typeof u !== 'string'); }
  get selection(): [number, number] | null { return this.anchor === null || this.anchor === this.caret ? null : [Math.min(this.anchor, this.caret), Math.max(this.anchor, this.caret)]; }
  copy(): MessageField { const field = new MessageField(); field.restore(this); return field; }
  restore(field: MessageField): void { this.units = field.units.map(u => typeof u === 'string' ? u : { ...u }); this.caret = field.caret; this.anchor = field.anchor; }
  private label(unit: Unit, firstLine: boolean): string {
    return typeof unit === 'string' ? unit : `[pasted · ${unit.lines} lines]${firstLine ? ' ' + safeText(unit.text.split(/\r\n|\r|\n/, 1)[0] ?? '') : ''}`;
  }
  display(firstLine = false): string { return this.units.map(u => this.label(u, firstLine)).join(''); }
  view(): FieldView { return { units: this.units.map(u => this.label(u, false)), caret: this.caret, selection: this.selection }; }
  // Replaces the selection (or inserts at the caret) and leaves the caret after the new units.
  private replace(units: Unit[]): void {
    const [start, end] = this.selection ?? [this.caret, this.caret];
    this.units = [...this.units.slice(0, start), ...units, ...this.units.slice(end)]; this.caret = start + units.length; this.anchor = null;
  }
  private insert(text: string, token: boolean): string | undefined {
    const [start, end] = this.selection ?? [this.caret, this.caret], replaced = this.units.slice(start, end).map(unitText).join('');
    if (Buffer.byteLength(this.text) - Buffer.byteLength(replaced) + Buffer.byteLength(text) > MAX_FIRST_MESSAGE_BYTES) return FIRST_MESSAGE_TOO_LONG;
    if (!isFirstMessage(text)) return 'First message cannot contain NUL';
    if (!text) return;
    this.replace(token ? [{ text, lines: text.split(/\r\n|\r|\n/).length }] : graphemes(text));
  }
  paste(text: string): string | undefined {
    const token = /[\r\n]/.test(text) || [...text].length > 200;
    return this.insert(token ? text : safeText(text.replace(/\t/g, ' ')), token);
  }
  type(text: string): string | undefined { return this.insert(safeText(text), false); }
  private removeTo(position: number): void { this.anchor = position; this.replace([]); }
  backspace(): void { if (this.selection) this.replace([]); else if (this.caret > 0) this.removeTo(this.caret - 1); }
  deleteForward(): void { if (this.selection) this.replace([]); else if (this.caret < this.units.length) this.removeTo(this.caret + 1); }
  // Spaces, then one word, in the direction of travel; a paste token counts as one word.
  private wordEdge(delta: -1 | 1): number {
    const unit = (i: number) => this.units[delta < 0 ? i - 1 : i], inside = (i: number) => delta < 0 ? i > 0 : i < this.units.length;
    let i = this.caret;
    while (inside(i) && isSpace(unit(i))) i += delta;
    if (inside(i) && typeof unit(i) !== 'string') return i + delta;
    while (inside(i) && typeof unit(i) === 'string' && !isSpace(unit(i))) i += delta;
    return i;
  }
  deleteWord(): void { if (this.selection) this.replace([]); else this.removeTo(this.wordEdge(-1)); }
  clear(): void { this.units = []; this.caret = 0; this.anchor = null; }
  clearSelection(): void { this.anchor = null; }
  private moveTo(position: number, extend: boolean): void {
    if (extend) this.anchor ??= this.caret; else this.anchor = null;
    this.caret = Math.max(0, Math.min(this.units.length, position));
  }
  // Shift extends from the caret; a plain arrow collapses a selection to its edge, as text fields do.
  move(delta: -1 | 1, extend: boolean): void {
    const selection = this.selection;
    if (!extend && selection) { this.anchor = null; this.caret = delta < 0 ? selection[0] : selection[1]; return; }
    this.moveTo(this.caret + delta, extend);
  }
  moveWord(delta: -1 | 1): void { this.moveTo(this.wordEdge(delta), false); }
  moveToEnd(end: boolean): void { this.moveTo(end ? this.units.length : 0, false); }
  select(anchor: number, caret: number): void {
    const clamp = (n: number) => Math.max(0, Math.min(this.units.length, n));
    this.anchor = clamp(anchor); this.caret = clamp(caret);
  }
}

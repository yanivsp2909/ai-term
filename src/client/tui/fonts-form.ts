import { CHROME_SIZES, FONT_NAME_RULE, TERMINAL_SIZES, fontStacks, isFontFamily, type AppFonts } from '../../shared/app-fonts.js';

// v1.2.6 /settings → app fonts (F): the AI Term app's terminal and chrome fonts, their sizes and ligatures. A terminal
// running ai keeps its own font, so this form says it is for the app. ↑↓ fields, typing edits a family (empty is the
// default chain), ←→ steps a size, Space toggles ligatures on its row, ⏎ saves and goes back, Esc goes back unsaved.
export interface FontsFormActions { save(fonts: AppFonts): Promise<void>; back(): void; changed(): void }
const ROWS = ['terminal', 'terminalSize', 'chrome', 'chromeSize', 'ligatures'] as const;
const MAX_NAME = 48;
export class FontsForm {
  private row = 0;
  private terminal: string; private chrome: string;
  private terminalSize: number; private chromeSize: number; private ligatures: boolean;
  private message = '';
  constructor(current: AppFonts | undefined, private readonly actions: FontsFormActions) {
    const stacks = fontStacks(current);
    this.terminal = current?.terminal ?? ''; this.chrome = current?.chrome ?? '';
    this.terminalSize = stacks.terminalSize; this.chromeSize = stacks.chromeSize; this.ligatures = stacks.ligatures;
  }
  async key(key: string): Promise<void> {
    const field = ROWS[this.row];
    if (key === 'escape') { this.actions.back(); return; }
    if (key === 'enter') { await this.save(); return; }
    if (key === 'up' || key === 'down') this.row = Math.max(0, Math.min(ROWS.length - 1, this.row + (key === 'up' ? -1 : 1)));
    else if ((key === 'left' || key === 'right') && (field === 'terminalSize' || field === 'chromeSize')) {
      const range = field === 'terminalSize' ? TERMINAL_SIZES : CHROME_SIZES, step = key === 'left' ? -1 : 1;
      this[field] = Math.max(range.min, Math.min(range.max, this[field] + step));
    } else if (field === 'ligatures' && (key === 'space' || key === ' ')) this.ligatures = !this.ligatures;
    else if (field === 'terminal' || field === 'chrome') {
      if (key === 'backspace') this[field] = [...this[field]].slice(0, -1).join('');
      else { const ch = key === 'space' ? ' ' : key; if ([...ch].length === 1 && this[field].length < MAX_NAME) this[field] += ch; }
    }
    this.message = ''; this.actions.changed();
  }
  private async save(): Promise<void> {
    const terminal = this.terminal.trim(), chrome = this.chrome.trim();
    if (terminal && !isFontFamily(terminal) || chrome && !isFontFamily(chrome)) { this.message = FONT_NAME_RULE; this.actions.changed(); return; }
    const fonts: AppFonts = { ...(terminal ? { terminal } : {}), terminalSize: this.terminalSize, ...(chrome ? { chrome } : {}), chromeSize: this.chromeSize, ligatures: this.ligatures };
    try { await this.actions.save(fonts); this.actions.back(); }
    catch (error) { this.message = `fonts not saved · ${error instanceof Error ? error.message.slice(0, 80) : 'no answer'}`; this.actions.changed(); }
  }
  lines(): string[] {
    const mark = (i: number) => i === this.row ? '›' : ' ', cursor = (i: number) => i === this.row ? '█' : '';
    return [
      'App fonts · the AI Term app only; a terminal keeps its own font',
      `${mark(0)} terminal font: ${this.terminal || (this.row === 0 ? '' : 'default')}${cursor(0)}`,
      `${mark(1)} terminal size: ${this.terminalSize} · ←→`,
      `${mark(2)} chrome font: ${this.chrome || (this.row === 2 ? '' : 'default')}${cursor(2)}`,
      `${mark(3)} chrome size: ${this.chromeSize} · ←→`,
      `${mark(4)} ligatures: ${this.ligatures ? 'on' : 'off'} · Space · needs a font that has them`,
      ...(this.message ? [this.message] : []),
      '↑↓ field · type a family (empty: default) · ⏎ saves · Esc goes back',
    ];
  }
}

import { channels, type ColorName, type Theme } from '../client/tui/theme.js';
import { textWidth } from '../shared/unicode-width.js';
import { plain } from './display.js';
import type { ToolName } from './agent.js';

export interface Output { write(text: string): unknown; columns?: number }

// The agent's terminal is a scrolling transcript in the normal screen, so the daemon's mirror, the homepage preview and
// /find read it as plain text. Colors come from the design tokens (theme.ts); body text keeps the terminal's own color so
// it reads on light and dark backgrounds. Every status has a glyph and a word; nothing animates or redraws in place
// except the one prompt line.
export class Screen {
  private atLineStart = true;
  private promptShown = false;
  constructor(private readonly out: Output, private readonly theme: Theme) {}
  paint(color: ColorName, text: string, bold = false): string {
    const [r, g, b] = channels(this.theme.colors[color]);
    return `${bold ? '\x1b[1m' : ''}\x1b[38;2;${r};${g};${b}m${text}\x1b[39m${bold ? '\x1b[22m' : ''}`;
  }
  private get width(): number { return Math.max(20, this.out.columns ?? 80); }
  private raw(text: string): void { if (!text) return; this.out.write(text); this.atLineStart = text.endsWith('\n'); }
  // Starts a fresh line for a row, clearing the prompt if it is up.
  private line(text: string): void { this.hidePrompt(); if (!this.atLineStart) this.raw('\n'); this.raw(text + '\n'); }
  hidePrompt(): void { if (this.promptShown) { this.out.write('\r\x1b[2K'); this.promptShown = false; this.atLineStart = true; } }

  banner(model: string, root: string, permission: 'ask' | 'dontAsk', files: string[]): void {
    this.line(`${this.paint('accent', 'AI Term agent', true)} ${this.paint('ink-3', `· ${model} · ${root}`)}`);
    if (permission === 'dontAsk') this.line(this.paint('status-error', "! don't ask · writes, edits and commands run without asking", true));
    else this.line(this.paint('ink-3', 'ask · every write, edit and command waits for your y or n'));
    if (files.length) this.line(this.paint('ink-3', `· read ${files.join(', ')}`));
    this.line(this.paint('ink-3', '/help · Esc interrupts · Ctrl+C twice quits'));
  }
  user(text: string): void { this.line(''); for (const [i, row] of plain(text).split('\n').entries()) this.line(`${this.paint('accent', i ? '  ' : '› ')}${row}`); }
  working(): void { this.line(this.paint('ink-3', '◐ working · Esc interrupts')); }
  text(delta: string): void { this.hidePrompt(); this.raw(plain(delta)); }
  toolStart(tool: ToolName, summary: string): void { this.line(this.paint('ink-3', `· ${tool} ${this.fit(plain(summary).split('\n')[0] ?? '', tool.length + 3)}`)); }
  toolEnd(_tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void {
    const shown = this.fit(plain(summary).split('\n')[0] ?? '', 4);
    this.line(outcome === 'ok' ? this.paint('ink-3', `  ✓ ${shown}`) : this.paint(outcome === 'denied' ? 'status-waiting' : 'status-error', `  ✗ ${outcome === 'denied' ? 'denied' : shown}`));
  }
  // The body was made visible (display.ts visible()) by the tool: escapes and invisible characters show as markers.
  approval(title: string, body: string): void {
    this.line(this.paint('status-waiting', `● allow ${title}?`, true));
    for (const row of body.split('\n')) this.line(this.paint(row.startsWith('- ') ? 'status-error' : row.startsWith('+ ') ? 'status-done' : 'ink-2', `  ${row}`));
    this.line(this.paint('ink-3', '  y allow · n deny · Esc deny and stop'));
  }
  answered(allowed: boolean): void { this.line(allowed ? this.paint('ink-3', '  ✓ allowed') : this.paint('status-waiting', '  ✗ denied')); }
  note(text: string, tone: 'info' | 'error' = 'info'): void { this.line(tone === 'error' ? this.paint('status-error', `✗ ${plain(text)}`) : this.paint('ink-3', `· ${plain(text)}`)); }
  turnEnd(result: 'done' | 'interrupted' | 'failed'): void { if (result === 'interrupted') this.line(this.paint('status-waiting', '■ interrupted')); }
  prompt(buffer: string): void {
    const shown = plain(buffer).replace(/\n/g, ' ⏎ '), room = this.width - 3;
    let tail = shown;
    while (textWidth(tail) > room) tail = [...tail].slice(1).join('');
    if (!this.atLineStart && !this.promptShown) this.raw('\n');
    this.out.write(`\r\x1b[2K${this.paint('accent', '› ')}${tail}`); this.promptShown = true; this.atLineStart = false;
  }
  private fit(text: string, used: number): string { const room = this.width - used - 1; if (textWidth(text) <= room) return text; let cut = text; while (textWidth(cut) > room - 1) cut = [...cut].slice(0, -1).join(''); return cut + '…'; }
}

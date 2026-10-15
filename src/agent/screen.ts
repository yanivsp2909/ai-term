import { diffFrame, type Frame } from '../client/tui/grid.js';
import type { ExtensionsPanel } from '../client/tui/extensions-panel.js';
import { channels, type ColorName, type Theme } from '../client/tui/theme.js';
import { textWidth } from '../shared/unicode-width.js';
import { plain } from './display.js';
import type { ToolName } from './agent.js';

export interface Output { write(text: string): unknown; columns?: number; rows?: number }

// The agent's terminal is a scrolling transcript in the normal screen, so the daemon's mirror, the homepage preview and
// /find read it as plain text. Colors come from the design tokens (theme.ts); body text keeps the terminal's own color so
// it reads on light and dark backgrounds. Every status has a glyph and a word; nothing animates or redraws in place
// except the one prompt line.
export class Screen {
  private atLineStart = true;
  private promptShown = false;
  private popupFrame: Frame | null = null;
  private popupShown = false;
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
    this.line(`${this.paint('accent', 'AI Term agent', true)} ${this.paint('ink-3', `· ${plain(model)} · ${plain(root)}`)}`);
    if (permission === 'dontAsk') this.line(this.paint('status-error', "! don't ask · writes, edits and commands run without asking", true));
    else this.line(this.paint('ink-3', 'ask · every write, edit and command waits for your y or n'));
    if (files.length) this.line(this.paint('ink-3', `· read ${plain(files.join(', '))}`));
    this.line(this.paint('ink-3', '/help · Esc interrupts · Ctrl+C twice quits'));
  }
  extensionsBanner(count:number,tokens:number):void { this.note(`extensions: ${count} on · ≈${tokens} tokens/request · /skills /agents`); }
  popup(panel:ExtensionsPanel):void {
    this.hidePrompt();if(!this.popupShown){this.out.write('\x1b[?1049h\x1b[?25l');this.popupShown=true;this.popupFrame=null;}
    const frame=panel.blank(this.theme,this.width,Math.max(8,this.out.rows??24));this.out.write(diffFrame(frame,this.popupFrame,this.theme));this.popupFrame=frame;
  }
  closePopup():void {if(!this.popupShown)return;this.out.write('\x1b[?1049l\x1b[?25h');this.popupShown=false;this.popupFrame=null;}
  user(text: string): void { this.line(''); for (const [i, row] of plain(text).split('\n').entries()) this.line(`${this.paint('accent', i ? '  ' : '› ')}${row}`); }
  working(): void { this.line(this.paint('ink-3', '◐ working · Esc interrupts')); }
  text(delta: string): void { this.hidePrompt(); this.raw(plain(delta)); }
  toolStart(tool: ToolName, summary: string): void { this.line(this.paint('ink-3', `· ${tool} ${this.fit(plain(summary).split('\n')[0] ?? '', tool.length + 3)}`)); }
  toolEnd(_tool: ToolName, outcome: 'ok' | 'denied' | 'failed', summary: string): void {
    const shown = this.fit(plain(summary).split('\n')[0] ?? '', 4);
    this.line(outcome === 'ok' ? this.paint('ink-3', `  ✓ ${shown}`) : this.paint(outcome === 'denied' ? 'status-waiting' : 'status-error', `  ✗ ${outcome === 'denied' ? 'denied' : shown}`));
  }
  // An approval must never ask for y while part of what runs has scrolled off the screen, so its body is cut into
  // screen rows (long lines wrap here, by cell width) and then into pages that fit with the question and the key line.
  // The body was made visible (display.ts visible()) by the tool: escapes and invisible characters show as markers.
  approvalPages(body: string): string[][] {
    const room = this.width - 3, rows: string[] = [];
    for (const line of body.split('\n')) {
      let rest = [...line];
      do { let take = 0, used = 0; while (take < rest.length && used + textWidth(rest[take] ?? '') <= room) used += textWidth(rest[take++] ?? ''); if (take === 0) take = 1; rows.push(rest.slice(0, take).join('')); rest = rest.slice(take); } while (rest.length);
    }
    const size = Math.max(3, (this.out.rows ?? 24) - 4), pages: string[][] = [];
    for (let i = 0; i < rows.length; i += size) pages.push(rows.slice(i, i + size));
    return pages.length ? pages : [[]];
  }
  approvalPage(title: string, pages: string[][], index: number, job=false,mcp=false): void {
    const last = index === pages.length - 1, page = pages.length > 1 ? ` · page ${index + 1} of ${pages.length}` : '';
    this.line(this.paint('status-waiting', `● allow ${title}?${page}`, true));
    for (const row of pages[index] ?? []) this.line(this.paint(row.startsWith('- ') ? 'status-error' : row.startsWith('+ ') ? 'status-done' : 'ink-2', `  ${row}`));
    this.line(this.paint('ink-3', last ? job ? '  ⏎ run job · Esc cancel' : mcp?'  y allow · a allow this tool for this session · n deny · Esc deny and stop':'  y allow · n deny · Esc deny and stop' : job ? '  space shows more · Esc cancel · ⏎ works on the last page' : '  space shows more · n deny · Esc deny and stop · y works on the last page'));
  }
  answered(allowed: boolean): void { this.line(allowed ? this.paint('ink-3', '  ✓ allowed') : this.paint('status-waiting', '  ✗ denied')); }
  note(text: string, tone: 'info' | 'warn' | 'error' = 'info'): void { this.line(tone === 'error' ? this.paint('status-error', `✗ ${plain(text)}`) : tone === 'warn' ? this.paint('status-waiting', `● ${plain(text)}`) : this.paint('ink-3', `· ${plain(text)}`)); }
  // B28: a question at a pause (its answer is typed on the prompt line) and its key line.
  ask(text: string): void { this.line(this.paint('status-waiting', `● ${plain(text)}`, true)); }
  hint(text: string): void { this.line(this.paint('ink-3', `  ${plain(text)}`)); }
  pause(text: string): void { this.line(this.paint('status-waiting', `● paused · ${plain(text)}`, true)); }
  resumed(go: boolean): void { this.line(go ? this.paint('ink-3', '  ✓ going on') : this.paint('status-waiting', '  ■ stopped')); }
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

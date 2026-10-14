import headless from '@xterm/headless';
import type { SessionInfo } from '../shared/protocol.js';
import { useUnicode11 } from '../shared/unicode-width.js';
import { BodyRenderer } from './mirror-render.js';
import { installPassthrough, type OuterFacts, type Passthrough } from './passthrough.js';
import type { Rect } from './split-layout.js';
import type { PaneMouse } from './split-mouse.js';

// Flood cap: a pane's mirror parses at most SLICE bytes per turn of the event loop, so a pane printing as fast as it can
// never holds the loop long enough to delay another pane's typing echo. Past HIGH queued bytes its socket is paused
// (the daemon then pauses that agent's PTY, §5 flow control) until the queue drops below LOW.
const SLICE = 8 * 1024, HIGH = 1024 * 1024, LOW = 256 * 1024;
// An agent's own synchronized-output block holds its pane's frames at most this long (as in SessionScreen).
const SYNC_WAIT_MS = 150;
export interface PaneFlow { pause(): void; resume(): void }
export type PaneState = 'live' | 'exited' | 'elsewhere';
// One split pane: a client-side mirror of its agent, drawn from cells only (S15), and the state its header shows.
export class Pane {
  readonly terminal: headless.Terminal;
  readonly passthrough: Passthrough;
  private renderer: BodyRenderer;
  state: PaneState = 'live';
  private isFocused = false;
  // Byte counts: queued so far, fully parsed, where the slice being parsed starts, and how many had arrived when the pane
  // last took focus. Only output that arrived after that point is the focused pane's own and may reach the terminal
  // live; the backlog printed while it was in the background stays cells only (S15), and once it is parsed the pane's
  // modes and title are replayed, so the terminal ends up as the agent left it.
  private received = 0;
  private parsedBytes = 0;
  private sliceStart = 0;
  private passFrom = 0;
  private restorePending = false;
  lastFrame = -Infinity;
  timer: ReturnType<typeof setTimeout> | undefined;
  // The pending timer waits out the agent's synchronized-output block rather than frame spacing.
  holding = false;
  private queue: Buffer[] = [];
  private queued = 0;
  private parsing = false;
  private paused = false;
  private disposed = false;
  private syncSince: number | null = null;
  constructor(readonly id: string, public info: SessionInfo, public rect: Rect, facts: OuterFacts, private readonly out: (data: string) => void, private readonly send: (data: Buffer) => void, private readonly flow: PaneFlow, private readonly changed: (pane: Pane) => void, private readonly failed: (error: Error) => void) {
    this.terminal = new headless.Terminal({ cols: rect.w, rows: rect.h - 1, scrollback: 0, allowProposedApi: true, windowOptions: { getWinSizeChars: true, pushTitle: true, popTitle: true } });
    useUnicode11(this.terminal);
    // Only the focused pane may change the real terminal's modes, title or clipboard; the others stay cells (S15).
    this.passthrough = installPassthrough(this.terminal, facts, data => { if (this.isFocused && this.sliceStart >= this.passFrom) out(data); }, data => this.reply(data), true);
    this.terminal.onData(data => this.reply(data));
    this.renderer = new BodyRenderer(this.terminal, rect.y + 1, rect.x);
  }
  // terminal.input('', true) fires onData(''); an empty frame is no reply.
  private reply(data: string): void { if (data && this.state === 'live') this.send(Buffer.from(data)); }
  get live(): boolean { return this.state === 'live'; }
  get focused(): boolean { return this.isFocused; }
  set focused(on: boolean) {
    if (on && !this.isFocused) { this.passFrom = this.received; this.restorePending = this.parsedBytes < this.received; }
    if (!on) this.restorePending = false;
    this.isFocused = on;
  }
  write(data: string | Buffer): void {
    if (this.disposed) return;
    const bytes = typeof data === 'string' ? Buffer.from(data) : data;
    if (!bytes.length) return;
    this.queue.push(bytes); this.queued += bytes.length; this.received += bytes.length;
    if (!this.paused && this.queued > HIGH) { this.paused = true; this.flow.pause(); }
    this.parse();
  }
  // Typed keys make the mirror parse the agent's next output in the same tick, so the echo can be drawn at once.
  input(): void { this.terminal.input('', true); }
  private parse(): void {
    if (this.parsing || this.disposed) return;
    const first = this.queue[0];
    if (!first) return;
    const slice = first.length > SLICE ? first.subarray(0, SLICE) : first;
    if (slice === first) this.queue.shift(); else this.queue[0] = first.subarray(SLICE);
    this.parsing = true; this.sliceStart = this.parsedBytes;
    this.terminal.write(slice, () => {
      this.parsing = false; this.queued -= slice.length; this.parsedBytes += slice.length;
      if (this.disposed) return;
      if (this.restorePending && this.isFocused && this.parsedBytes >= this.passFrom) { this.restorePending = false; this.out(this.passthrough.restore()); }
      if (this.paused && this.queued < LOW) { this.paused = false; this.flow.resume(); }
      try { this.changed(this); } catch (error) { this.failed(error instanceof Error ? error : new Error('Pane render failed')); }
      // setImmediate runs after pending I/O, so typed keys and the focused pane's echo get in between slices.
      if (this.queue.length) setImmediate(() => this.parse());
    });
  }
  // How long the agent's synchronized-output block has left to hold this pane's frames; 0 when it doesn't.
  syncWait(now: number): number {
    if (!this.terminal.modes.synchronizedOutputMode) { this.syncSince = null; return 0; }
    this.syncSince ??= now;
    return Math.max(0, SYNC_WAIT_MS - (now - this.syncSince));
  }
  mouse(): PaneMouse { return { tracking: this.terminal.modes.mouseTrackingMode, encoding: this.passthrough.mouse().encoding }; }
  // Changed cells only; the split puts the real cursor back on the focused pane afterwards.
  paint(): string { return this.renderer.paint(); }
  cursor(): string { this.renderer.cursorVisible = this.live && this.passthrough.cursorVisible(); return this.renderer.cursorAt(); }
  invalidate(): void { this.renderer.invalidate(); }
  resize(rect: Rect): void {
    this.rect = rect;
    if (this.terminal.cols !== rect.w || this.terminal.rows !== rect.h - 1) this.terminal.resize(rect.w, rect.h - 1);
    this.renderer = new BodyRenderer(this.terminal, rect.y + 1, rect.x);
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true; if (this.timer) clearTimeout(this.timer);
    if (this.paused) { this.paused = false; this.flow.resume(); }
    this.terminal.dispose();
  }
}

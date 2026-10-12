import { EventEmitter } from 'node:events';
import { homedir } from 'node:os';
import type { RequestBody } from '../connection.js';
import { attach, type AttachReason } from '../attach.js';
import { RESET_MODES } from '../terminal-modes.js';
import type { SessionInfo, SuccessResponse } from '../../shared/protocol.js';
import { isSize, isUUID, validateSession, validateSettings, validateSuccess, isThemeName, warningText } from '../../shared/validate.js';
import { redact } from '../../daemon/log.js';
import { CommandField, InputParser, type InputEvent } from './keys.js';
import { Preview, type Point } from './preview.js';
import { copyText } from './clipboard.js';
import { BACKGROUND_QUERY, BackgroundReplies, createTheme, type Theme } from './theme.js';
import { diffFrame, type Frame } from './grid.js';
import { homepageLayout, renderHomepage, sortSessions } from './layout.js';
interface Input extends EventEmitter { isTTY?: boolean; isRaw?: boolean; setRawMode(raw: boolean): unknown; resume(): unknown; pause(): unknown }
interface Output extends EventEmitter { isTTY?: boolean; columns?: number; rows?: number; write(data: string | Buffer): boolean }
// The homepage's connection capability intentionally excludes input(). Attach gets the real connection separately.
export interface HomepageConnection extends EventEmitter { request(body: RequestBody): Promise<SuccessResponse> }
interface Options { stdin?: Input; stdout?: Output; signals?: EventEmitter; cwd?: string; truecolor?: boolean; copy?: (text: string) => Promise<void>; attachSession?: (id: string) => Promise<AttachReason> }
const ENTER_HOME = RESET_MODES + '\x1b[?1049h\x1b[?25l\x1b[?7l\x1b[?1002h\x1b[?1006h\x1b[?2004h';
export class Homepage {
  readonly done: Promise<void>;
  private resolveDone: () => void = () => {};
  private rejectDone: (error: Error) => void = () => {};
  private readonly stdin: Input;
  private readonly stdout: Output;
  private readonly signals: EventEmitter;
  private originalRaw = false;
  private showing = false;
  private ended = false;
  private attached = false;
  private sessions: SessionInfo[] = [];
  private selectedId: string | null = null;
  private visible = true;
  private field = new CommandField();
  private theme: Theme = createTheme('graphite');
  private background?: string;
  private backgroundResolve?: () => void;
  private backgroundTimer?: ReturnType<typeof setTimeout>;
  private inputTimer?: ReturnType<typeof setTimeout>;
  private noteTimer?: ReturnType<typeof setTimeout>;
  private note = '';
  private warning = '';
  private copying = false;
  private confirmId: string | null = null;
  private renameId: string | null = null;
  private previews = new Map<string, Preview>();
  private previewId: string | null = null;
  private previewRequestId: string | null = null;
  private loading: { id: string; chunks: Buffer[]; bytes: number } | null = null;
  private serial: Promise<void> = Promise.resolve();
  private previous: Frame | null = null;
  private previewCells?: Frame;
  private nextPreview = 0;
  private drawTimer?: ReturnType<typeof setTimeout>;
  private blocked = false;
  private forceRedraw = true;
  private drag: Point | null = null;
  private readonly parser: InputParser;
  private readonly replies: BackgroundReplies;
  constructor(private readonly connection: HomepageConnection, private readonly options: Options = {}) {
    this.stdin = options.stdin ?? process.stdin; this.stdout = options.stdout ?? process.stdout; this.signals = options.signals ?? process;
    this.done = new Promise((resolve, reject) => { this.resolveDone = resolve; this.rejectDone = reject; });
    this.parser = new InputParser(event => this.handleInput(event));
    this.replies = new BackgroundReplies(background => { this.background = background; this.backgroundResolve?.(); });
  }
  private size() { const cols = this.stdout.columns ?? 80, rows = this.stdout.rows ?? 24; if (!isSize(cols, rows)) throw new Error('Terminal size outside supported range'); return { cols, rows }; }
  async start(): Promise<void> {
    if (!this.stdin.isTTY || !this.stdout.isTTY) throw new Error('Homepage requires an interactive terminal');
    this.originalRaw = this.stdin.isRaw ?? false;
    this.connection.on('event', this.onEvent); this.connection.on('output', this.onOutput); this.connection.on('disconnected', this.onDisconnect);
    try {
      this.enter();
      const settings = validateSettings((await this.connection.request({ kind: 'settings.get' })).settings);
      if (settings.theme === 'auto') await this.detectBackground();
      if (this.ended) return;
      this.theme = createTheme(settings.theme, this.background);
      const result = await this.connection.request({ kind: 'sessions.list' });
      if (!Array.isArray(result.sessions)) throw new Error('Missing daemon sessions');
      this.sessions = result.sessions.map(validateSession); this.selectedId = sortSessions(this.sessions)[0]?.id ?? null;
      this.draw(true); await this.updatePreview(true);
    } catch (error) { await this.stop(error instanceof Error ? error : new Error('Homepage failed')); throw error; }
  }
  private enter(): void {
    if (this.ended) return;
    this.showing = true; this.stdout.write(ENTER_HOME); this.stdin.setRawMode(true); this.stdin.resume();
    this.stdin.on('data', this.onData); this.stdin.on('error', this.onError); this.stdout.on('error', this.onError); this.stdout.on('drain', this.onDrain);
    this.signals.on('SIGWINCH', this.onResize); this.signals.on('SIGINT', this.onSignal); this.signals.on('SIGTERM', this.onSignal); this.signals.on('uncaughtException', this.onError); this.signals.on('unhandledRejection', this.onError); this.signals.on('exit', this.onExit);
    this.previous = null; this.previewCells = undefined; this.forceRedraw = true; this.blocked = false;
  }
  private leave(): void {
    if (this.drawTimer) clearTimeout(this.drawTimer); if (this.inputTimer) clearTimeout(this.inputTimer);
    this.parser.dispose();
    this.stdin.off('data', this.onData); this.stdin.off('error', this.onError); this.stdout.off('error', this.onError); this.stdout.off('drain', this.onDrain);
    this.signals.off('SIGWINCH', this.onResize); this.signals.off('SIGINT', this.onSignal); this.signals.off('SIGTERM', this.onSignal); this.signals.off('uncaughtException', this.onError); this.signals.off('unhandledRejection', this.onError); this.signals.off('exit', this.onExit);
    if (!this.showing) return;
    this.showing = false;
    this.drawTimer = undefined; this.inputTimer = undefined;
    try { this.stdout.write(RESET_MODES + '\x1b[?1049l'); }
    finally { try { this.stdin.setRawMode(this.originalRaw); } finally { this.stdin.pause(); } }
  }
  async stop(error?: Error): Promise<void> {
    if (this.ended) return;
    this.ended = true; this.loading = null;
    if (this.backgroundTimer) clearTimeout(this.backgroundTimer); this.backgroundResolve?.();
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.connection.off('event', this.onEvent); this.connection.off('output', this.onOutput); this.connection.off('disconnected', this.onDisconnect);
    try { this.leave(); } catch (cleanupError) { error ??= cleanupError instanceof Error ? cleanupError : new Error('Terminal restore failed'); }
    for (const preview of this.previews.values()) preview.dispose(); this.previews.clear();
    if (error) this.rejectDone(error); else this.resolveDone();
  }
  private onExit = () => { this.leave(); };
  private onError = (error: unknown) => { void this.stop(error instanceof Error ? error : new Error('Homepage failed')); };
  private onSignal = () => { void this.stop(); };
  private onDisconnect = () => { void this.stop(new Error('Daemon connection closed')); };
  private onDrain = () => { this.blocked = false; this.draw(true); };
  private onResize = () => {
    try { this.previous = null; this.previewCells = undefined; this.forceRedraw = true; this.draw(true); this.enqueue(() => this.updatePreview(true)); }
    catch (error) { this.onError(error); }
  };
  private onData = (value: Buffer | string) => {
    try {
      if (this.inputTimer) clearTimeout(this.inputTimer);
      const data = this.replies.push(typeof value === 'string' ? Buffer.from(value) : value); this.parser.push(data);
      this.inputTimer = setTimeout(() => { try { this.parser.push(this.replies.flush()); } catch (error) { this.onError(error); } }, 30);
    } catch (error) { this.onError(error); }
  };
  private enqueue(task: () => Promise<void>): void {
    this.serial = this.serial.then(async () => { if (!this.ended) await task(); }).catch(error => this.onError(error));
  }
  private showNote(text: string, duration?: number, copying = false): void {
    if (this.noteTimer) clearTimeout(this.noteTimer);
    this.note = text; this.copying = copying; this.draw(true);
    if (duration) this.noteTimer = setTimeout(() => { this.note = ''; this.copying = false; this.draw(true); }, duration);
  }
  private handleInput(event: InputEvent): void {
    if (!this.showing || this.ended) return;
    if (event.kind === 'mouse') { this.mouse(event); return; }
    if (event.kind === 'paste') { this.field.paste(event.text); this.draw(true); return; }
    if (event.key === 'ctrl-c') {
      const action = this.field.key('ctrl-c');
      if (action.kind === 'quit') void this.stop();
      else if (action.kind === 'note') this.showNote(action.text, 1000);
      return;
    }
    if (this.confirmId) {
      const id = this.confirmId;
      if (event.key === 'y') { this.confirmId = null; this.enqueue(async () => { await this.operation({ kind: 'sessions.stop', sessionId: id }); }); }
      else if (event.key === 'n' || event.key === 'escape') { this.confirmId = null; this.showNote(''); }
      return;
    }
    if (this.renameId) {
      if (event.key === 'escape') { this.renameId = null; this.field.text = ''; this.showNote(''); return; }
      if (event.key === 'enter') {
        const id = this.renameId, title = this.field.text;
        this.renameId = null; this.field.text = ''; this.enqueue(() => this.operation({ kind: 'sessions.rename', sessionId: id, title })); return;
      }
      this.field.key(event.key); this.showNote('rename: type a name, ⏎ save · Esc cancel'); return;
    }
    const action = this.field.key(event.key);
    switch (action.kind) {
      case 'quit': void this.stop(); return;
      case 'note': this.showNote(action.text, 1000); return;
      case 'submit': this.enqueue(() => this.submit(action.text)); break;
      case 'attach': this.enqueue(() => this.openSelected()); break;
      case 'preview': this.visible = !this.visible; this.previewCells = undefined; this.enqueue(() => this.updatePreview(true)); break;
      case 'up': case 'down': {
        const sessions = sortSessions(this.sessions), index = sessions.findIndex(s => s.id === this.selectedId), next = sessions[Math.max(0, Math.min(sessions.length - 1, index + (action.kind === 'up' ? -1 : 1)))];
        if (next && next.id !== this.selectedId) { this.selectedId = next.id; this.drag = null; this.previewCells = undefined; this.enqueue(() => this.updatePreview(false)); }
        break;
      }
      case 'page-up': case 'page-down': this.currentPreview()?.scroll((action.kind === 'page-up' ? -1 : 1) * homepageLayout(this.size().cols, this.size().rows).terminal.h); break;
      case 'end': this.currentPreview()?.follow(); break;
      case 'stop': { const session = this.sessions.find(s => s.id === this.selectedId); if (session) { this.confirmId = session.id; this.showNote(`stop ${session.title}? y/n`); } break; }
      case 'rename': { const session = this.sessions.find(s => s.id === this.selectedId); if (session) { this.renameId = session.id; this.field.text = session.title; this.showNote('rename: type a name, ⏎ save · Esc cancel'); } break; }
      case 'remove': { const session = this.sessions.find(s => s.id === this.selectedId); if (session && ['exited', 'error'].includes(session.status)) this.enqueue(() => this.operation({ kind: 'sessions.remove', sessionId: session.id })); break; }
    }
    this.draw(true);
  }
  private async operation(body: RequestBody): Promise<void> {
    try { await this.connection.request(body); this.showNote(''); }
    catch (error) { this.showNote(error instanceof Error ? error.message : 'Operation failed'); }
  }
  private async submit(text: string): Promise<void> {
    if (text === '/exit') { await this.stop(); return; }
    const theme = text.match(/^\/theme (graphite|slate|ink|auto|light)$/)?.[1];
    if (isThemeName(theme)) {
      const result = await this.connection.request({ kind: 'settings.set', patch: { theme } });
      validateSettings(result.settings);
      if (theme === 'auto') await this.detectBackground();
      this.theme = createTheme(theme, this.background); this.previewCells = undefined; this.previous = null; this.forceRedraw = true; this.showNote(''); return;
    }
    if (text.startsWith('/theme')) { this.showNote('/theme graphite|slate|ink|auto|light'); return; }
    if (['/model', '/cd', '/settings', '/login'].includes(text)) { this.showNote(`${text} comes in ${text === '/login' || text === '/settings' ? 'v0.1.7' : 'v0.1.6'}`); return; }
    this.showNote('starting agents comes in v0.1.6 — for now: ai debug shell');
  }
  private async detectBackground(): Promise<void> {
    if (this.background) return;
    await new Promise<void>(resolve => {
      this.backgroundResolve = () => { if (this.backgroundTimer) clearTimeout(this.backgroundTimer); this.backgroundResolve = undefined; resolve(); };
      this.backgroundTimer = setTimeout(() => this.backgroundResolve?.(), 200); this.stdout.write(BACKGROUND_QUERY);
    });
  }
  private currentPreview(): Preview | undefined { return this.selectedId ? this.previews.get(this.selectedId) : undefined; }
  private async updatePreview(resize: boolean): Promise<void> {
    const { cols, rows } = this.size(), layout = homepageLayout(cols, rows, this.visible);
    // Without a visible preview there is no area to match; never reflow detached sessions down to it.
    if (resize && layout.preview) {
      await this.connection.request({ kind: 'layout.previewSize', cols: layout.terminal.w, rows: layout.terminal.h });
      // Re-subscribe below: an attached session can have a different size from our layout.
    }
    const id = layout.preview ? this.selectedId : null;
    this.previewId = null; this.previewRequestId = null;
    if (!id) { await this.connection.request({ kind: 'sessions.preview', sessionId: null }); this.draw(true); return; }
    const loading = { id, chunks: [] as Buffer[], bytes: 0 }; this.loading = loading;
    const result = await this.connection.request({ kind: 'sessions.preview', sessionId: id });
    if (this.ended || this.loading !== loading) return;
    this.previewRequestId = result.id; this.previewId = id;
    await this.replacePreview(id, result, loading.chunks);
    if (this.loading === loading) this.loading = null;
    this.draw(true);
  }
  private async replacePreview(id: string, result: SuccessResponse, chunks: Buffer[] = []): Promise<void> {
    if (typeof result.snapshot !== 'string' || !isSize(result.cols, result.rows)) throw new Error('Invalid preview snapshot');
    const preview = new Preview(result.cols ?? 2, result.rows ?? 1, () => { if (this.selectedId === id) this.draw(); });
    this.previews.get(id)?.dispose(); this.previews.set(id, preview); this.previewCells = undefined;
    await preview.write(result.snapshot);
    // Drain chunks appended while the snapshot parses, preserving snapshot-before-live order.
    for (let i = 0; i < chunks.length; i++) { const chunk = chunks[i]; if (chunk) await preview.write(chunk); }
  }
  private onOutput = (id: string, data: Buffer) => {
    if (this.ended || this.attached) return;
    if (this.loading?.id === id) {
      this.loading.bytes += data.length;
      if (this.loading.bytes > 8 * 1024 * 1024) { this.onError(new Error('Preview startup queue exceeded')); return; }
      this.loading.chunks.push(data); return;
    }
    if (id === this.previewId) { const preview = this.previews.get(id); if (preview) void preview.write(data).catch(this.onError); }
  };
  private onEvent = (value: unknown) => {
    if (value && typeof value === 'object' && 'kind' in value) {
      if (value.kind === 'daemon.warning' && 'text' in value && typeof value.text === 'string') { this.warning = warningText(redact(warningText(value.text))); this.draw(true); return; }
      if (value.kind === 'daemon.warningCleared') { this.warning = ''; this.draw(true); return; }
    }
    if (this.ended) return;
    try {
      if (!value || typeof value !== 'object') throw new Error('Invalid daemon event');
      const v = value as Record<string, unknown>;
      if (v.kind === 'session.updated') {
        const session = validateSession(v.session), index = this.sessions.findIndex(s => s.id === session.id);
        if (index >= 0) this.sessions[index] = session; else this.sessions.push(session);
        if (!this.selectedId) { this.selectedId = session.id; this.enqueue(() => this.updatePreview(false)); }
      } else if (v.kind === 'session.previewResized') {
        if (!isUUID(v.sessionId) || !isSize(v.cols, v.rows)) throw new Error('Invalid preview dimensions');
        if (!this.attached && v.sessionId === this.selectedId) this.enqueue(() => this.updatePreview(false));
      } else if (v.kind === 'session.removed') {
        if (!isUUID(v.sessionId)) throw new Error('Invalid removed session');
        this.sessions = this.sessions.filter(s => s.id !== v.sessionId); this.previews.get(v.sessionId)?.dispose(); this.previews.delete(v.sessionId);
        if (this.selectedId === v.sessionId) { this.selectedId = sortSessions(this.sessions)[0]?.id ?? null; this.previewCells = undefined; this.enqueue(() => this.updatePreview(false)); }
      } else if (v.ok === true && v.snapshot !== undefined) {
        const result = validateSuccess(v);
        if (result.id === this.previewRequestId && result.sessionId === this.previewId && this.previewId) {
          const id = this.previewId, loading = { id, chunks: [] as Buffer[], bytes: 0 }; this.loading = loading;
          this.enqueue(async () => { if (this.loading !== loading || this.previewId !== id) return; await this.replacePreview(id, result, loading.chunks); if (this.loading === loading) this.loading = null; this.draw(true); });
        }
      }
      this.draw();
    } catch (error) { this.onError(error); }
  };
  private async openSelected(): Promise<void> {
    const id = this.selectedId; if (!id || !this.options.attachSession) { this.showNote(id ? 'Attach unavailable' : 'No session selected'); return; }
    await this.connection.request({ kind: 'sessions.preview', sessionId: null }); this.previewId = null; this.loading = null;
    this.attached = true; this.leave();
    let note = '';
    try { const reason = await this.options.attachSession(id); if (reason !== 'home key') note = reason; }
    catch (error) { note = error instanceof Error ? error.message : 'Attach failed'; }
    finally { this.attached = false; }
    if (this.ended) return;
    this.enter();
    const result = await this.connection.request({ kind: 'sessions.list' }); this.sessions = (result.sessions ?? []).map(validateSession);
    await this.updatePreview(true); this.showNote(note);
  }
  private mouse(event: Extract<InputEvent, { kind: 'mouse' }>): void {
    const layout = homepageLayout(this.size().cols, this.size().rows, this.visible), area = layout.terminal, preview = this.currentPreview();
    if (!layout.preview || !preview || event.button & 4 || event.button & 8) return;
    const firstRow = preview.linesBack ? 1 : 0, lastRow = area.h - (preview.newLines ? 1 : 0);
    const inside = event.x >= area.x && event.x < area.x + area.w && event.y >= area.y + firstRow && event.y < area.y + lastRow;
    if (event.button & 64) { if (inside) preview.scroll(event.button & 1 ? 3 : -3); return; }
    const point = { x: Math.max(0, Math.min(area.w - 1, event.x - area.x)), y: Math.max(firstRow, Math.min(lastRow - 1, event.y - area.y)) };
    if (!event.release && !(event.button & 32) && (event.button & 3) === 0 && inside) { this.drag = point; preview.select(point, point); }
    else if (this.drag) {
      const start = this.drag; preview.select(start, point);
      // A click without movement is not a selection; it must never overwrite the clipboard.
      if (event.release && start.x === point.x && start.y === point.y) { this.drag = null; preview.clearSelection(); }
      else if (event.release) {
        this.drag = null; const text = preview.selectedText(area.w);
        void (this.options.copy ?? copyText)(text).then(() => { if (!this.ended) this.showNote(`✓ copied ${text.split('\n').length} lines`, 1200, true); }).catch(error => this.showNote(error instanceof Error ? error.message : 'Copy failed'));
      }
    }
    this.previewCells = undefined; this.draw(true);
  }
  private draw(immediate = false): void {
    if (!this.showing || this.ended || this.blocked) return;
    const now = performance.now();
    if (!immediate && now < this.nextPreview) {
      if (!this.drawTimer) this.drawTimer = setTimeout(() => { this.drawTimer = undefined; this.draw(); }, this.nextPreview - now);
      return;
    }
    try {
      const { cols, rows } = this.size(), layout = homepageLayout(cols, rows, this.visible), preview = this.currentPreview();
      if (this.forceRedraw || now >= this.nextPreview || !this.previewCells) {
        this.previewCells = layout.preview ? preview?.cells(this.theme, layout.terminal.w, layout.terminal.h) : undefined;
        this.nextPreview = now + 1000 / 30;
      }
      const cwd = this.options.cwd ?? process.cwd(), home = homedir();
      const grid = renderHomepage({ cols, rows, sessions: this.sessions, selectedId: this.selectedId, input: this.field.text, note: this.note, warning: this.warning, copying: this.copying, previewVisible: this.visible, cwd: cwd === home ? '~' : cwd.startsWith(home + '/') ? '~' + cwd.slice(home.length) : cwd, now: Date.now(), previewCells: this.previewCells, linesBack: preview?.linesBack, newLines: preview?.newLines }, this.theme);
      const output = diffFrame(grid, this.previous, this.theme, this.options.truecolor ?? true); this.previous = grid; this.forceRedraw = false;
      if (output) this.blocked = !this.stdout.write(output);
    } catch (error) { this.onError(error); }
  }
}
export async function homepage(connection: import('../connection.js').Connection): Promise<void> {
  const home = new Homepage(connection, { truecolor: process.env.COLORTERM === 'truecolor' || process.env.COLORTERM === '24bit' || process.env.TERM_PROGRAM === 'Apple_Terminal' || process.env.TERM_PROGRAM === 'iTerm.app', attachSession: id => attach(connection, id) });
  await Promise.all([home.start(), home.done]);
}

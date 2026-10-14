import type { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import type { RequestBody } from './connection.js';
import type { SuccessResponse } from '../shared/protocol.js';
import { isUUID, isSize, validateModes, validateSession } from '../shared/validate.js';
import type { Input, Output } from './attach.js';
import { ClientSignal } from './signals.js';
import { enterModes, RESET_MODES } from './terminal-modes.js';
import { terminalProbe } from './terminal-probe.js';
import type { OuterFacts } from './passthrough.js';
import { fitPanes, paneAt, splitLayout, type Rect, type SplitLayout } from './split-layout.js';
import { SplitInput, type SplitInputEvent } from './split-input.js';
import { encodeMouse } from './split-mouse.js';
import { Pane } from './split-pane.js';
import { splitChrome, tooSmall } from './tui/split-chrome.js';
import { diffFrame, type Frame } from './tui/grid.js';
import type { Theme } from './tui/theme.js';

// One daemon connection per pane: the daemon lets a connection own one attached agent, and separate sockets keep a
// flooding pane's bytes from queueing ahead of the focused pane's echo.
export interface SplitConnection extends EventEmitter { request(body: RequestBody): Promise<SuccessResponse>; input(id: string, data: Buffer): void; pauseOutput(): void; resumeOutput(): void; close(): void }
export interface SplitOptions { home?: AbortSignal; themeEvents?: EventEmitter; stdin?: Input; stdout?: Output; signals?: EventEmitter; connect: () => Promise<SplitConnection>; theme: Theme; truecolor?: boolean; now?: () => number; log?: (text: string) => void }
export type SplitReason = 'home key' | 'one left' | 'all closed' | 'client interrupted';
export interface SplitResult { reason: SplitReason; remaining?: string; dropped: number }
export class SplitError extends Error { constructor(readonly reason: 'daemon gone' | 'error', cause: Error) { super(cause.message, { cause }); } }
// The real terminal reports every mouse event as SGR while a split is open, so any pane can take a click.
const SPLIT_MOUSE = '\x1b[?1003h\x1b[?1006h';
// Two presses of the pane key this close together send one real Ctrl+\ to the agent instead.
export const DOUBLE_PRESS_MS = 400;
// Frame spacing: the focused pane as the bar (8 ms; a typing echo draws at once), the others at the preview's 30 fps.
const FOCUSED_FRAME_MS = 8, BACKGROUND_FRAME_MS = 1000 / 30, ESCAPE_MS = 30, STARTUP_LIMIT = 4 * 1024 * 1024;
interface Slot { pane: Pane; connection: SplitConnection; released?: boolean }
type Outcome = { reason: SplitReason; signal?: ClientSignal } | { error: SplitError };

export async function split(ids: readonly string[], options: SplitOptions): Promise<SplitResult> {
  const stdin: Input = options.stdin ?? process.stdin, stdout: Output = options.stdout ?? process.stdout, signals = options.signals ?? process, now = options.now ?? (() => performance.now());
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('A split requires an interactive terminal');
  if (ids.some(id => !isUUID(id)) || new Set(ids).size !== ids.length) throw new Error('A split takes distinct session UUIDs');
  const size = () => { const cols = stdout.columns ?? 80, rows = stdout.rows ?? 24; if (!isSize(cols, rows)) throw new Error('Terminal size outside supported range'); return { cols, rows }; };
  if (options.home?.aborted) return { reason: 'home key', dropped: 0 };
  const start = size(), count = fitPanes(start.cols, start.rows, ids.length), dropped = ids.length - count;
  const first = splitLayout(start.cols, start.rows, count);
  // Fewer than two fit: the first agent becomes a normal attach.
  if (!first) return { reason: 'one left', ...(ids[0] ? { remaining: ids[0] } : {}), dropped };
  const originalRaw = stdin.isRaw ?? false;
  const probed = await terminalProbe(stdin, stdout);
  if (options.home?.aborted) return { reason: 'home key', dropped: 0 };
  const facts: OuterFacts = probed.success ? probed.facts : { kitty: false };
  if (!probed.success) options.log?.('Split startup probe failed; terminal color and kitty queries go unanswered');

  let slots: Slot[] = [], focusedId = '', layout: SplitLayout | null = null, chrome: Frame | null = null, lastCursor = '';
  let active = false, blocked = false, needFull = false, outcome: Outcome | null = null, lastPane: { at: number; from: string } | null = null;
  let captured: string | null = null, escapeTimer: ReturnType<typeof setTimeout> | undefined, resolveDone: () => void = () => {};
  const done = new Promise<void>(resolve => { resolveDone = resolve; });
  // Read through a function: TypeScript would otherwise keep `outcome` narrowed to its initial null.
  const current = (): Outcome | null => outcome, ended = () => current() !== null;
  const finish = (next: Outcome) => { if (outcome) return; outcome = next; active = false; resolveDone(); };
  const end = (reason: SplitReason, signal?: ClientSignal) => finish(signal ? { reason, signal } : { reason });
  const fail = (error: unknown, reason: 'daemon gone' | 'error' = 'error') => finish({ error: new SplitError(reason, error instanceof Error ? error : new Error('Split failed')) });
  const write = (data: string) => { if (data && !stdout.write(data)) blocked = true; };
  const focused = () => slots.find(s => s.pane.id === focusedId);

  // Every frame ends with the real cursor on the focused pane's cursor (hidden when it has none).
  const finishFrame = (body: string) => {
    const slot = focused(), cursor = slot && layout ? slot.pane.cursor() : '';
    if (!body && cursor === lastCursor) return;
    lastCursor = cursor;
    write(`\x1b[?2026h\x1b[?25l${body}\x1b[0m${cursor}\x1b[?2026l`);
  };
  const chromeFrame = (): Frame => {
    const { cols, rows } = size();
    return layout ? splitChrome(cols, rows, layout, slots.map(({ pane }) => ({ info: pane.info, state: pane.state, focused: pane.focused })), dropped, options.theme) : tooSmall(cols, rows, options.theme);
  };
  const draw = (full = false) => {
    if (full) needFull = true;
    if (blocked || !active) return;
    full = needFull; needFull = false;
    const next = chromeFrame(), bytes = diffFrame(next, full ? null : chrome, options.theme, options.truecolor ?? true);
    chrome = next;
    // diffFrame wraps its output in synchronized-output marks; finishFrame adds them around the whole frame instead.
    let body = bytes ? bytes.slice(8, -8) : '';
    if (layout) for (const { pane } of slots) { if (full) pane.invalidate(); body += pane.paint(); pane.lastFrame = now(); }
    finishFrame(body);
  };
  const drawPane = (pane: Pane) => {
    pane.timer = undefined; pane.holding = false;
    if (blocked || !active || !layout) return;
    const hold = pane.syncWait(now());
    if (hold > 0) { pane.holding = true; pane.timer = setTimeout(() => drawPane(pane), hold); return; }
    pane.lastFrame = now();
    finishFrame(pane.paint());
  };
  // A pane's frames are spaced on their own clock, so a flooding pane never holds back the focused pane's echo.
  const changed = (pane: Pane) => {
    // The agent's synchronized block just ended: draw now instead of waiting out the hold.
    if (pane.timer && pane.holding && !pane.terminal.modes.synchronizedOutputMode) { clearTimeout(pane.timer); pane.timer = undefined; pane.holding = false; }
    if (!active || pane.timer) return;
    const wait = (pane.focused ? FOCUSED_FRAME_MS : BACKGROUND_FRAME_MS) - (now() - pane.lastFrame);
    if (wait > 0) pane.timer = setTimeout(() => drawPane(pane), wait); else drawPane(pane);
  };
  const resizeAgent = (slot: Slot, rect: Rect) => {
    if (slot.pane.live) void slot.connection.request({ kind: 'sessions.resize', sessionId: slot.pane.id, cols: rect.w, rows: rect.h - 1 }).catch((error: unknown) => fail(error));
  };
  // Each pane's agent PTY takes its pane's size minus the header row. Too small a window keeps the agents' sizes and
  // shows only a note until it grows again.
  const relayout = () => {
    const { cols, rows } = size();
    layout = splitLayout(cols, rows, slots.length);
    if (layout) for (const [i, slot] of slots.entries()) {
      const rect = layout.panes[i], before = slot.pane.rect;
      if (!rect) continue;
      slot.pane.resize(rect);
      if (rect.w !== before.w || rect.h !== before.h) resizeAgent(slot, rect);
    }
    draw(true);
  };
  const focus = (id: string) => {
    if (id === focusedId) return;
    focusedId = id;
    for (const { pane } of slots) pane.focused = pane.id === id;
    // The real terminal takes the newly focused agent's keyboard modes, cursor shape and title.
    const slot = focused();
    if (slot) write(slot.pane.passthrough.restore());
    draw();
  };
  // Every attached pane is detached and its connection closed exactly once, whether it closed, the split ended, or
  // it finished attaching after the split had already ended.
  const detach = async (slot: Slot) => {
    if (slot.released) return;
    slot.released = true; slot.pane.dispose();
    try { await slot.connection.request({ kind: 'sessions.detach', sessionId: slot.pane.id }); }
    catch (error) { options.log?.(`Split pane detach failed: ${error instanceof Error ? error.message : 'unknown error'}`); }
    finally { slot.connection.close(); }
  };
  // Closing panes gives the rest their room; one pane left becomes a normal attach, none goes home.
  const close = (gone: readonly Slot[]) => {
    const order = slots.map(s => s.pane.id), index = Math.max(0, order.indexOf(focusedId));
    slots = slots.filter(s => !gone.includes(s));
    for (const slot of gone) void detach(slot);
    if (slots.length === 1) { end('one left'); return; }
    if (!slots.length) { end('all closed'); return; }
    if (!focused()) {
      const next = [...order.slice(index + 1), ...order.slice(0, index)].find(id => slots.some(s => s.pane.id === id));
      focusedId = ''; focus(next ?? '');
    }
    relayout();
  };
  // Ctrl+\ closes the panes whose agents have ended; otherwise it focuses the next pane. A second press within
  // DOUBLE_PRESS_MS goes back and sends that agent one real Ctrl+\.
  const paneKey = (data: Buffer) => {
    const at = now(), previous = lastPane;
    lastPane = null;
    if (previous && at - previous.at <= DOUBLE_PRESS_MS) {
      const target = slots.find(s => s.pane.id === previous.from);
      if (target?.pane.live) { focus(target.pane.id); target.pane.input(); target.connection.input(target.pane.id, data); return; }
    }
    const endedSlots = slots.filter(s => !s.pane.live);
    if (endedSlots.length) { close(endedSlots); if (!ended()) lastPane = { at, from: focusedId }; return; }
    const from = focusedId, index = slots.findIndex(s => s.pane.id === from), next = slots[(index + 1) % slots.length];
    if (next) focus(next.pane.id);
    lastPane = { at, from };
  };
  // A press focuses the pane under the pointer and reaches it in its coordinates; a drag stays with the pane it started
  // in until the release. Nothing reaches a pane that isn't focused.
  const mouse = (event: Extract<SplitInputEvent, { kind: 'mouse' }>) => {
    if (!layout) return;
    const motion = (event.button & 32) !== 0, wheel = (event.button & 64) !== 0, press = !event.release && !motion && !wheel;
    // A new press starts over: a drag whose release was lost must not capture the next click.
    if (press) captured = null;
    const hit = paneAt(layout, event.x, event.y), held = captured ? slots.find(s => s.pane.id === captured) : undefined;
    const slot = held ?? (hit ? slots[hit.index] : undefined);
    if (event.release) captured = null;
    if (!slot) return;
    if (press) focus(slot.pane.id);
    // Mouse input reaches only the focused pane: a press focuses first, and wheel or motion elsewhere goes nowhere.
    if (slot.pane.id !== focusedId) return;
    const rect = slot.pane.rect, x = Math.max(0, Math.min(rect.w - 1, event.x - rect.x)), y = event.y - rect.y - 1;
    if (!held && y < 0) return;
    if (press) captured = slot.pane.id;
    if (!slot.pane.live) return;
    const bytes = encodeMouse({ button: event.button, x, y: Math.max(0, Math.min(rect.h - 2, y)), release: event.release }, slot.pane.mouse());
    if (bytes) slot.connection.input(slot.pane.id, bytes);
  };
  const route = (events: SplitInputEvent[]) => {
    for (const event of events) {
      if (!active) return;
      if (event.kind === 'home') { end('home key'); return; }
      if (event.kind === 'pane') { paneKey(event.data); continue; }
      if (event.kind === 'mouse') { mouse(event); continue; }
      // Keys and pastes reach only the focused agent, and only while the panes are on screen.
      const slot = focused();
      if (layout && slot?.pane.live) { slot.pane.input(); slot.connection.input(slot.pane.id, event.data); }
    }
  };
  const parser = new SplitInput();
  const onData = (value: Buffer | string) => {
    try {
      const data = typeof value === 'string' ? Buffer.from(value) : value;
      if (!active) { if (data.includes(3)) end('client interrupted'); return; }
      if (escapeTimer) clearTimeout(escapeTimer);
      route(parser.push(data));
      escapeTimer = setTimeout(() => { try { route(parser.flush()); } catch (error) { fail(error); } }, ESCAPE_MS);
    } catch (error) { fail(error); }
  };
  const onResize = () => { try { if (active) relayout(); } catch (error) { fail(error); } };
  const onDrain = () => { if (!blocked) return; blocked = false; draw(); };
  const onError = (error: Error) => fail(error);
  const onHome = () => end('home key');
  const onTheme = () => { try { draw(true); } catch (error) { fail(error); } };
  const onSignal = () => end('client interrupted');
  const onTerm = () => end('client interrupted', new ClientSignal(143)), onHup = () => end('client interrupted', new ClientSignal(129)), onQuit = () => end('client interrupted', new ClientSignal(131));
  const listen = (on: boolean) => {
    const method = on ? 'on' : 'off';
    if (on) options.home?.addEventListener('abort', onHome); else options.home?.removeEventListener('abort', onHome);
    options.themeEvents?.[method]('theme', onTheme);
    stdin[method]('data', onData); stdin[method]('error', onError); stdout[method]('error', onError); stdout[method]('drain', onDrain);
    signals[method]('SIGWINCH', onResize); signals[method]('SIGINT', onSignal); signals[method]('SIGTERM', onTerm); signals[method]('SIGHUP', onHup); signals[method]('SIGQUIT', onQuit);
    signals[method]('uncaughtException', onError); signals[method]('unhandledRejection', onError);
  };
  const onEvent = (slot: Slot, value: unknown) => {
    try {
      if (ended() || !value || typeof value !== 'object' || !slots.includes(slot)) return;
      const event = value as Record<string, unknown>, pane = slot.pane;
      if (event.sessionId === pane.id && event.kind === 'session.detached') { pane.state = 'elsewhere'; draw(); return; }
      if (event.sessionId === pane.id && event.kind === 'session.removed') { close([slot]); return; }
      if (event.kind !== 'session.updated' || !event.session || typeof event.session !== 'object' || (event.session as Record<string, unknown>).id !== pane.id) return;
      pane.info = validateSession(event.session);
      // An ended agent's pane stays, showing how it ended, until the pane key closes it.
      if ((pane.info.status === 'exited' || pane.info.status === 'error') && pane.live) pane.state = 'exited';
      draw();
    } catch (error) { fail(error); }
  };
  // Attach one agent on its own connection. Output that arrives before the snapshot waits, then follows it in order.
  const open = async (id: string, rect: Rect): Promise<Slot | null> => {
    let connection: SplitConnection;
    try { connection = await options.connect(); }
    catch (error) { options.log?.(`Split pane could not connect: ${error instanceof Error ? error.message : 'unknown error'}`); return null; }
    const early: Buffer[] = [];
    let slot: Slot | undefined, earlyBytes = 0;
    connection.on('output', (sessionId: string, data: Buffer) => {
      if (sessionId !== id || ended()) return;
      if (slot) { slot.pane.write(data); return; }
      earlyBytes += data.length;
      if (earlyBytes > STARTUP_LIMIT) fail(new Error('Split startup output exceeded limit')); else early.push(data);
    });
    connection.on('event', (value: unknown) => { if (slot) onEvent(slot, value); });
    // Only an open pane's connection matters; a pane closed here closes its own connection.
    connection.on('disconnected', () => { if (slot && slots.includes(slot)) fail(new Error('Daemon connection closed'), 'daemon gone'); });
    try {
      const result = await connection.request({ kind: 'sessions.attach', sessionId: id, cols: rect.w, rows: rect.h - 1 });
      if (typeof result.snapshot !== 'string' || !isSize(result.cols, result.rows)) throw new Error('Invalid attach snapshot');
      const info = validateSession(result.session), modes = validateModes(result.modes);
      const pane = new Pane(id, info, rect, facts, write, data => connection.input(id, data), { pause: () => connection.pauseOutput(), resume: () => connection.resumeOutput() }, changed, fail);
      if (info.status === 'exited' || info.status === 'error') pane.state = 'exited';
      pane.write(result.snapshot); pane.write(enterModes(modes));
      for (const data of early) pane.write(data);
      slot = { pane, connection };
      return slot;
    } catch (error) {
      connection.close();
      options.log?.(`Split pane could not attach: ${error instanceof Error ? error.message : 'unknown error'}`);
      return null;
    }
  };

  listen(true);
  let entered = false, openings: Promise<Slot | null>[] = [];
  try {
    entered = true; write('\x1b[?1049h\x1b[?25l' + SPLIT_MOUSE); stdin.setRawMode(true); stdin.resume();
    openings = ids.slice(0, count).map((id, i) => first.panes[i] ? open(id, first.panes[i]) : Promise.resolve(null));
    const opened = await Promise.race([Promise.all(openings), done.then(() => null)]);
    slots = (opened ?? []).filter((slot): slot is Slot => slot !== null);
    if (!ended()) {
      active = true;
      if (slots.length < 2) end(slots.length ? 'one left' : 'all closed');
      else {
        relayout(); focus(slots[0]?.pane.id ?? '');
        if (probed.input.length) onData(probed.input);
      }
    }
    await done;
  } catch (error) { fail(error); }
  finally {
    active = false; if (escapeTimer) clearTimeout(escapeTimer);
    listen(false);
    try { if (entered) stdout.write(RESET_MODES + '\x1b[?1049l'); } catch (error) { fail(error); }
    try { stdin.setRawMode(originalRaw); stdin.pause(); } catch (error) { fail(error); }
    // Detach every pane before a remaining one becomes a normal attach, so sizes follow the existing attach rules;
    // panes still attaching when the split ended are detached as soon as they finish.
    const late = (await Promise.allSettled(openings)).flatMap(result => result.status === 'fulfilled' && result.value ? [result.value] : []);
    await Promise.all([...new Set([...slots, ...late])].map(detach));
  }
  const remaining = slots.length === 1 ? slots[0]?.pane.id : undefined, result: Outcome = current() ?? { error: new SplitError('error', new Error('Split ended unexpectedly')) };
  if ('error' in result) throw result.error;
  if (result.signal) throw result.signal;
  return { reason: result.reason, ...(remaining ? { remaining } : {}), dropped };
}

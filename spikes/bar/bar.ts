// Throwaway spike code (v0.2.1b). Not product code.
// Runs one program in a node-pty PTY at rows-1 and shows it full screen, either as raw
// passthrough (today's attach) or redrawn from a client-side headless xterm under a one-row bar.
//
//   node --import tsx spikes/bar/bar.ts --mode raw|redraw [--unicode modern|6] [--metrics FILE] -- PROGRAM ARGS...
//   node --import tsx spikes/bar/bar.ts --mode redraw --agent claude|codex
//
// Ctrl+E (any form the home-key detector knows) quits the harness and stops the program.
import { writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { HomeKeyFilter } from '../../src/client/input-filter.js';
import { RESET_MODES } from '../../src/client/terminal-modes.js';
import { Grid, diffFrame, type Frame } from '../../src/client/tui/grid.js';
import { createTheme } from '../../src/client/tui/theme.js';
import { buildArgs, buildSpawnEnv } from '../../src/daemon/env.js';
import { BodyRenderer } from './render.js';
import { MouseRewriter } from './mouse.js';
import { installPassthrough, OUTER_PROBE, parseProbe, type OuterFacts, type Passthrough } from './passthrough.js';
import { modernUnicode } from './unicode.js';

const MIN_FRAME_MS = 8;            // at most ~120 frames/s while output floods
const AGENT_SYNC_TIMEOUT_MS = 150; // render anyway if an agent never ends synchronized output
const PROBE_TIMEOUT_MS = 250;

interface Options { mode: 'raw' | 'redraw'; unicode: 'modern' | '6'; metrics?: string; file: string; args: string[]; env: Record<string, string>; name: string; detail: string }
function parseOptions(argv: string[]): Options {
  const split = argv.indexOf('--'), flags = split >= 0 ? argv.slice(0, split) : argv, program = split >= 0 ? argv.slice(split + 1) : [];
  const value = (name: string): string | undefined => { const i = flags.indexOf(name); return i >= 0 ? flags[i + 1] : undefined; };
  const mode = value('--mode') ?? 'redraw', unicode = value('--unicode') ?? 'modern', agent = value('--agent');
  if (mode !== 'raw' && mode !== 'redraw') throw new Error('--mode must be raw or redraw');
  if (unicode !== 'modern' && unicode !== '6') throw new Error('--unicode must be modern or 6');
  if (agent === 'claude' || agent === 'codex') {
    // Same argv and env recipe the daemon uses for an Ask account session (D40, D41, S6).
    const engine = agent === 'claude' ? 'claude-code' : 'codex';
    return { mode, unicode, metrics: value('--metrics'), file: agent, args: buildArgs({ engine, model: null, permission: 'ask' }), env: buildSpawnEnv(engine, { kind: 'account' }, process.env), name: agent === 'claude' ? 'claude' : 'codex', detail: `${engine} · CLI default` };
  }
  const [file, ...args] = program;
  if (!file) throw new Error('usage: bar.ts --mode raw|redraw -- PROGRAM ARGS...');
  // A literal small env: test programs get nothing else from this shell.
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' };
  return { mode, unicode, metrics: value('--metrics'), file, args, env, name: file.split('/').at(-1) ?? file, detail: `shell · ${[file.split('/').at(-1), ...args].join(' ').slice(0, 40)}` };
}

const options = parseOptions(process.argv.slice(2));
const stdin = process.stdin, stdout = process.stdout;
if (!stdin.isTTY || !stdout.isTTY) throw new Error('bar.ts needs an interactive terminal');

const metrics = { mode: options.mode, childBytes: 0, frames: 0, frameMs: [] as number[], outBytes: 0, inBytes: 0, startup: 0, cpu: { user: 0, system: 0 }, elapsedMs: 0, dropped: {} as Record<string, number>, modeLog: [] as string[], mouseDropped: 0, probe: {} as OuterFacts | Record<string, never>, size: { cols: 0, rows: 0 } };
const started = performance.now();
let readyAt = 0;
const write = (data: string | Buffer): void => { if (!data.length) return; metrics.outBytes += Buffer.byteLength(data); if (!stdout.write(data)) waitingDrain = true; };
let waitingDrain = false;

function size(): { cols: number; rows: number } { return { cols: Math.max(20, stdout.columns || 80), rows: Math.max(4, stdout.rows || 24) }; }

async function probeOuter(): Promise<{ facts: OuterFacts; rest: string }> {
  write(OUTER_PROBE);
  let text = '';
  return new Promise(resolve => {
    const finish = (): void => { clearTimeout(timer); stdin.off('data', onData); const parsed = parseProbe(text); resolve({ facts: parsed.facts, rest: parsed.rest }); };
    const onData = (chunk: Buffer): void => { text += chunk.toString('latin1'); if (parseProbe(text).done) finish(); };
    const timer = setTimeout(finish, PROBE_TIMEOUT_MS);
    stdin.on('data', onData);
  });
}

// The bar: product Grid + theme, drawn with the product diff and spliced into our own frame.
const theme = createTheme('slate');
let barPrevious: Frame | null = null;
function barFrame(cols: number): string {
  const grid = new Grid(cols, 1, theme), bg = theme.colors.surface;
  grid.fill(0, 0, cols, 1, bg);
  let x = grid.text(1, 0, '◐ ', theme.colors.accent, bg);
  x = grid.text(x, 0, options.name, theme.colors.ink, bg, true);
  grid.text(x + 2, 0, options.detail, theme.colors['ink-2'], bg, false, Math.max(0, cols - x - 40));
  const right = '● 1 waiting  ◐ 2 running   ^E home ';
  const start = Math.max(0, cols - right.length);
  let rx = grid.text(start, 0, '● 1 waiting', theme.colors['status-waiting'], bg, true);
  rx = grid.text(rx, 0, '  ◐ 2 running', theme.colors.accent, bg);
  grid.text(rx, 0, '   ^E home ', theme.colors['ink-3'], bg);
  // Force every bar cell out without diffFrame's full-screen clear.
  const before = barPrevious ?? grid.cells.map(row => row.map(cell => ({ ...cell, char: '\u0000' })));
  const out = diffFrame(grid.cells, before, theme);
  barPrevious = grid.cells;
  // diffFrame wraps itself in synchronized output; this frame has its own wrapper.
  return out.replace(/^\x1b\[\?2026h/, '').replace(/\x1b\[0m\x1b\[\?2026l$/, '\x1b[0m');
}

async function main(): Promise<void> {
  stdin.setRawMode(true); stdin.resume();
  write('\x1b[?1049h\x1b[H\x1b[2J');
  let { cols, rows } = size();
  metrics.size = { cols, rows };
  let facts: OuterFacts = { kitty: false }, early = '';
  if (options.mode === 'redraw') { const probe = await probeOuter(); facts = probe.facts; early = probe.rest; metrics.probe = facts; }

  const child = pty.spawn(options.file, options.args, { name: 'xterm-256color', cols, rows: rows - 1, cwd: process.cwd(), env: options.env });
  const filter = new HomeKeyFilter();
  let ended = false, escapeTimer: ReturnType<typeof setTimeout> | undefined;
  let term: headless.Terminal | undefined, renderer: BodyRenderer | undefined, passthrough: Passthrough | undefined, mouse: MouseRewriter | undefined;
  let scheduled = false, lastFrame = 0, syncTimer: ReturnType<typeof setTimeout> | undefined, syncExpired = false, fullRedraw = true;

  const render = (): void => {
    scheduled = false;
    if (!term || !renderer || ended) return;
    if (waitingDrain) return; // resumes on 'drain'; intermediate frames are skipped, never queued
    const t0 = performance.now();
    renderer.cursorVisible = passthrough?.cursorVisible() ?? true;
    let body = fullRedraw ? '\x1b[0m\x1b[H\x1b[2J' + barFrame(cols) : '';
    if (fullRedraw) { renderer.invalidate(); fullRedraw = false; }
    body += renderer.frame();
    if (body) { write('\x1b[?2026h' + body + '\x1b[?2026l'); metrics.frames++; metrics.frameMs.push(performance.now() - t0); if (!readyAt) readyAt = performance.now(); }
    lastFrame = performance.now();
  };
  const requestRender = (): void => {
    if (scheduled || !term) return;
    // Honor the agent's own synchronized output: wait for its frame to end, but not forever.
    if (term.modes.synchronizedOutputMode && !syncExpired) {
      syncTimer ??= setTimeout(() => { syncTimer = undefined; syncExpired = true; requestRender(); }, AGENT_SYNC_TIMEOUT_MS);
      return;
    }
    syncExpired = false;
    if (syncTimer) { clearTimeout(syncTimer); syncTimer = undefined; }
    scheduled = true;
    const wait = MIN_FRAME_MS - (performance.now() - lastFrame);
    // Idle: draw in this tick (the echo of a keystroke). Busy: at most one frame per MIN_FRAME_MS.
    if (wait > 0) setTimeout(render, wait); else render();
  };

  if (options.mode === 'redraw') {
    term = new headless.Terminal({ cols, rows: rows - 1, scrollback: 0, allowProposedApi: true });
    if (options.unicode === 'modern') { term.unicode.register(modernUnicode); term.unicode.activeVersion = modernUnicode.version; }
    passthrough = installPassthrough(term, facts, write, data => child.write(data));
    // The mirror answers position and state queries (DA, DSR/CPR, DECRQM) for its own screen.
    term.onData(data => { if (data) child.write(data); });
    renderer = new BodyRenderer(term, 1);
    mouse = new MouseRewriter(() => passthrough?.mouse() ?? { tracking: false, encoding: 'default' });
    stdout.on('drain', () => { waitingDrain = false; requestRender(); });
    requestRender();
  }

  child.onData(data => {
    if (ended) return;
    metrics.childBytes += data.length;
    if (!term) { write(data); if (!readyAt) readyAt = performance.now(); return; }
    term.write(data, requestRender);
  });

  const send = (data: Buffer): void => {
    if (!data.length || ended) return;
    metrics.inBytes += data.length; child.write(mouse ? mouse.push(data) : data);
    // xterm parses a write on a later timer tick (>= 1 ms in Node) unless it follows user input;
    // flagging input (public API, empty data) makes the agent's echo parse at once.
    term?.input('', true);
  };
  const onInput = (chunk: Buffer): void => {
    if (escapeTimer) clearTimeout(escapeTimer);
    const result = filter.push(chunk);
    send(result.data);
    if (result.home) { finish('home key'); return; }
    escapeTimer = setTimeout(() => send(filter.flush()), 30);
  };
  stdin.on('data', onInput);
  if (early) onInput(Buffer.from(early, 'latin1'));

  const onResize = (): void => {
    ({ cols, rows } = size());
    metrics.size = { cols, rows };
    child.resize(cols, rows - 1);
    if (term) { term.resize(cols, rows - 1); barPrevious = null; fullRedraw = true; scheduled = false; requestRender(); }
  };
  process.on('SIGWINCH', onResize);

  const finish = (reason: string): void => {
    if (ended) return;
    ended = true;
    if (escapeTimer) clearTimeout(escapeTimer);
    if (syncTimer) clearTimeout(syncTimer);
    const cpu = process.cpuUsage();
    metrics.cpu = { user: cpu.user / 1000, system: cpu.system / 1000 };
    metrics.elapsedMs = performance.now() - started;
    metrics.startup = readyAt ? readyAt - started : -1;
    metrics.dropped = passthrough?.dropped ?? {};
    metrics.modeLog = passthrough?.modeLog ?? [];
    metrics.mouseDropped = mouse?.dropped ?? 0;
    stdout.write(RESET_MODES + '\x1b[?1049l');
    stdin.setRawMode(false); stdin.pause();
    try { child.kill('SIGHUP'); } catch { /* the child already exited; nothing to stop */ }
    if (options.metrics) writeFileSync(options.metrics, JSON.stringify({ ...metrics, reason }, null, 1));
    process.stderr.write(`bar spike: ${reason}\n`);
    setTimeout(() => process.exit(0), 20);
  };
  child.onExit(() => setTimeout(() => finish('program exited'), 30));
  process.on('SIGTERM', () => finish('SIGTERM'));
  process.on('SIGHUP', () => finish('SIGHUP'));
  process.on('uncaughtException', error => { finish(`error: ${error.message}`); });
}

void main().catch((error: unknown) => {
  stdout.write(RESET_MODES + '\x1b[?1049l');
  try { stdin.setRawMode(false); } catch { /* not a TTY any more */ }
  process.stderr.write(`bar spike failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});

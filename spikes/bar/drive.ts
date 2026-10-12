// Throwaway spike code (v0.2.1b). Drives bar.ts inside an outer node-pty PTY, the way a terminal
// would, and measures it. The outer headless xterm (modern widths) stands in for the user's
// terminal: it answers DA/CPR like Terminal.app would and shows what the user would see.
//
//   node --import tsx spikes/bar/drive.ts latency echo|vim raw|redraw [keys]
//   node --import tsx spikes/bar/drive.ts cpu raw|redraw [seconds] [noise|yes]
//   node --import tsx spikes/bar/drive.ts fidelity <scenario>      (runs raw, then redraw, compares)
//   node --import tsx spikes/bar/drive.ts home                      (Ctrl+E forms in redraw mode)
//   node --import tsx spikes/bar/drive.ts agent claude|codex raw|redraw [type]
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { modernUnicode } from './unicode.js';

const ROOT = new URL('../../', import.meta.url).pathname;
const COLS = 120, ROWS = 40;
const TMP = mkdtempSync(join(tmpdir(), 'ai-bar-spike-'));
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|\x1b[ -/]*[0-~]/g;
const strip = (text: string): string => text.replace(ANSI, '');
const percentile = (values: number[], p: number): number => { const s = [...values].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(p / 100 * s.length))] ?? NaN; };
const round = (n: number): number => Math.round(n * 100) / 100;

interface Session {
  pty: pty.IPty; outer: headless.Terminal | null; metricsFile: string; exited: Promise<number>;
  text: () => string; bytes: () => number; mark: () => number; since: (mark: number) => string;
  waitText: (needle: string, timeout?: number) => Promise<boolean>; quiet: (ms: number, timeout?: number) => Promise<void>;
  mouse: { encoding: 'default' | 'sgr' | 'utf8' | 'urxvt' }; title: string; decset: string[];
}
// mode 'direct' runs the program itself in a terminal one row shorter, with no harness: the
// reference for what the program should look like at the agent's size.
function launch(mode: 'raw' | 'redraw' | 'direct', program: string[], opts: { parse?: boolean; countOnly?: boolean; agent?: string; cols?: number; rows?: number; unicode?: string; env?: Record<string, string> } = {}): Session {
  const metricsFile = join(TMP, `metrics-${mode}-${Date.now()}.json`);
  const args = mode === 'direct' ? program.slice(1) : ['--import', 'tsx', 'spikes/bar/bar.ts', '--mode', mode, '--metrics', metricsFile, ...(opts.unicode ? ['--unicode', opts.unicode] : []), ...(opts.agent ? ['--agent', opts.agent] : ['--', ...program])];
  // The harness gets a literal small env, except for agents: bar.ts then applies the daemon's own
  // buildSpawnEnv recipe to this env, as the daemon would.
  // For agents, drop this Claude Code session's own markers, as if the daemon started from a plain
  // shell. Credentials are removed by buildSpawnEnv inside bar.ts, exactly as the daemon does.
  const env = opts.agent ? Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && !/^(CLAUDECODE|CLAUDE_CODE_)/.test(e[0]))) : { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'en_US.UTF-8', TERM: 'xterm-256color', LESSHISTFILE: '-', ...opts.env };
  const cols = opts.cols ?? COLS, rows = (opts.rows ?? ROWS) - (mode === 'direct' ? 1 : 0);
  const file = mode === 'direct' ? program[0] ?? 'false' : process.execPath;
  const child = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, cwd: ROOT, env: mode === 'direct' ? { ...env, COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm' } : env });
  let all = '', counted = 0;
  const listeners = new Set<() => void>();
  const session: Session = {
    pty: child, outer: null, metricsFile, mouse: { encoding: 'default' }, title: '', decset: [],
    exited: new Promise(resolve => child.onExit(({ exitCode }) => resolve(exitCode))),
    text: () => all, bytes: () => counted, mark: () => all.length, since: mark => all.slice(mark),
    waitText: async (needle, timeout = 10000) => {
      const deadline = performance.now() + timeout;
      while (performance.now() < deadline) {
        if (session.outer ? screenText(session.outer).includes(needle) : strip(all).includes(needle)) return true;
        await sleep(20);
      }
      return false;
    },
    quiet: async (ms, timeout = 20000) => {
      const deadline = performance.now() + timeout;
      let last = all.length, since = performance.now();
      while (performance.now() < deadline) { await sleep(50); if (all.length !== last) { last = all.length; since = performance.now(); } else if (performance.now() - since >= ms) return; }
    },
  };
  if (opts.parse !== false) {
    const outer = new headless.Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
    outer.unicode.register(modernUnicode); outer.unicode.activeVersion = modernUnicode.version;
    // Like a real terminal, answer the program's queries through the PTY.
    outer.onData(data => child.write(data));
    outer.onTitleChange(title => { session.title = title; });
    for (const final of ['h', 'l']) outer.parser.registerCsiHandler({ prefix: '?', final }, params => {
      session.decset.push(`${params.map(String).join(';')}${final}`);
      for (const p of params) { const e = p === 1006 ? 'sgr' : p === 1005 ? 'utf8' : p === 1015 ? 'urxvt' : null; if (e) session.mouse.encoding = final === 'h' ? e : 'default'; }
      return false;
    });
    session.outer = outer;
  }
  // CPU runs only count bytes: a raw flood would overflow one string within seconds.
  child.onData(data => { if (opts.countOnly) { counted += Buffer.byteLength(data); return; } all += data; session.outer?.write(data); for (const l of listeners) l(); });
  return session;
}
function screenText(term: headless.Terminal, from = 0, to = term.rows): string {
  const lines: string[] = [];
  for (let y = from; y < to; y++) lines.push(term.buffer.active.getLine(term.buffer.active.viewportY + y)?.translateToString(true) ?? '');
  return lines.join('\n');
}
interface CellShot { ch: string; w: number; fg: number; bg: number; attr: string }
function shot(term: headless.Terminal, from: number, count: number): CellShot[][] {
  const buffer = term.buffer.active, rows: CellShot[][] = [];
  for (let y = from; y < from + count; y++) {
    const line = buffer.getLine(buffer.viewportY + y), row: CellShot[] = [];
    for (let x = 0; x < term.cols; x++) {
      const c = line?.getCell(x);
      row.push(c ? { ch: c.getChars(), w: c.getWidth(), fg: c.getFgColorMode() | c.getFgColor(), bg: c.getBgColorMode() | c.getBgColor(), attr: [c.isBold(), c.isDim(), c.isItalic(), c.isUnderline(), c.isBlink(), c.isInverse(), c.isInvisible(), c.isStrikethrough(), c.isOverline()].map(Number).join('') } : { ch: '', w: 1, fg: 0, bg: 0, attr: '' });
    }
    rows.push(row);
  }
  return rows;
}
function compare(raw: CellShot[][], redraw: CellShot[][]): { differing: number; examples: string[] } {
  let differing = 0; const examples: string[] = [];
  for (let y = 0; y < Math.max(raw.length, redraw.length); y++) for (let x = 0; x < (raw[y]?.length ?? 0); x++) {
    const a = raw[y]?.[x], b = redraw[y]?.[x];
    // An empty cell and a written space with default colors look identical.
    const norm = (c?: CellShot): string => c ? `${c.ch === '' && c.w === 1 ? ' ' : c.ch}|${c.w}|${c.fg}|${c.bg}|${c.attr}` : 'none';
    if (norm(a) !== norm(b)) { differing++; if (examples.length < 6) examples.push(`row ${y + 1} col ${x + 1}: raw ${JSON.stringify(norm(a))} vs redraw ${JSON.stringify(norm(b))}`); }
  }
  return { differing, examples };
}
function modes(term: headless.Terminal, session: Session): string {
  const m = term.modes;
  return JSON.stringify({ mouse: m.mouseTrackingMode, encoding: session.mouse.encoding, paste: m.bracketedPasteMode, cursorKeys: m.applicationCursorKeysMode, focus: m.sendFocusMode });
}
const cursor = (term: headless.Terminal, offset: number): string => `${term.buffer.active.cursorY + 1 - offset},${term.buffer.active.cursorX + 1}`;

// Mouse in whatever encoding the program asked the (outer) terminal for. Rows/cols are 1-based outer coordinates.
function mouseEvent(session: Session, button: number, col: number, row: number, release = false): string | Buffer {
  if (session.mouse.encoding === 'sgr') return `\x1b[<${button};${col};${row}${release ? 'm' : 'M'}`;
  if (session.mouse.encoding === 'urxvt') return `\x1b[${(release ? 3 : button) + 32};${col};${row}M`;
  const values = [32 + (release ? 3 : button), 32 + col, 32 + row];
  // UTF-8 mode encodes values as UTF-8; the default X10 mode sends one raw byte per value.
  if (session.mouse.encoding === 'utf8') return '\x1b[M' + String.fromCharCode(...values);
  return Buffer.from([0x1b, 0x5b, 0x4d, ...values.map(v => Math.min(v, 255))]);
}
async function click(session: Session, col: number, row: number): Promise<void> {
  session.pty.write(mouseEvent(session, 0, col, row)); await sleep(30); session.pty.write(mouseEvent(session, 0, col, row, true)); await sleep(250);
}
async function wheel(session: Session, col: number, row: number, times: number): Promise<void> {
  for (let i = 0; i < times; i++) { session.pty.write(mouseEvent(session, 65, col, row)); await sleep(60); }
  await sleep(250);
}
async function stop(session: Session, keys: string[] = ['\x05']): Promise<{ code: number; metrics: Record<string, unknown> | null }> {
  const timeout = new Promise<number>(resolve => setTimeout(() => resolve(-1), 5000));
  for (const key of keys) { session.pty.write(key); const code = await Promise.race([session.exited, sleep(800).then(() => null)]); if (code !== null) break; }
  let code = await Promise.race([session.exited, timeout]);
  if (code === -1) { session.pty.kill('SIGTERM'); code = await session.exited; }
  let metrics: Record<string, unknown> | null = null;
  try { metrics = JSON.parse(readFileSync(session.metricsFile, 'utf8')) as Record<string, unknown>; } catch { metrics = null; }
  return { code, metrics };
}

// ---------- latency ----------
async function latency(program: 'echo' | 'vim', mode: 'raw' | 'redraw', keys: number): Promise<Record<string, unknown>> {
  const argv = program === 'echo' ? ['node', 'spikes/bar/echo.js'] : ['vim', '-Nu', 'NONE', '-i', 'NONE', '-n', '-c', 'set ruler', join(TMP, 'latency.txt')];
  const session = launch(mode, argv, { parse: false });
  const ready = await session.waitText(program === 'echo' ? 'READY' : 'latency.txt', 15000);
  if (!ready) throw new Error(`${program} did not start`);
  await session.quiet(300);
  if (program === 'vim') { session.pty.write('i'); await session.quiet(300); }
  // Letters that never appear in vim's mode/ruler text or in escape-free frame noise.
  const alphabet = 'bdfgjkqwxyz', samples: number[] = [];
  let timeouts = 0;
  for (let i = 0; i < keys; i++) {
    const key = alphabet[i % alphabet.length] ?? 'x', mark = session.mark(), t0 = performance.now();
    session.pty.write(key);
    let seen = false;
    while (performance.now() - t0 < 1000) {
      if (strip(session.since(mark)).includes(key)) { seen = true; break; }
      await new Promise<void>(resolve => { const off = session.pty.onData(() => { off.dispose(); resolve(); }); setTimeout(() => { off.dispose(); resolve(); }, 50); });
    }
    if (seen) samples.push(performance.now() - t0); else timeouts++;
    await sleep(15 + (i % 3) * 5);
    if (program === 'vim' && i % 70 === 69) { session.pty.write('\r'); await session.quiet(60); }
  }
  const { metrics } = await stop(session, program === 'vim' ? ['\x1b', ':qa!\r'] : ['\x03']);
  const frames = metrics?.frameMs as number[] | undefined;
  return { program, mode, keys, measured: samples.length, timeouts, p50: round(percentile(samples, 50)), p95: round(percentile(samples, 95)), p99: round(percentile(samples, 99)), max: round(Math.max(...samples)), mean: round(samples.reduce((a, b) => a + b, 0) / samples.length), renderP50: frames?.length ? round(percentile(frames, 50)) : null, renderP95: frames?.length ? round(percentile(frames, 95)) : null };
}

// ---------- cpu ----------
function psCpu(pid: number): Promise<number> {
  return new Promise(resolve => execFile('/bin/ps', ['-o', '%cpu=', '-p', String(pid)], (error, out) => resolve(error ? NaN : Number(out.trim()))));
}
async function cpu(mode: 'raw' | 'redraw', seconds: number, source: 'noise' | 'yes'): Promise<Record<string, unknown>> {
  const argv = source === 'noise' ? ['node', 'spikes/renderer/noise.js'] : ['/usr/bin/yes', 'flood line with some text to make it wider than a few cells 界'];
  const session = launch(mode, argv, { parse: false, countOnly: true });
  await sleep(1500);
  const samples: number[] = [], start = session.bytes(), t0 = performance.now();
  for (let i = 0; i < seconds; i++) { await sleep(1000); samples.push(await psCpu(session.pty.pid)); }
  const bytes = session.bytes() - start, elapsed = (performance.now() - t0) / 1000;
  // Ctrl+E while the program is still flooding: how long until the harness is gone.
  const homeStart = performance.now();
  const { metrics } = await stop(session, ['\x05']);
  const homeExitMs = round(performance.now() - homeStart);
  const cpuMs = metrics ? (metrics.cpu as { user: number; system: number }) : null, frames = metrics?.frameMs as number[] | undefined;
  return { mode, source, seconds, homeExitMs, programMBPerSec: metrics ? round((metrics.childBytes as number) / (metrics.elapsedMs as number) / 1000) : null, psAvg: round(samples.reduce((a, b) => a + b, 0) / samples.length), psMax: Math.max(...samples), processCpuPercentOfOneCore: cpuMs && metrics ? round(100 * (cpuMs.user + cpuMs.system) / (metrics.elapsedMs as number)) : null, outBytesPerSec: Math.round(bytes / elapsed), frames: metrics?.frames ?? null, renderP50: frames?.length ? round(percentile(frames, 50)) : null, renderP95: frames?.length ? round(percentile(frames, 95)) : null };
}

// ---------- fidelity ----------
type Step = (s: Session, offset: number) => Promise<void>;
interface Scenario { program: string[]; ready: string; steps: [string, Step][]; exit: string[]; unicode?: string; size?: { cols: number; rows: number } }
const key = (k: string, wait = 300): Step => async s => { s.pty.write(k); await sleep(wait); await s.quiet(150, 3000); };
function vimScenario(ttymouse: string): Scenario {
  const file = join(TMP, 'sample.ts');
  copyFileSync(join(ROOT, 'spikes/bar/render.ts'), file);
  return {
    program: ['vim', '-Nu', 'NONE', '-i', 'NONE', '-n', '-c', `set mouse=a ruler laststatus=2 ttymouse=${ttymouse}`, '-c', 'syntax on', file], ready: 'sample.ts',
    steps: [
      ['opened', key('', 100)],
      ['insert', key('ggOhello bar spike', 400)],
      ['visual', key('\x1bvjjll', 400)],
      ['split', key('\x1b:split\r', 500)],
      ['click row 5 col 10', async (s, o) => { await click(s, 10, 5 + o); await s.quiet(150, 3000); }],
      ['wheel down x3', async (s, o) => { await wheel(s, 20, 8 + o, 3); await s.quiet(150, 3000); }],
      ['click on bar row (redraw) / row 1 (raw)', async (s, o) => { if (o) { await click(s, 30, 1); } else { await sleep(300); } await s.quiet(150, 3000); }],
    ],
    exit: ['\x1b', ':qa!\r'],
  };
}
function lessScenario(): Scenario {
  const file = join(TMP, 'long.txt');
  writeFileSync(file, Array.from({ length: 3000 }, (_, i) => i === 1500 ? `line ${i} \x1b[31mneedle\x1b[0m here` : `line ${i} \x1b[3${i % 8}mcolored ${'·'.repeat(i % 40)}\x1b[0m`).join('\n'));
  return {
    program: ['less', '-R', file], ready: 'line 0',
    steps: [['opened', key('', 100)], ['space x2', key('  ', 400)], ['search needle', key('/needle\r', 500)], ['n', key('n', 300)], ['G', key('G', 400)]],
    exit: ['q'],
  };
}
const scenarios: Record<string, () => Scenario> = {
  vim: () => vimScenario('sgr'),
  'vim-x10': () => vimScenario('xterm'),
  less: lessScenario,
  patterns: () => ({ program: ['node', 'spikes/bar/patterns.js'], ready: 'waiting for a key', steps: [['patterns', key('', 200)]], exit: ['\x03'] }),
  'patterns-unicode6': () => ({ program: ['node', 'spikes/bar/patterns.js'], ready: 'waiting for a key', steps: [['patterns', key('', 200)]], exit: ['\x03'], unicode: '6' }),
  paste: () => ({ program: ['node', 'spikes/bar/paste.js'], ready: 'PASTE READY', steps: [['paste', key('\x1b[200~first line\nsecond line\n\x05 ctrl-e inside paste\nthird line\x1b[201~', 500)]], exit: ['\x03'] }),
  escape: () => ({ program: ['node', 'spikes/bar/paste.js'], ready: 'PASTE READY', steps: [['lone Esc', key('\x1b', 400)], ['Esc then [A after 100 ms', async s => { s.pty.write('\x1b'); await sleep(100); s.pty.write('[A'); await sleep(300); }]], exit: ['\x03'] }),
  altscreen: () => ({ program: ['node', 'spikes/bar/altscreen.js'], ready: 'ALT SCREEN', steps: [['alt screen', key('', 100)], ['back to normal', key('x', 400)]], exit: ['\x03'] }),
  resize: () => ({ ...vimScenario('sgr'), steps: [['opened', key('', 100)], ['resized to 100x30', async (s, o) => { const rows = o || s.outer?.rows === ROWS ? 30 : 29; s.pty.resize(100, rows); s.outer?.resize(100, rows); await sleep(600); await s.quiet(200, 3000); }]] }),
  ...Object.fromEntries(['default', 'utf8', 'sgr', 'urxvt'].map(enc => [`mouse-${enc}`, (): Scenario => ({
    program: ['node', 'spikes/bar/mousetest.js', enc], ready: 'MOUSE READY',
    steps: [
      ['click 10,5 and 100,30', async (s, o) => { await click(s, 10, 5 + o); await click(s, 100, 30 + o); }],
      ['drag from row 3 up onto the bar, release there', async (s, o) => { if (!o) { await sleep(400); return; } s.pty.write(mouseEvent(s, 0, 5, 3 + o)); await sleep(30); s.pty.write(mouseEvent(s, 32, 5, 1)); await sleep(30); s.pty.write(mouseEvent(s, 0, 5, 1, true)); await sleep(300); }],
      ['click and wheel on the bar (dropped)', async (s, o) => { if (o) { await click(s, 7, 1); await wheel(s, 7, 1, 1); } else await sleep(500); }],
    ],
    exit: ['\x03'],
  })])),
  top: () => ({ program: ['/usr/bin/top', '-s', '1', '-n', '20'], ready: 'Processes', steps: [['top running', async s => { await sleep(2500); }]], exit: ['q'] }),
};
async function runScenario(name: string, mode: 'raw' | 'redraw' | 'direct'): Promise<{ shots: Record<string, { cells: CellShot[][]; text: string; cursor: string; modes: string; title: string }>; code: number; metrics: Record<string, unknown> | null }> {
  const scenario = scenarios[name]?.();
  if (!scenario) throw new Error(`unknown scenario ${name}`);
  const session = launch(mode, scenario.program, { unicode: scenario.unicode });
  const outer = session.outer;
  if (!outer) throw new Error('no outer terminal');
  if (!await session.waitText(scenario.ready, 15000)) throw new Error(`${name} (${mode}) never showed "${scenario.ready}":\n${screenText(outer)}`);
  await session.quiet(250, 5000);
  const offset = mode === 'redraw' ? 1 : 0, shots: Record<string, { cells: CellShot[][]; text: string; cursor: string; modes: string; title: string }> = {};
  for (const [label, step] of scenario.steps) {
    await step(session, offset);
    const count = mode === 'direct' ? outer.rows : outer.rows - 1;
    shots[label] = { cells: shot(outer, offset, count), text: screenText(outer, offset, count + offset), cursor: cursor(outer, offset), modes: modes(outer, session), title: session.title };
  }
  const { code, metrics } = await stop(session, mode === 'direct' ? [...scenario.exit, '\x03'] : scenario.exit);
  return { shots, code, metrics };
}
async function fidelity(name: string): Promise<void> {
  // "raw" here is the program in a direct terminal one row shorter: the faithful reference.
  // The raw harness at rows-1 is measured too, to show why raw passthrough can't keep a row.
  const raw = await runScenario(name, 'direct'), redraw = await runScenario(name, 'redraw'), rawHarness = await runScenario(name, 'raw');
  const results: Record<string, unknown>[] = [];
  for (const label of Object.keys(redraw.shots)) {
    const a = raw.shots[label], b = redraw.shots[label];
    if (!a || !b) continue;
    const diff = compare(a.cells, b.cells);
    const harness = rawHarness.shots[label], harnessDiff = harness ? compare(a.cells, harness.cells) : null;
    results.push({ label, rawPassthroughAtRowsMinus1DifferingCells: harnessDiff?.differing ?? null, differingCells: diff.differing, examples: diff.examples, cursor: { raw: a.cursor, redraw: b.cursor }, modes: { raw: a.modes, redraw: b.modes }, title: { raw: a.title, redraw: b.title } });
  }
  const last = Object.values(redraw.shots).at(-1);
  const summary = { scenario: name, reference: 'program run directly in a terminal one row shorter', rawExit: raw.code, redrawExit: redraw.code, redrawReason: redraw.metrics?.reason, dropped: redraw.metrics?.dropped, mouseDropped: redraw.metrics?.mouseDropped, results };
  writeFileSync(join(ROOT, 'spikes/bar', `results-fidelity-${name}.json`), JSON.stringify(summary, null, 1));
  console.log(JSON.stringify(summary, null, 1));
  console.log(`--- redraw screen after "${Object.keys(redraw.shots).at(-1)}" ---\n${last?.text ?? ''}`);
  if (name === 'altscreen' || name === 'less' || name.startsWith('patterns')) console.log(`--- raw screen ---\n${Object.values(raw.shots).at(-1)?.text ?? ''}`);
}

// ---------- home key ----------
async function home(): Promise<void> {
  const forms: [string, string[]][] = [['raw 0x05', ['\x05']], ['kitty CSI 101;5u', ['\x1b[101;5u']], ['kitty with event type', ['\x1b[101;5:1u']], ['modifyOtherKeys', ['\x1b[27;5;101~']], ['split kitty', ['\x1b[10', '1;5u']], ['inside paste is text, then 0x05', ['\x1b[200~a\x05b\x1b[201~', '\x05']]];
  const out: Record<string, unknown>[] = [];
  for (const [label, chunks] of forms) {
    const session = launch('redraw', ['node', 'spikes/bar/echo.js']);
    await session.waitText('ECHO READY'); await session.quiet(200);
    let aliveBeforeLastChunk = true;
    for (const [i, chunk] of chunks.entries()) {
      if (i === chunks.length - 1) aliveBeforeLastChunk = await Promise.race([session.exited.then(() => false), sleep(300).then(() => true)]);
      session.pty.write(chunk); await sleep(150);
    }
    const code = await Promise.race([session.exited, sleep(2000).then(() => null)]);
    let reason: unknown = null;
    if (code === null) { await stop(session, ['\x03']); }
    else try { reason = (JSON.parse(readFileSync(session.metricsFile, 'utf8')) as Record<string, unknown>).reason; } catch { reason = 'no metrics'; }
    out.push({ form: label, aliveBeforeLastChunk, exitedWithin2s: code !== null, reason });
  }
  writeFileSync(join(ROOT, 'spikes/bar', 'results-home-key.json'), JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out, null, 1));
}

// ---------- agents (never send a prompt: no Enter is ever written) ----------
const redact = (text: string): string => text.replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '<email>').replace(/(sk-|key|token)[^\s│]*/gi, '<redacted>');
async function agent(name: 'claude' | 'codex', mode: 'raw' | 'redraw', type: boolean): Promise<void> {
  const session = launch(mode, [], { agent: name });
  const outer = session.outer;
  if (!outer) throw new Error('no outer terminal');
  await sleep(1500); await session.quiet(1500, 25000);
  const offset = mode === 'redraw' ? 1 : 0;
  console.log(`--- ${name} ${mode}: first screen (rows ${offset + 1}..) cursor ${cursor(outer, offset)} modes ${modes(outer, session)} ---\n${redact(screenText(outer, 0, outer.rows))}`);
  if (type) {
    // Codex may open on its update notice; Esc is its "skip" (never Enter, never "1").
    // Esc should be "skip" but didn't close it here; Ctrl+C is what dismissed it in every run.
    if (screenText(outer).includes('Skip until next version')) { session.pty.write('\x03'); await sleep(800); await session.quiet(800, 5000); console.log('dismissed the Codex update notice with Ctrl+C'); }
    if (screenText(outer).includes('Skip until next version')) { await stop(session, ['\x03', '\x05']); throw new Error('update notice still open; not typing'); }
    for (const ch of 'hello bar spike') { session.pty.write(ch); await sleep(40); }
    await session.quiet(800, 5000);
    const text = screenText(outer, 0, outer.rows);
    console.log(`--- after typing (no Enter): typed text visible=${text.includes('hello bar spike')} cursor ${cursor(outer, offset)} ---\n${redact(text)}`);
  }
  console.log(`DECSET/DECRST seen by the terminal: ${session.decset.join(' ')}`);
  // Ctrl+C quits both CLIs: the first clears the input (or arms "press again"), the second exits.
  session.pty.write('\x03'); await sleep(400);
  console.log(`after one Ctrl+C, bottom rows:\n${redact(screenText(outer, outer.rows - 4, outer.rows))}`);
  session.pty.write('\x03'); await sleep(400);
  const quitByCtrlC = await Promise.race([session.exited.then(() => true), sleep(3000).then(() => false)]);
  if (!quitByCtrlC) { session.pty.write('\x03'); await sleep(400); console.log(`after two Ctrl+C, bottom rows:\n${redact(screenText(outer, outer.rows - 4, outer.rows))}`); }
  const { code, metrics } = await stop(session, ['\x03', '\x05']);
  console.log(`quit by Ctrl+C: ${quitByCtrlC}; exit ${code}; harness reason ${String(metrics?.reason)}; frames ${String(metrics?.frames)}; dropped ${JSON.stringify(metrics?.dropped)}; mirror saw ${JSON.stringify(metrics?.modeLog)}; probe ${JSON.stringify(metrics?.probe)}`);
}

async function main(): Promise<void> {
  const [command, a, b, c] = process.argv.slice(2);
  try {
    if (command === 'latency') {
      const program = a === 'vim' ? 'vim' : 'echo', mode = b === 'raw' ? 'raw' : 'redraw';
      if (program === 'vim') writeFileSync(join(TMP, 'latency.txt'), 'latency\n');
      const result = await latency(program, mode, Number(c ?? 500));
      writeFileSync(join(ROOT, 'spikes/bar', `results-latency-${program}-${mode}.json`), JSON.stringify(result, null, 1));
      console.log(JSON.stringify(result));
    } else if (command === 'cpu') {
      const mode = a === 'raw' ? 'raw' : 'redraw', source = c === 'yes' ? 'yes' : 'noise';
      const result = await cpu(mode, Number(b ?? 30), source);
      writeFileSync(join(ROOT, 'spikes/bar', `results-cpu-${source}-${mode}.json`), JSON.stringify(result, null, 1));
      console.log(JSON.stringify(result));
    } else if (command === 'fidelity' && a) await fidelity(a);
    else if (command === 'home') await home();
    else if (command === 'agent' && (a === 'claude' || a === 'codex')) await agent(a, b === 'raw' ? 'raw' : 'redraw', c === 'type');
    else throw new Error('see the usage comment at the top of drive.ts');
  } finally { rmSync(TMP, { recursive: true, force: true }); }
  process.exit(0);
}
void main();

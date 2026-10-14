// Split latency, the spike's method on the product path: disposable daemon, Unix socket, a real client in an outer PTY.
// Typing echo in the focused pane of a 2-pane split whose other pane floods like `yes`, against a single raw attach.
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { performance } from 'node:perf_hooks';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { SessionManager } from '../src/daemon/session-manager.js';
import { DaemonServer } from '../src/daemon/server.js';
import { Logger } from '../src/daemon/log.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { getPaths, preparePaths } from '../src/shared/paths.js';
import { Connection } from '../src/client/connection.js';
import { split } from '../src/client/split.js';
import { createTheme } from '../src/client/tui/theme.js';
import { useUnicode11 } from '../src/shared/unicode-width.js';
const root = resolve('.'), entry = resolve('src/cli/index.ts'), self = resolve('scripts/measure-split.ts');
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
const env = (home: string) => ({ PATH:'/usr/bin:/bin', HOME:home, SHELL:'/bin/sh', AI_TERM_HOME:home, TERM:'xterm-256color', LANG:'en_US.UTF-8' });
const COLS = 120, ROWS = 40, NEWLINE_EVERY = 50;
// yes = an agent printing like `yes` (identical lines, so its pane's cells barely change); count = numbered lines, so
// every frame of the flooding pane changes and is drawn.
type Config = 'raw' | 'raw+count' | 'split+yes' | 'split+count';
if (process.argv[2] === 'daemon') {
 const home = process.argv[3] ?? '', flood = process.argv[4] ?? 'quiet', paths = getPaths(home); await preparePaths(paths);
 await new SettingsStore(home).set({ bar:'off' });
 for (const dir of ['echo', 'yes', 'count']) await mkdir(join(home, dir), { recursive:true });
 const recipe = { executable:process.execPath, args:[resolve('tests/fixtures/split-latency-agent.mjs')], env:env(home) };
 const log = new Logger(paths.log), manager = new SessionManager(paths, log, recipe), server = new DaemonServer(paths, manager, log);
 await manager.load();
 const echo = await manager.create({ engine:'shell', cwd:join(home, 'echo'), title:'echo' });
 const other = flood === 'quiet' ? null : await manager.create({ engine:'shell', cwd:join(home, flood), title:flood });
 await server.listen(); process.stdout.write(JSON.stringify({ echo:echo.id, flood:other?.id ?? null }) + '\n');
 process.once('SIGTERM', () => { void (async () => { await server.close(); await manager.shutdown(); process.exit(0); })(); });
} else if (process.argv[2] === 'client') {
 // What the homepage's splitSessions does, without the homepage around it.
 const home = process.argv[3] ?? '', ids = process.argv.slice(4);
 await split(ids, { connect:() => Connection.connect(getPaths(home), { entry, autoStart:false }), theme:createTheme('graphite'), truecolor:true });
 process.exit(0);
} else {
 const keys = Number(process.argv[2] ?? 500), results: Record<string, unknown>[] = [];
 const configs: Config[] = ['raw', 'raw+count', 'split+yes', 'split+count'];
 for (const round of [1, 2]) for (const config of round === 1 ? configs : [...configs].reverse()) {
  const home = await mkdtemp(join(tmpdir(), 'ai-split-latency-')); let child: pty.IPty | undefined, stopped = false;
  const daemon = spawn(process.execPath, ['--import', 'tsx', self, 'daemon', home, config === 'raw' ? 'quiet' : config.endsWith('yes') ? 'yes' : 'count'], { cwd:root, env:env(home), stdio:['ignore', 'pipe', 'pipe'] });
  const daemonExit = new Promise(r => daemon.once('exit', r)); let errors = ''; daemon.stderr.on('data', d => { errors += String(d); });
  const terminal = new headless.Terminal({ cols:COLS, rows:ROWS, scrollback:0, allowProposedApi:true }); useUnicode11(terminal); let raw = '', parse = Promise.resolve();
  try {
   const ids = await new Promise<{ echo: string; flood: string | null }>((ok, fail) => { const timeout = setTimeout(() => fail(new Error('Daemon startup timeout ' + errors)), 5000); let text = ''; daemon.stdout.on('data', d => { text += String(d); if (text.includes('\n')) { clearTimeout(timeout); ok(JSON.parse(text.trim()) as { echo: string; flood: string | null }); } }); });
   const args = config.startsWith('split') ? ['--import', 'tsx', self, 'client', home, ids.echo, ids.flood ?? ''] : ['--import', 'tsx', entry, 'debug', 'attach', ids.echo];
   child = pty.spawn(process.execPath, args, { cols:COLS, rows:ROWS, name:'xterm-256color', cwd:root, env:env(home) }); child.onExit(() => { stopped = true; });
   terminal.onData(data => { if (!stopped) child?.write(data); });
   let pending: { row: number; col: number; key: string; start: number; resolve: (value: number) => void } | undefined;
   // The cursor between complete frames: a split frame (synchronized output) can be cut across reads, with the cursor
   // parked in the flooding pane until its end.
   let stable = { row:0, col:0 };
   child.onData(data => { const arrived = performance.now(); raw += data; parse = parse.then(() => new Promise<void>(done => terminal.write(data, () => {
    const expected = pending, settled = !terminal.modes.synchronizedOutputMode;
    if (settled) stable = { row:terminal.buffer.active.cursorY, col:terminal.buffer.active.cursorX };
    if (expected && settled) { const buffer = terminal.buffer.active, cell = buffer.getLine(buffer.viewportY + expected.row)?.getCell(expected.col);
     if (cell?.getChars() === expected.key && buffer.cursorX === expected.col + 1 && buffer.cursorY === expected.row) { pending = undefined; expected.resolve(arrived - expected.start); } }
    done();
   }))); });
   const deadline = performance.now() + 8000;
   const visible = () => Array.from({ length:ROWS }, (_, y) => terminal.buffer.active.getLine(terminal.buffer.active.viewportY + y)?.translateToString(true) ?? '').join('\n');
   while (!visible().includes('ECHO_READY') || config.startsWith('split') && !visible().includes('each pane is its own agent')) { if (stopped || performance.now() > deadline) throw new Error('Agent readiness failed ' + errors + ' ' + raw.slice(-500)); await sleep(20); }
   // Let the flood reach its steady state (the daemon pauses its PTY whenever a reader falls behind).
   await sleep(config === 'raw' ? 350 : 1500); await parse;
   const alphabet = 'bdfgjkqwxz', samples: number[] = [], before = raw.length, began = performance.now();
   for (let i = 0; i < keys + 50; i++) {
    if (i > 0 && i % NEWLINE_EVERY === 0) { child.write('\r'); await sleep(100); await parse; }
    await parse; const key = alphabet[i % alphabet.length] ?? 'x';
    const value = await new Promise<number>((ok, fail) => {
     const timeout = setTimeout(() => { pending = undefined; fail(new Error(`Echo timeout ${config} ${i}`)); }, 1000);
     pending = { row:stable.row, col:stable.col, key, start:performance.now(), resolve:v => { clearTimeout(timeout); ok(v); } }; child?.write(key);
    });
    if (i >= 50) samples.push(value);
    await sleep(15 + (i % 3) * 5);
   }
   samples.sort((a, b) => a - b); const p = (n: number) => Math.round((samples[Math.floor(samples.length * n)] ?? 0) * 100) / 100;
   // Outer bytes per second while measuring: proves the flooding pane really drew during the split run.
   const outerKBps = Math.round((raw.length - before) / 1024 / ((performance.now() - began) / 1000));
   const result = { round, config, measured:samples.length, outerKBps, timeouts:0, cols:COLS, rows:ROWS, p50:p(.5), p95:p(.95), p99:p(.99), max:Math.round((samples.at(-1) ?? 0) * 100) / 100 };
   results.push(result); process.stdout.write(JSON.stringify(result) + '\n');
   child.write('\x05'); await sleep(150);
  } finally { if (child && !stopped) child.kill(); terminal.dispose(); daemon.kill('SIGTERM'); await daemonExit; await rm(home, { recursive:true, force:true }); }
 }
 await writeFile(resolve('docs/testing/v0.3-split-latency.json'), JSON.stringify({ method:`outer PTY ${COLS}x${ROWS} write to arrival of the chunk that shows the typed cell and moves the cursor; real daemon, sockets and client; 50 warmup, ${keys} keys, 15/20/25 ms gaps; yes = an agent printing like yes; count = numbered lines as fast; split = 2 panes, echo focused, the other flooding`, node:process.version, platform:`${process.platform} ${process.arch}`, results }, null, 2) + '\n');
}

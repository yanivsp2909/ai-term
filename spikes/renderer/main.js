import pty from 'node-pty';
import headless from '@xterm/headless';
import { performance } from 'node:perf_hooks';
import { parseInput } from './input.js';
import { makeScreen, layout } from './screen.js';
import { diffFrame } from './grid.js';

const engine = process.argv[2];
if (!['ink', 'grid'].includes(engine) || !process.stdout.isTTY || !process.stdin.isTTY) {
  process.stderr.write('Usage (in a terminal): node spikes/renderer/main.js ink|grid [--crash]\n');
  process.exit(2);
}
const write = process.stdout.write.bind(process.stdout);
let bytes = 0, buckets = [], bucketStart = 0, frames = [], latencies = [], keys = [], firstFrame = null, previous = null;
let child, terminal, ink, timer, crashTimer, stopping = false, busy = false, dirty = true, input = '';
let nextPreview = 0, cachedGrid, forceRedraw = true;
const restore = () => { process.stdin.setRawMode(false); process.stdin.pause(); write('\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?7h\x1b[?1049l'); };
process.stdout.write = function(chunk, ...args) {
  bytes += Buffer.byteLength(chunk);
  return write(chunk, ...args);
};
const summary = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { n: sorted.length, avg: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null, max: sorted.at(-1) ?? null };
};
async function finish(error) {
  if (stopping) return;
  stopping = true;
  clearInterval(timer); clearTimeout(crashTimer);
  process.stdin.off('data', onInput);
  try { ink?.unmount(); child?.kill(); terminal?.dispose(); }
  finally {
    restore();
    process.stdout.write = write;
    const duration = firstFrame === null ? 0 : (performance.now() - firstFrame) / 1000;
    process.stderr.write(`\nAITERM_METRICS ${JSON.stringify({ engine, duration, startupMs: firstFrame, frames: summary(frames), latencyMs: summary(latencies), stdoutBytes: bytes, bytesPerSecond: duration ? bytes / duration : null, secondBuckets: buckets, error: error?.message ?? null })}\n`);
    if (error) process.stderr.write(`Prototype failed: ${error.message}\n`);
    process.exitCode = error ? 1 : 0;
  }
}
function onInput(chunk) {
  const timestamp = performance.now();
  for (const char of parseInput(chunk)) {
    if (char === '\x03') { void finish(); return; }
    if (char === '\x7f') input = [...input].slice(0, -1).join('');
    else if (char === '\r' || char === '\n') input = '';
    else if (char >= ' ' && char !== '\x1b') input = (input + char).slice(-200);
  }
  keys.push(timestamp); dirty = true;
  void draw(true);
}
function resize() {
  const cols = process.stdout.columns, rows = process.stdout.rows;
  const size = layout(cols, rows);
  terminal?.resize(size.previewCols, size.previewRows);
  child?.resize(size.previewCols, size.previewRows);
  previous = null; forceRedraw = true; dirty = true;
  if (ink) ink.clear();
  void draw(true);
}
async function draw(immediate = false) {
  if (stopping || busy || (!dirty && !immediate)) return;
  if (!immediate && performance.now() < nextPreview) return;
  busy = true; dirty = false;
  const started = performance.now();
  const pendingKeys = keys; keys = [];
  try {
    const grid = makeScreen(process.stdout.columns, process.stdout.rows, terminal, input);
    // Input can render immediately without advancing the live preview above 30 Hz.
    const previewDue = started >= nextPreview || forceRedraw;
    if (!previewDue && cachedGrid && cachedGrid.length === grid.length) {
      const size = layout(process.stdout.columns, process.stdout.rows);
      for (let y = 3; y < 3 + terminal.rows; y++) {
        for (let x = size.left + 4; x < size.left + 4 + terminal.cols; x++) {
          if (grid[y]?.[x] && cachedGrid[y]?.[x]) grid[y][x] = cachedGrid[y][x];
        }
      }
    } else { nextPreview = started + 1000 / 30; }
    cachedGrid = grid; forceRedraw = false;
    if (engine === 'grid') {
      const output = diffFrame(grid, previous);
      await new Promise((resolve, reject) => process.stdout.write(output, error => error ? reject(error) : resolve()));
      previous = grid;
    } else {
      const { inkFrame, startInk } = await import('./ink.js');
      if (stopping) return;
      if (!ink) ink = startInk(grid); else ink.rerender(inkFrame(grid));
      await ink.waitUntilRenderFlush();
    }
    if (stopping) return;
    const ended = performance.now();
    frames.push(ended - started);
    pendingKeys.forEach(t => latencies.push(ended - t));
    if (firstFrame === null) {
      firstFrame = ended; bucketStart = bytes;
      if (!process.stderr.isTTY) process.stderr.write(`\nAITERM_READY ${JSON.stringify({engine,cols:process.stdout.columns,rows:process.stdout.rows,startupMs:firstFrame})}\n`);
    }

  } catch (error) { await finish(error); }
  finally { busy = false; if (keys.length) void draw(true); }
}
process.once('SIGINT', () => void finish());
process.once('SIGTERM', () => void finish());
process.once('uncaughtException', error => void finish(error));
process.once('unhandledRejection', error => void finish(error instanceof Error ? error : new Error(String(error))));
process.once('exit', restore);
process.on('SIGWINCH', resize);
process.stdout.on('error', error => void finish(error));
try {
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', onInput);
  write('\x1b[?1049h\x1b[?25l\x1b[?7l');
  const size = layout(process.stdout.columns, process.stdout.rows);
  terminal = new headless.Terminal({ cols: size.previewCols, rows: size.previewRows, scrollback: 100, allowProposedApi: true });
  // The child receives a literal minimal environment; no inherited credentials or routing.
  child = pty.spawn(process.execPath, [new URL('./noise.js', import.meta.url).pathname], { cols: size.previewCols, rows: size.previewRows, cwd: new URL('../../', import.meta.url).pathname, env: {PATH:'/usr/bin:/bin',TERM:'xterm-256color',COLORTERM:'truecolor',LANG:'en_US.UTF-8'} });
  child.onData(data => terminal.write(data, () => { dirty = true; }));
  child.onExit(event => { if (!stopping) void finish(new Error(`Noise PTY exited ${event.exitCode}`)); });
  timer = setInterval(() => void draw(), 2);
  const bucketTimer = setInterval(() => { if (firstFrame !== null) { buckets.push(bytes - bucketStart); bucketStart = bytes; } }, 1000);
  bucketTimer.unref();
  if (process.argv.includes('--crash')) crashTimer = setTimeout(() => { throw new Error('intentional renderer crash'); }, 1200);
  await draw(true);
} catch (error) { await finish(error); }

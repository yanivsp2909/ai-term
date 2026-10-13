// Runs the unchanged spike against a disposable vim file; only query replies and numeric exit
// evidence are reported. No agent, daemon, login, notification or user state is opened.
import { performance } from 'node:perf_hooks';
import { Buffer } from 'node:buffer';
import { createRequire } from 'node:module';
import { register } from 'tsx/esm/api';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mode = process.argv[2] ?? 'redraw';
if (!['raw', 'redraw'].includes(mode)) throw new Error('Mode must be raw or redraw');
if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('Run in Terminal.app');
const traceEnabled = process.argv.slice(3).includes('--trace');
const home = mkdtempSync(join(tmpdir(), 'ai-term-bar-diagnostic-'));
const metrics = join(home, 'metrics.json');
const leave = join(home, 'leave.json');
const trace = { size: null, outerInput: [], childInput: [], autoQuitSent: false,
  stdinEnded: false, stdinClosed: false, inputReadError: false, vimLeave: null,
  exitedAfterMs: null, processAliveAtExitEvent: null, killSignals: [], inputBytesOmitted: 0, childClosedAfterMs: null };
let spawnedAt = 0, childEnded = false, inputCaptured = 0, outputTail = '', quitTimer;
// Trace recognized reports only, with a byte cap and a one-second startup window. This cannot
// print pasted/typed text; anything outside terminal reports is count-only.
// eslint-disable-next-line no-control-regex -- terminal input framing
const REPORT = /(?:\x1b\](?:10|11);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1b\[[?>][\d;]*c|\x1b\[\?\d+u|\x1b\[\??\d+;\d+R|\x1b\[[IO]|\x1b\[\?\d+;\d+\$y|\x1b\[<\d+;\d+;\d+[Mm])/g;
const captures = new Map();
function capture(entries, data) {
  if (!traceEnabled || !spawned || trace.autoQuitSent || performance.now() - spawnedAt > 1000) return;
  const bytes = Buffer.from(data);
  if (inputCaptured + bytes.length > 4096) { trace.inputBytesOmitted += bytes.length; return; }
  inputCaptured += bytes.length;
  // Keep at most 4 KB in memory across the two streams, so a reply split across reads is still
  // recognized. Only the allowlisted matches leave memory; all other bytes are count-only.
  const state = captures.get(entries) ?? { text: '', count: 0 };
  state.text += bytes.toString('latin1');
  const reports = state.text.match(REPORT) ?? [];
  for (const report of reports.slice(state.count)) entries.push({ ms: Math.round(performance.now() - spawnedAt), hex: Buffer.from(report, 'latin1').toString('hex') });
  state.count = reports.length;
  captures.set(entries, state);
}
const require = createRequire(import.meta.url), nodePty = require('node-pty');
const originalSpawn = nodePty.spawn;
let spawned = false, childExit = null, childBytes = 0, probeInput = '';
const onProbeInput = chunk => {
  capture(trace.outerInput, chunk);
  if (!spawned && probeInput.length < 4096) probeInput += chunk.toString('latin1').slice(0, 4096 - probeInput.length);
};
process.stdin.on('data', onProbeInput);
// tsx imports node-pty's CommonJS object. Instrument that object before loading the unmodified
// harness: its onExit handler otherwise discards the code and signal we need to diagnose.
nodePty.spawn = (file, args, options) => {
  spawned = true;
  spawnedAt = performance.now();
  trace.size = { cols: options.cols, rows: options.rows };
  const child = originalSpawn(file, args, { ...options, cwd: home, env: {
    PATH: '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm',
  } });
  const write = child.write.bind(child), kill = child.kill.bind(child);
  child.write = data => { capture(trace.childInput, data); return write(data); };
  child.kill = signal => { if (traceEnabled) trace.killSignals.push(signal ?? 'SIGHUP'); return kill(signal); };
  child.onExit(event => {
    childEnded = true; childExit = event;
    if (quitTimer) globalThis.clearTimeout(quitTimer);
    trace.exitedAfterMs = Math.round(performance.now() - spawnedAt);
    try { process.kill(child.pid, 0); trace.processAliveAtExitEvent = true; }
    catch (error) { if (error.code === 'ESRCH') trace.processAliveAtExitEvent = false; else trace.processAliveAtExitEvent = null; }
  });
  child.on('close', () => { trace.childClosedAfterMs = Math.round(performance.now() - spawnedAt); });
  child.onData(data => {
    childBytes += Buffer.byteLength(data);
    outputTail = (outputTail + data).slice(-256);
    if (outputTail.includes('Error reading input')) trace.inputReadError = true;
  });
  if (traceEnabled) quitTimer = globalThis.setTimeout(() => {
    if (!childEnded) { trace.autoQuitSent = true; write('\x1b:qa!\r'); }
  }, 2500);
  return child;
};
process.stdin.on('end', () => { trace.stdinEnded = true; });
process.stdin.on('close', () => { trace.stdinClosed = true; });
process.on('exit', code => {
  process.stdin.off('data', onProbeInput);
  nodePty.spawn = originalSpawn;
  let record = null, metricsReadable = true;
  try { record = JSON.parse(readFileSync(metrics, 'utf8')); }
  catch { metricsReadable = false; }
  // Restrict the trace to terminal replies; typed input is never printed or saved.
  // eslint-disable-next-line no-control-regex -- terminal reply framing
  const replies = probeInput.match(/\x1b\](?:10|11);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1b\[\?[\d;]*[cu]/g) ?? [];
  if (traceEnabled) {
    for (const state of captures.values()) trace.inputBytesOmitted += state.text.length - (state.text.match(REPORT) ?? []).join('').length;
    captures.clear();
    try { trace.vimLeave = JSON.parse(readFileSync(leave, 'utf8')); }
    catch { trace.vimLeave = null; }
  }
  const report = {
    mode, harnessExit: code, childExit, childBytes, metricsReadable,
    probeRepliesHex: replies.map(reply => Buffer.from(reply, 'latin1').toString('hex')),
    probeOtherBytes: probeInput.length - replies.join('').length,
    probe: record?.probe ?? null, startupMs: record?.startup ?? null, reason: record?.reason ?? null,
    ...(traceEnabled ? { trace } : {}),
  };
  process.stdout.write(`BAR_DIAGNOSTIC ${JSON.stringify(report)}\n`);
  rmSync(home, { recursive: true, force: true });
});
process.argv = [process.execPath, join(root, 'spikes/bar/bar.ts'), '--mode', mode,
  '--metrics', metrics, '--', '/usr/bin/vim', '-Nu', 'NONE', '-i', 'NONE', '-n',
  '-c', 'set mouse=a', '-c', 'file bar probe',
  ...(traceEnabled ? ['-c', `autocmd VimLeavePre * call writefile([json_encode({'dying':v:dying,'exiting':v:exiting,'lines':&lines,'columns':&columns,'quitCommand':histget(':',-1) =~# '^qa!\\?$' ? 'qa' : (histget(':',-1) =~# '^q!\\?$' ? 'q' : 'other')})], '${leave.replaceAll("'", "''")}')`] : [])];
register();
await import(pathToFileURL(join(root, 'spikes/bar/bar.ts')).href);

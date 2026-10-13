// Runs the unchanged spike against a disposable vim file; only query replies and numeric exit
// evidence are reported. No agent, daemon, login, notification or user state is opened.
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
const home = mkdtempSync(join(tmpdir(), 'ai-term-bar-diagnostic-'));
const metrics = join(home, 'metrics.json');
const require = createRequire(import.meta.url), nodePty = require('node-pty');
const originalSpawn = nodePty.spawn;
let spawned = false, childExit = null, childBytes = 0, probeInput = '';
const onProbeInput = chunk => {
  if (!spawned && probeInput.length < 4096) probeInput += chunk.toString('latin1').slice(0, 4096 - probeInput.length);
};
process.stdin.on('data', onProbeInput);
// tsx imports node-pty's CommonJS object. Instrument that object before loading the unmodified
// harness: its onExit handler otherwise discards the code and signal we need to diagnose.
nodePty.spawn = (file, args, options) => {
  spawned = true;
  process.stdin.off('data', onProbeInput);
  const child = originalSpawn(file, args, { ...options, cwd: home, env: {
    PATH: '/usr/bin:/bin', HOME: home, LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
    COLORTERM: 'truecolor', TERM_PROGRAM: 'AITerm',
  } });
  child.onExit(event => { childExit = event; });
  child.onData(data => { childBytes += Buffer.byteLength(data); });
  return child;
};
process.on('exit', code => {
  process.stdin.off('data', onProbeInput);
  nodePty.spawn = originalSpawn;
  let record = null, metricsReadable = true;
  try { record = JSON.parse(readFileSync(metrics, 'utf8')); }
  catch { metricsReadable = false; }
  // Restrict the trace to terminal replies; typed input is never printed or saved.
  // eslint-disable-next-line no-control-regex -- terminal reply framing
  const replies = probeInput.match(/\x1b\](?:10|11);rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)|\x1b\[\?[\d;]*[cu]/g) ?? [];
  const report = {
    mode, harnessExit: code, childExit, childBytes, metricsReadable,
    probeRepliesHex: replies.map(reply => Buffer.from(reply, 'latin1').toString('hex')),
    probeOtherBytes: probeInput.length - replies.join('').length,
    probe: record?.probe ?? null, startupMs: record?.startup ?? null, reason: record?.reason ?? null,
  };
  process.stdout.write(`BAR_DIAGNOSTIC ${JSON.stringify(report)}\n`);
  rmSync(home, { recursive: true, force: true });
});
process.argv = [process.execPath, join(root, 'spikes/bar/bar.ts'), '--mode', mode,
  '--metrics', metrics, '--', '/usr/bin/vim', '-Nu', 'NONE', '-i', 'NONE', '-n',
  '-c', 'set mouse=a', '-c', 'file bar probe'];
register();
await import(pathToFileURL(join(root, 'spikes/bar/bar.ts')).href);

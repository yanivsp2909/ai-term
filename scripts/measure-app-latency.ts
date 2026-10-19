import baseline from '../docs/testing/v0.5-app-latency.json' with {type:'json'};
import { _electron as electron } from '@playwright/test';
import { spawn as spawnPty, type IPty } from 'node-pty';
import headless from '@xterm/headless';
import { performance } from 'node:perf_hooks';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { useUnicode11, textWidth } from '../src/shared/unicode-width.js';
import type { TerminalApi } from '../app/shared/api.js';
import {fileURLToPath} from 'node:url';
import {electronLaunch} from './electron-launch.js';
interface RecordItem { time: number; kind: 'output' | 'key'; data: string }
interface Capture { records: RecordItem[]; stop: () => void }
declare global { interface Window { terminal: TerminalApi; latencyCapture?: Capture } }
const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const keys = 300, warmup = 50;
// AI_TERM_BACKGROUND: the window never shows or takes focus while it measures (as the smoke tests); it still renders.
function env(home: string): Record<string, string> { return { HOME: home, AI_TERM_HOME: join(home, '.ai-term'), AI_TERM_APP_DATA: join(home, 'electron'), PATH: '/usr/bin:/bin', SHELL: '/bin/sh', LANG: 'en_US.UTF-8', COLORTERM: 'truecolor', AI_TERM_BACKGROUND: '1' }; }
async function setup(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), 'ai-app-latency-'));
  await mkdir(join(home, '.ai-term'), { mode: 0o700 });
  await writeFile(join(home, '.ai-term/settings.json'), JSON.stringify({ theme: 'auto', notifications: false }));
  return home;
}
async function cleanup(home: string): Promise<void> {
  try {
    const pid = Number(await readFile(join(home, '.ai-term/run/daemon.pid'), 'utf8'));
    if (!Number.isSafeInteger(pid) || pid < 2) throw new Error('Invalid disposable daemon pid');
    process.kill(pid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ESRCH') break; throw error; }
      await sleep(20);
    }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  await rm(home, { recursive: true, force: true });
}
export async function measure(records: RecordItem[], cols: number, rows: number): Promise<{ p50: number; p95: number; p99: number; samples: number; max: number }> {
  const terminal = new headless.Terminal({ cols, rows, allowProposedApi: true }); useUnicode11(terminal);
  const samples: number[] = [];
  let pending: { time: number; key: string; row: number; col: number } | undefined;
  try {
    for (const record of records) {
      if (record.kind === 'key') {
        if (pending) throw new Error(`Echo mismatch samples=${samples.length} size=${cols}x${rows} pending=${JSON.stringify(pending)} row=${terminal.buffer.active.getLine(terminal.buffer.active.viewportY + pending.row)?.translateToString(true)}`);
        let cursor: { row: number; col: number } | undefined;
        const buffer = terminal.buffer.active;
        for (let row = rows - 5; row < rows; row++) for (let col = 0; col < cols; col++) {
          if (buffer.getLine(buffer.viewportY + row)?.getCell(col)?.getChars() === '█') cursor = { row, col };
        }
        if (!cursor) throw new Error('Command-bar cursor not found');
        const prompt = buffer.getLine(buffer.viewportY + cursor.row)?.translateToString(true) ?? '';
        if (prompt.includes('What do you want to build?')) cursor.col = prompt.indexOf('›') + 2;
        pending = { time: record.time, key: record.data, ...cursor };
      } else {
        await new Promise<void>(resolve => terminal.write(record.data, resolve));
        if (pending) {
          const line = terminal.buffer.active.getLine(terminal.buffer.active.viewportY + pending.row);
          if (line?.getCell(pending.col)?.getChars() === pending.key && line.getCell(pending.col + 1)?.getChars() === '█') {
            samples.push(record.time - pending.time); pending = undefined;
          }
        }
      }
    }
    if (pending || samples.length !== keys + warmup) throw new Error(`Missing cell echoes: ${samples.length}/${keys + warmup}`);
    const measured = samples.slice(warmup).sort((a, b) => a - b);
    const percentile = (n: number): number => Math.round((measured[Math.floor(measured.length * n)] ?? 0) * 100) / 100;
    return { p50: percentile(.5), p95: percentile(.95), p99: percentile(.99), max: Math.round((measured.at(-1) ?? 0) * 100) / 100, samples: measured.length };
  } finally { terminal.dispose(); }
}
export async function appCapture(options:{main?:string;executablePath?:string}={}): Promise<{ records: RecordItem[]; cols: number; rows: number; webgl: boolean }> {
  const home = await setup();
  const launch=electronLaunch(options.main??resolve('app/out/main/index.js'),options.executablePath);
  const application = await electron.launch({...launch,args:[...launch.args,'--disable-background-networking','--disable-component-update'],env:env(home)});
  try {
    const page = await application.firstWindow();
    await page.locator('.xterm-accessibility-tree').filter({ hasText: 'Connect a provider' }).waitFor();
    await page.locator('.xterm-helper-textarea').focus(); await page.keyboard.press('Escape');
    await page.waitForFunction(() => !document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('Connect a provider'));
    // tsx's name-preserving helper is outside serialized Playwright callbacks.
    await page.evaluate('globalThis.__name = value => value');
    await page.evaluate(() => {
      const records: RecordItem[] = [];
      const key = (event: KeyboardEvent): void => { if (!event.ctrlKey && !event.metaKey && event.key.length === 1) records.push({ kind: 'key', time: performance.now(), data: event.key }); };
      document.addEventListener('keydown', key, true);
      const stop = window.terminal.onOutput(data => { records.push({ kind: 'output', time: performance.now(), data }); });
      window.latencyCapture = { records, stop: () => { stop(); document.removeEventListener('keydown', key, true); } };
    });
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.setSize(1040, 720); });
    await sleep(150);
    // Preserve the frozen cell geometry while accounting for hidden native chrome.
    let height = 720;
    for (let attempt = 0; attempt < 3; attempt++) {
      const geometry = await page.evaluate(() => ({rows:document.querySelector('.xterm-accessibility-tree')?.children.length ?? 0,height:document.querySelector('.xterm-screen')?.getBoundingClientRect().height ?? 0}));
      if (geometry.rows === baseline.rows) break;
      if (!geometry.rows) throw new Error('No terminal grid');
      height += Math.round((baseline.rows - geometry.rows) * geometry.height / geometry.rows);
      await application.evaluate(({BrowserWindow}, value)=>{BrowserWindow.getAllWindows()[0]?.setSize(1040,value);},height);
      await sleep(150);
    }
    const size = await page.locator('.xterm-accessibility-tree').evaluate(tree => Array.from(tree.children, row => row.textContent ?? ''));
    const rows = size.length, cols = Math.max(...size.map(textWidth));
    if (cols !== baseline.cols || rows !== baseline.rows) throw new Error('Native app latency grid differs from frozen baseline');
    for (let index = 0; index < keys + warmup; index++) {
      if (index > 0 && index % 60 === 0) { await page.keyboard.press('Control+u'); await sleep(80); }
      await page.keyboard.press(index % 2 ? 'j' : 'z'); await sleep(15 + index % 3 * 5);
    }
    await sleep(100);
    const records = await page.evaluate(() => { window.latencyCapture?.stop(); return window.latencyCapture?.records ?? []; });
    const webgl=await page.locator('.xterm-screen canvas').count()>0;
    // The unchanged checkpoint has the old node-pty quit race. End its homepage
    // after recording, so its native exit callback finishes before app teardown.
    await page.evaluate(()=>{window.terminal.write('\x15/exit\r');});
    await page.waitForFunction(()=>document.querySelector('.xterm-accessibility-tree')?.textContent?.includes('ai exited'));
    return { records, cols, rows, webgl };
  } finally { await application.close(); await cleanup(home); }
}
async function cliCapture(cols: number, rows: number): Promise<RecordItem[]> {
  const home = await setup(), records: RecordItem[] = [];
  let terminal: IPty | undefined;
  try {
    terminal = spawnPty(process.execPath, [resolve('dist/cli/index.js')], { cols, rows, name: 'xterm-256color', cwd: resolve('.'), env: env(home) });
    let output = '';
    terminal.onData(data => { records.push({ kind: 'output', time: performance.now(), data }); output += data; });
    const deadline = Date.now() + 5000;
    while (!output.includes('Connect a provider')) { if (Date.now() > deadline) throw new Error('Disposable CLI startup timeout'); await sleep(20); }
    terminal.write('\x1b'); await sleep(100);
    for (let index = 0; index < keys + warmup; index++) {
      if (index > 0 && index % 60 === 0) { terminal.write('\x15'); await sleep(80); }
      const key = index % 2 ? 'j' : 'z';
      records.push({ kind: 'key', time: performance.now(), data: key }); terminal.write(key);
      await sleep(15 + index % 3 * 5);
    }
    await sleep(100); return records;
  } finally { terminal?.kill(); await cleanup(home); }
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
const app = await appCapture();
const appResult = await measure(app.records, app.cols, app.rows);
const cliResult = await measure(await cliCapture(app.cols, app.rows), app.cols, app.rows);
const result = {
  method: 'keydown in Electron renderer (capture phase) or direct CLI outer-PTY write, to arrival of output establishing expected command-bar character and following block-cursor cell; Unicode 11 parsed offline; 50 warmup, 300 samples, 15/20/25 ms gaps; Ctrl+U every 60 keys',
  limits: 'Output arrival, not physical display paint. Direct CLI baseline excludes Terminal.app input/paint and uses system Node; it is not a Terminal.app measurement. No app-versus-Terminal release claim.',
  date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  cols: app.cols, rows: app.rows, webgl: app.webgl, app: appResult, directCli: cliResult, terminalApp: null,
  baselineP95: baseline.app.p95, allowedRegressionP95: 0.2, p95Gate: appResult.p95 <= baseline.app.p95 + 0.2,
};
await writeFile(resolve('docs/testing/v0.5-native-app-latency.json'), JSON.stringify(result, null, 2) + '\n');
process.stdout.write(JSON.stringify(result, null, 2) + '\n');
if (!result.p95Gate) process.exitCode = 1;
}

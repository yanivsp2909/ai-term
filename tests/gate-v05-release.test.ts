import { expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { buildShellEnv, buildSpawnEnv } from '../src/daemon/env.js';
import { electronNodeNeeded } from '../src/shared/runtime-paths.js';
import { describeExit, errorTag, rendererGone, startupFailed, inputAfterExit } from '../app/main/failures.js';
import { PtyLifecycle } from '../app/main/pty-lifecycle.js';

// v0.5 release gate (2026-10-15). Each case reproduces one reviewer finding.

it('MEDIUM env: agents, shells and engine checks never inherit the launcher Electron Node flag', () => {
  const base = { PATH: '/usr/bin', HOME: '/Users/x', ELECTRON_RUN_AS_NODE: '1' };
  expect(buildShellEnv(base).ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(buildSpawnEnv('claude-code', { kind: 'account' }, base).ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(buildSpawnEnv('codex', { kind: 'account' }, base).ELECTRON_RUN_AS_NODE).toBeUndefined();
  expect(buildSpawnEnv('codex', { kind: 'key', secret: 'k'.repeat(20), provider: 'openai' }, base).ELECTRON_RUN_AS_NODE).toBeUndefined();
  // Only a daemon that is itself the plain Electron binary (dev app) needs it for its status-line commands.
  expect(buildSpawnEnv('claude-code', { kind: 'account' }, base, { keepElectronNode: true }).ELECTRON_RUN_AS_NODE).toBe('1');
});

it('MEDIUM env: only a daemon running as the plain Electron binary needs Electron Node mode for its helpers', () => {
  expect(electronNodeNeeded('/Applications/AI Term.app/Contents/MacOS/ai-node', '44.7.2')).toBe(false);
  expect(electronNodeNeeded('/repo/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', '44.7.2')).toBe(true);
  expect(electronNodeNeeded('/opt/homebrew/bin/node', undefined)).toBe(false);
});

// LOW/MEDIUM devtools (--remote-debugging-port / --inspect on the packaged binary) is not fixed: Playwright drives the
// packaged smoke suite and the latency A/B through exactly those switches, and using them needs a same-user process that
// can already run ai and reach the daemon (D35). See PROGRESS.md, Part B.

it('MEDIUM exit: a signal-killed ai reads as a failure that names the signal', () => {
  expect(describeExit({ exitCode: 0, signal: 9 })).toEqual({ text: 'ai stopped by signal 9', failed: true });
  expect(describeExit({ exitCode: 0, signal: 0 })).toEqual({ text: 'ai exited (0)', failed: false });
  expect(describeExit({ exitCode: 2 })).toEqual({ text: 'ai exited (2)', failed: true });
});

it('MEDIUM startup: a failed start logs the cause and shows a dialog before quitting', () => {
  const log = { error: vi.fn() }, showErrorBox = vi.fn(), quit = vi.fn();
  startupFailed(Object.assign(new Error('boom'), { code: 'ENOENT' }), { log, showErrorBox, quit });
  expect(log.error).toHaveBeenCalledWith('Desktop startup failed (ENOENT)');
  expect(showErrorBox).toHaveBeenCalledWith('AI Term could not start', expect.stringContaining('app.log'));
  expect(quit).toHaveBeenCalledOnce();
  // Before the logger exists there is still a dialog and a quit.
  const later = { showErrorBox: vi.fn(), quit: vi.fn() };
  startupFailed(new TypeError('x'), later);
  expect(later.showErrorBox).toHaveBeenCalledOnce(); expect(later.quit).toHaveBeenCalledOnce();
});

it('MEDIUM logs: main-process failures keep their error code or class, never the message', () => {
  expect(errorTag(Object.assign(new Error('/Users/secret/path'), { code: 'ENOENT' }))).toBe('ENOENT');
  expect(errorTag(new RangeError('sk-ant-whatever'))).toBe('RangeError');
  expect(errorTag('text')).toBe('unknown');
  expect(errorTag(Object.assign(new Error('x'), { code: 'not a code; rm -rf' }))).toBe('Error');
});

it('LOW/MEDIUM exit: after ai exits, typing and resizing are dropped quietly instead of printing a refusal each time', () => {
  expect(inputAfterExit(true)).toBe('drop');
  expect(inputAfterExit(false)).toBe('deliver');
});

it('LOW renderer: a gone renderer logs its reason from a fixed list', () => {
  expect(rendererGone({ reason: 'oom' })).toBe('Desktop renderer exited (oom)');
  expect(rendererGone({ reason: 'crashed\nforged' })).toBe('Desktop renderer exited (other)');
  expect(rendererGone(null)).toBe('Desktop renderer exited (other)');
});

it('LOW/MEDIUM quit: a client that never reports exit cannot block quit forever', async () => {
  vi.useFakeTimers();
  try {
    const failure = vi.fn(), lifecycle = new PtyLifecycle(failure);
    const stuck: Pick<IPty, 'kill' | 'onExit'> = { kill: vi.fn(), onExit: () => ({ dispose() {} }) };
    lifecycle.track(stuck);
    let settled = false; const done = lifecycle.finish().then(() => { settled = true; }, () => { settled = true; });
    await vi.advanceTimersByTimeAsync(5000);
    expect(settled).toBe(true); expect(failure).toHaveBeenCalled();
    await done;
  } finally { vi.useRealTimers(); }
});

// Second review round: control channel and v0.5 diff.
import { EventEmitter } from 'node:events';
import { ControlGate } from '../app/main/control-gate.js';
import { AppControlFilter, encodeAppControl } from '../src/shared/app-control.js';
import { AppInput } from '../src/client/app-input.js';
import { BACKGROUND_QUERY } from '../src/client/tui/theme.js';
const appToken = 'ab'.repeat(32);

it('MEDIUM S24: no control is written before the client has switched to its own screen', () => {
  const gate = new ControlGate(appToken);
  expect(gate.command('theme-changed')).toBeNull();
  expect(gate.output('starting…\r\n')).toBe('starting…\r\n');
  expect(gate.command('palette')).toBeNull();
  gate.output('\x1b[?1049h\x1b[H');
  expect(gate.command('palette')).toBe(encodeAppControl(appToken, 'palette'));
});

it('MEDIUM S24: a control echoed by a cooked terminal never reaches the screen, whole or split', () => {
  const echoed = `^[]777;ai-term;${appToken};theme-changed^[\\`, raw = encodeAppControl(appToken, 'home');
  const gate = new ControlGate(appToken);
  expect(gate.output(`before ${echoed} after`)).toBe('before  after');
  expect(gate.output(`x${raw}y`)).toBe('xy');
  let shown = '';
  for (const piece of [`one ${echoed.slice(0, 3)}`, echoed.slice(3, 40), echoed.slice(40), ' two']) shown += gate.output(piece);
  shown += gate.flush();
  expect(shown).toBe('one  two'); expect(shown).not.toContain(appToken);
  // Ordinary escapes pass at once; a held partial prefix comes out on flush.
  expect(gate.output('\x1b]11;?\x1b\\')).toBe('\x1b]11;?\x1b\\');
  expect(gate.output('tail ^[')).toBe('tail '); expect(gate.flush()).toBe('^[');
});

it('LOW: Option+[ and Esc-then-[ are released on the Escape timeout, never held until the next key', () => {
  const filter = new AppControlFilter(appToken);
  expect(filter.push(Buffer.from('\x1b['))).toEqual([]);
  expect(filter.flush().toString()).toBe('\x1b[');
  const later = new AppControlFilter(appToken);
  later.push(Buffer.from('\x1b')); expect(later.flush().toString()).toBe('\x1b');
  expect(later.push(Buffer.from('['))).toEqual([]); expect(later.flush().toString()).toBe('[');
  // A pasted marker after a released prefix still completes and passes whole.
  expect(Buffer.concat(later.push(Buffer.from('200~x')).flatMap(part => 'data' in part ? [part.data] : [])).toString()).toBe('200~x');
});

it('MEDIUM: an OSC 11 reply that arrives after its probe timed out is not typed into the agent', async () => {
  class Tty extends EventEmitter { isTTY = true; isRaw = true; setRawMode() {} resume() {} pause() {} written = ''; write(data: string) { this.written += data; return true; } }
  const tty = new Tty(), input = new AppInput(tty, appToken), seen: Buffer[] = [];
  input.on('data', (data: Buffer) => seen.push(data));
  try {
    expect(await input.background(tty)).toBeUndefined();
    expect(tty.written).toBe(BACKGROUND_QUERY);
    tty.emit('data', Buffer.from('\x1b]11;rgb:ff/ff/ff\x1b\\'));
    tty.emit('data', Buffer.from('k'));
    await expect.poll(() => Buffer.concat(seen).toString()).toBe('k');
  } finally { input.dispose(); }
});

// Fix review of the gate (2026-10-15): the scrub itself must not leak the token in any split or timing.
it('HIGH S24: an echo split right after the full caret prefix never shows the token', () => {
  const echo = `^[]777;ai-term;${appToken};home^[\\`;
  for (let at = 1; at < echo.length; at++) {
    const gate = new ControlGate(appToken);
    const shown = gate.output('a' + echo.slice(0, at)) + gate.output(echo.slice(at) + 'b') + gate.flush();
    expect(shown).toBe('ab');
  }
});
it('MEDIUM S24: a control cut by the flush timer keeps being dropped when the rest arrives', () => {
  for (const control of [encodeAppControl(appToken, 'home'), `^[]777;ai-term;${appToken};home^[\\`]) for (const at of [3, 14, 15, 40]) {
    const gate = new ControlGate(appToken);
    const shown = gate.output('ok' + control.slice(0, at)) + gate.flush() + gate.output(control.slice(at) + 'tail') + gate.flush();
    expect(shown).not.toContain(appToken.slice(0, 8));
    expect(shown.endsWith('tail')).toBe(true);
  }
});
it('LOW S24: an unterminated control drops a bounded run after its prefix and shows the rest', () => {
  const gate = new ControlGate(appToken);
  const shown = gate.output('a\x1b]777;ai-term;' + 'x'.repeat(200) + 'KEEP') + gate.flush();
  expect(shown.startsWith('a')).toBe(true); expect(shown.endsWith('KEEP')).toBe(true); expect(shown.length).toBeLessThan(200);
});
it('S24: random chunking and flush timing never show the token and keep all other text', () => {
  let seed = 7; const random = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const parts: string[] = [], expected: string[] = [];
    for (let i = 0; i < 6; i++) {
      const text = ['plain ', '\x1b[31mred\x1b[0m ', '^ caret ', '\x1b]11;?\x1b\\', 'x'][random(5)] ?? '';
      parts.push(text); expected.push(text);
      if (random(2)) parts.push(random(2) ? encodeAppControl(appToken, 'palette') : `^[]777;ai-term;${appToken};palette^[\\`);
    }
    const stream = parts.join(''), gate = new ControlGate(appToken);
    let shown = '', at = 0;
    while (at < stream.length) { const size = 1 + random(30); shown += gate.output(stream.slice(at, at + size)); at += size; if (random(3) === 0) shown += gate.flush(); }
    shown += gate.flush();
    expect(shown).not.toContain(appToken.slice(0, 6));
    expect(shown).toBe(expected.join(''));
  }
});
it('LOW: an Escape typed during the late-reply window still arrives after the Escape timeout', async () => {
  class Tty extends EventEmitter { isTTY = true; isRaw = true; setRawMode() {} resume() {} pause() {} write() { return true; } }
  const tty = new Tty(), input = new AppInput(tty, appToken), seen: Buffer[] = [];
  input.on('data', (data: Buffer) => seen.push(data));
  try {
    await input.background(tty);
    tty.emit('data', Buffer.from('a\x1b'));
    await expect.poll(() => Buffer.concat(seen).toString()).toBe('a\x1b');
  } finally { input.dispose(); }
});

import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import type { IPty } from 'node-pty';
import { buildShellEnv, buildSpawnEnv } from '../src/daemon/env.js';
import { electronNodeNeeded } from '../src/shared/runtime-paths.js';
import { debugSwitch } from '../app/main/security.js';
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

it('LOW/MEDIUM devtools: the packaged app refuses remote debugging and inspector switches', () => {
  const has = (...names: string[]) => (name: string) => names.includes(name);
  expect(debugSwitch(has('remote-debugging-port'), true)).toBe('remote-debugging-port');
  expect(debugSwitch(has('remote-debugging-pipe'), true)).toBe('remote-debugging-pipe');
  expect(debugSwitch(has('inspect'), true)).toBe('inspect');
  expect(debugSwitch(has('inspect-brk'), true)).toBe('inspect-brk');
  expect(debugSwitch(has(), true)).toBeNull();
  expect(debugSwitch(has('remote-debugging-port'), false)).toBeNull();
});

it('LOW/MEDIUM devtools: packaging turns off the Node inspector fuse and verifies it after signing', () => {
  const script = readFileSync(new URL('../scripts/package-app.mjs', import.meta.url), 'utf8');
  expect(script).toContain('electronFuses:{runAsNode:true,enableNodeCliInspectArguments:false}');
  expect(script).toMatch(/FuseV1Options\.EnableNodeCliInspectArguments/);
});

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

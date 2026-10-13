import { expect, it } from 'vitest';
import * as pty from 'node-pty';
import headless from '@xterm/headless';
import { resolve } from 'node:path';

it('the diagnostic records DA1-only startup and the actual vim exit without changing the spike', async () => {
  const child = pty.spawn(process.execPath, ['scripts/diagnose-bar.mjs'], {
    cwd: resolve('.'), cols: 120, rows: 40, name: 'xterm-256color',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' },
  });
  const terminal = new headless.Terminal({ cols: 120, rows: 40, allowProposedApi: true });
  let output = '', answered = false, finished = false;
  const exited = new Promise<number>(resolve => child.onExit(event => { finished = true; resolve(event.exitCode); }));
  child.onData(data => {
    output += data;
    terminal.write(data);
    // Terminal.app answers DA1 but supplies neither kitty nor default-color replies here.
    if (!answered && output.includes('\x1b[c')) { answered = true; child.write('\x1b[?1;2c'); }
  });
  try {
    const screen = () => Array.from({ length: terminal.rows }, (_, row) => terminal.buffer.active.getLine(row)?.translateToString(true) ?? '').join('\n');
    await expect.poll(screen, { timeout: 5000 }).toContain('bar probe');
    expect(finished).toBe(false);
    child.write(':pwd\r');
    await expect.poll(screen).toContain('ai-term-bar-diagnostic-');
    child.write('\x1b');
    child.write('iDIAGNOSTIC_TYPED');
    await expect.poll(() => output).toContain('DIAGNOSTIC_TYPED');
    child.write('\x1b:qa!\r');
    expect(await exited).toBe(0);
    const line = output.split(/\r?\n/).find(line => line.startsWith('BAR_DIAGNOSTIC '));
    expect(line).toBeDefined();
    expect(JSON.parse(line?.slice('BAR_DIAGNOSTIC '.length) ?? '{}')).toMatchObject({
      mode: 'redraw', childExit: { exitCode: 0, signal: 0 },
      probeRepliesHex: ['1b5b3f313b3263'], probe: { kitty: false }, reason: 'program exited',
    });
  } finally {
    if (!finished) child.kill('SIGTERM');
    await exited;
    terminal.dispose();
  }
}, 10000);

it('the hands-off trace records post-probe reports, PTY size and vim exit state before its timed quit', async () => {
  const child = pty.spawn(process.execPath, ['scripts/diagnose-bar.mjs', 'redraw', '--trace'], {
    cwd: resolve('.'), cols: 100, rows: 30, name: 'xterm-256color',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' },
  });
  let output = '', answered = false, finished = false, lateSent = false;
  const exited = new Promise<number>(resolve => child.onExit(event => { finished = true; resolve(event.exitCode); }));
  const colors = '\x1b]10;rgb:e6ce/e6ce/e6ce\x07\x1b]11;rgb:213d/2743/33e7\x07';
  child.onData(data => {
    output += data;
    if (!answered && output.includes('\x1b[c')) { answered = true; child.write(colors + '\x1b[?1;2c'); }
    if (!lateSent && output.includes('\x1b[?2026l')) { lateSent = true; child.write('\x1b[I\x1b[O'); }
  });
  try {
    await expect.poll(() => output, { timeout: 6000 }).toContain('BAR_DIAGNOSTIC ');
    expect(await exited).toBe(0);
    const line = output.split(/\r?\n/).find(line => line.startsWith('BAR_DIAGNOSTIC '));
    const report = JSON.parse(line?.slice('BAR_DIAGNOSTIC '.length) ?? '{}');
    expect(report.trace).toMatchObject({
      size: { cols: 100, rows: 29 }, autoQuitSent: true,
      stdinEnded: false, stdinClosed: false, inputReadError: false,
      vimLeave: { dying: 0, exiting: 0 },
    });
    expect(report.trace.outerInput.some((entry: { hex: string }) => entry.hex === '1b5b491b5b4f')).toBe(true);
    expect(report.trace.childInput.some((entry: { hex: string }) => entry.hex === '1b5b491b5b4f')).toBe(true);
    expect(report.trace.childInput.some((entry: { hex: string }) => entry.hex === Buffer.from('\x1b:qa!\r').toString('hex'))).toBe(false);
    expect(report.trace.exitedAfterMs).toBeGreaterThanOrEqual(2000);
  } finally {
    if (!finished) child.kill('SIGTERM');
    await exited;
  }
}, 10000);

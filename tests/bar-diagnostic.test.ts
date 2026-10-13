import { expect, it } from 'vitest';
import * as pty from 'node-pty';
import { resolve } from 'node:path';

it('the diagnostic records DA1-only startup and the actual vim exit without changing the spike', async () => {
  const child = pty.spawn(process.execPath, ['scripts/diagnose-bar.mjs'], {
    cwd: resolve('.'), cols: 120, rows: 40, name: 'xterm-256color',
    env: { PATH: '/usr/bin:/bin', TERM: 'xterm-256color', TERM_PROGRAM: 'Apple_Terminal' },
  });
  let output = '', answered = false, finished = false;
  const exited = new Promise<number>(resolve => child.onExit(event => { finished = true; resolve(event.exitCode); }));
  child.onData(data => {
    output += data;
    // Terminal.app answers DA1 but supplies neither kitty nor default-color replies here.
    if (!answered && output.includes('\x1b[c')) { answered = true; child.write('\x1b[?1;2c'); }
  });
  try {
    await expect.poll(() => output, { timeout: 5000 }).toContain('bar probe');
    expect(finished).toBe(false);
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
  }
}, 10000);

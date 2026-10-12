import { createServer } from 'node:net';
import { mkdtempSync, chmodSync, lstatSync, readFileSync, rmSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';

const here = dirname(fileURLToPath(import.meta.url));
const app = join(here, 'build', 'AI Term.app');
const binary = join(app, 'Contents', 'MacOS', 'AITermNotifier');
const root = mkdtempSync('/private/tmp/ai-term-notifier-'); chmodSync(root, 0o700);
const socketPath = join(root, 'click.sock'), session = randomUUID(), otherSession = randomUUID();
const processes = new Map(), readers = [], sockets = new Set();
const started = performance.now(); let closing = false, launches = 0;
function output(event, extra = {}) { process.stdout.write(JSON.stringify({ event, elapsedMs: Math.round(performance.now() - started), ...extra }) + '\n'); }
function fail() { output('harness-operation-failed'); }
function record(line, launch) {
  let value; try { value = JSON.parse(line); } catch { output('helper-fixed-error', { launch }); return; }
  // Print only allowlisted numeric/status fields; never arbitrary helper output.
  const safe = { launch };
  for (const key of ['event', 'at', 'bundle', 'status', 'sound', 'alert', 'granted', 'session', 'code', 'userNotificationsDomain']) {
    if (typeof value[key] === 'string' && value[key].length <= 80 && !/[\u0000-\u001f]/u.test(value[key])) safe[key] = value[key];
  }
  if (value.event === 'launched' && /^\d+$/.test(value.pid ?? '')) processes.set(Number(value.pid), launch);
  output('helper', safe);
}
function args(id, title, body, flags = []) { return ['--session', id, '--title', title, '--body', body, '--temp-dir', root, '--socket', socketPath, '--lifetime', '600', ...flags]; }
function launch(mode, id = session, title = 'AI Term spike', body = 'Click to send this session UUID to the harness.', flags = []) {
  const number = ++launches;
  if (mode === 'direct') {
    const child = spawn(binary, args(id, title, body, flags), { stdio: ['ignore', 'pipe', 'pipe'] });
    child.on('error', fail); processes.set(child.pid, number);
    const lines = createInterface({ input: child.stdout }); lines.on('line', line => record(line, number)); readers.push(lines);
    const errors = createInterface({ input: child.stderr }); errors.on('line', () => output('helper-fixed-error', { launch: number })); readers.push(errors);
    child.on('close', code => { processes.delete(child.pid); output('helper-exited', { launch: number, code }); });
  } else {
    const log = join(root, `launch-${number}.jsonl`), errors = join(root, `launch-${number}.errors`);
    const result = spawnSync('/usr/bin/open', ['-n', '-a', app, '--stdout', log, '--stderr', errors, '--args', ...args(id, title, body, flags)], { stdio: 'ignore' });
    output('open-returned', { launch: number, code: result.status });
    let seen = 0, reportedError = false;
    const timer = setInterval(() => {
      try {
        const lines = readFileSync(log, 'utf8').split('\n').filter(Boolean);
        for (const line of lines.slice(seen)) record(line, number); seen = lines.length;
        if (!reportedError && readFileSync(errors, 'utf8').length) { reportedError = true; output('helper-fixed-error', { launch: number }); }
      } catch (error) { if (error.code !== 'ENOENT') fail(); }
    }, 100);
    readers.push({ close: () => clearInterval(timer) });
  }
  output('launch-requested', { launch: number, mode, session: id, exitAfterPost: flags.includes('--exit-after-post') });
}
function stopHelpers() {
  for (const [pid, launchID] of processes) {
    // Reject reused PIDs: only signal a live executable at our exact freshly built bundle path.
    const result = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'comm='], { encoding: 'utf8' });
    if (result.status === 0 && result.stdout.trim() === binary) {
      try { process.kill(pid, 'SIGTERM'); output('helper-stop-requested', { launch: launchID, pid }); }
      catch (error) { if (error.code !== 'ESRCH') fail(); }
    }
    processes.delete(pid);
  }
}
const server = createServer(socket => {
  sockets.add(socket); socket.setTimeout(2000, () => socket.destroy());
  let bytes = 0, buffer = '';
  socket.on('error', fail); socket.on('close', () => sockets.delete(socket));
  socket.on('data', data => {
    bytes += data.length; if (bytes > 128) { socket.destroy(); output('callback-rejected'); return; }
    buffer += data.toString('utf8');
  });
  socket.on('end', () => {
    try {
      const value = JSON.parse(buffer.trim());
      if (Object.keys(value).length !== 1 || typeof value.clicked !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value.clicked) || ![session, otherSession].includes(value.clicked)) throw new Error();
      process.stdout.write(JSON.stringify({ clicked: value.clicked }) + '\n'); output('callback-received', { session: value.clicked });
    } catch { output('callback-rejected'); }
  });
});
server.on('error', fail);
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  if (!lstatSync(socketPath).isSocket()) { fail(); process.exitCode = 1; return; }
  output('ready', { root, socket: socketPath, session, otherSession });
  process.stdout.write('Commands: open | direct | second (post then exit) | stack (same + other session) | probe | quit-helper | quit\n');
});
const input = createInterface({ input: process.stdin });
input.on('line', line => {
  switch (line.trim()) {
    case 'open': launch('open'); break;
    case 'direct': launch('direct'); break;
    case 'second': launch('open', session, 'AI Term spike: exited helper', 'Wait for exit-after-post, quit remaining helpers, then click.', ['--exit-after-post']); break;
    case 'stack': launch('open', session, 'AI Term spike: same agent', 'Same threadIdentifier as the first banner.'); launch('open', otherSession, 'AI Term spike: another agent', 'A different threadIdentifier under the AI Term app.'); break;
    case 'probe': launch('direct', session, 'Callback transport probe', 'No notification is posted.', ['--probe-click']); break;
    case 'quit-helper': stopHelpers(); break;
    case 'quit': shutdown(); break;
    default: output('unknown-harness-command');
  }
});
function shutdown() {
  if (closing) return; closing = true; stopHelpers(); for (const reader of readers) reader.close(); input.close();
  for (const socket of sockets) socket.destroy();
  server.close(() => { try { rmSync(root, { recursive: true }); } catch { fail(); process.exitCode = 1; } });
}
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown); input.on('close', shutdown);

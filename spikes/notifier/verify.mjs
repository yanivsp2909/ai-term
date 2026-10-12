import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, chmodSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const binary = join(dirname(fileURLToPath(import.meta.url)), 'build', 'AI Term.app', 'Contents', 'MacOS', 'AITermNotifier');
const root = mkdtempSync('/private/tmp/ai-term-notifier-'); chmodSync(root, 0o700);
const socketPath = join(root, 'click.sock'), session = randomUUID(), callbacks = [];
const server = createServer(socket => { let data = ''; socket.on('data', chunk => { data += String(chunk); }); socket.on('end', () => callbacks.push(JSON.parse(data))); });
await new Promise((resolve, reject) => { server.on('error', reject); server.listen(socketPath, resolve); }); chmodSync(socketPath, 0o600);
const base = ['--session', session, '--title', 'Safe title', '--body', 'Safe body', '--temp-dir', root, '--socket', socketPath];
const replace = (name, value) => base.map((part, i) => base[i - 1] === name ? value : part);
function run(args, valid = false) {
  const result = spawnSync(binary, [...args, '--check'], { encoding: 'utf8', timeout: 3000 });
  assert.equal(result.status, valid ? 0 : 2);
  assert.equal(result.stderr, valid ? '' : 'Invalid notifier arguments\n');
  assert.ok(!result.stderr.includes('AITERMCANARY'));
}
try {
  run(base, true); let cases = 1;
  for (const args of [
    replace('--session', 'AITERMCANARY'), replace('--session', '-bad'), replace('--title', 'x'.repeat(81)), replace('--title', '😀'.repeat(81)),
    replace('--body', 'x'.repeat(201)), replace('--title', ''), replace('--body', 'AITERMCANARY\n'), replace('--title', '\u202eAITERMCANARY'),
    replace('--socket', '/tmp/click.sock'), replace('--socket', root + '/../click.sock'), replace('--socket', root + '/nested/click.sock'),
    replace('--temp-dir', '/tmp'), replace('--temp-dir', root + '/'), [...base, '--lifetime', '0'], [...base, '--lifetime', '601'],
    [...base, '--lifetime', '005'], [...base, '--unknown'], [...base, '--session', session], [...base, '--check'], [],
  ]) { run(args); cases++; }
  run(replace('--title', 'x'.repeat(80)), true); run(replace('--body', '😀'.repeat(200)), true); cases += 2;
  chmodSync(root, 0o755); run(base); chmodSync(root, 0o700); cases++;
  chmodSync(socketPath, 0o666); run(base); chmodSync(socketPath, 0o600); cases++;
  const alias = root + '-alias'; symlinkSync(root, alias);
  try { run(replace('--temp-dir', alias).map(part => part === socketPath ? alias + '/click.sock' : part)); cases++; } finally { rmSync(alias); }
  const child = spawn(binary, [...base, '--probe-click'], { stdio: ['ignore', 'pipe', 'pipe'] }); let error = '';
  child.stderr.on('data', d => { error += String(d); });
  assert.equal(await new Promise(resolve => child.on('close', resolve)), 0); assert.equal(error, '');
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(callbacks, [{ clicked: session }]);
  process.stdout.write(`Argument boundary cases: ${cases} passed. UUID-only callback probe: passed.\n`);
} finally { await new Promise(resolve => server.close(resolve)); rmSync(root, { recursive: true }); }

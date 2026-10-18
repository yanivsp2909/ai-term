import { afterEach, expect, it } from 'vitest';
import { chmod, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { RemoteService, REMOTE_ERRORS } from '../src/daemon/remote/service.js';
import type { RemoteBackend } from '../src/daemon/remote/http.js';
import { REMOTE_IDLE_MS, validateRemoteStatus } from '../src/shared/remote.js';

// v1.0.8 /remote: `tailscale serve` publishes the 127.0.0.1 server while /remote is on, and only AI Term's own entry is
// ever removed. Off after 30 idle minutes, after a daemon restart, and on /remote off. tailscale and power are stubs.
const roots: string[] = [], services: RemoteService[] = [];
afterEach(async () => { for (const s of services.splice(0)) await s.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const STATUS = { BackendState: 'Running', Self: { DNSName: 'mac.tail1234.ts.net.', UserID: 7 }, User: { 7: { LoginName: 'yaniv@example.com' } } };
async function stubTailscale(dir: string, status: unknown = STATUS, serve = '{}') {
  await writeFile(join(dir, 'status.json'), JSON.stringify(status)); await writeFile(join(dir, 'serve.json'), serve);
  const program = join(dir, 'tailscale');
  await writeFile(program, `#!/bin/sh
echo "$*" >> '${dir}/calls.log'
case "$*" in
  "status --json") cat '${dir}/status.json' ;;
  "serve --help") echo "USAGE: tailscale serve [flags] <target>"; echo "  --bg  Run the command as a background process"; echo "  --https uint  Expose an HTTPS server at the specified port" ;;
  "serve status --json") cat '${dir}/serve.json' ;;
  "serve --bg --https=8443 http://127.0.0.1:"*) port=\${4#http://127.0.0.1:}; printf '{"TCP":{"8443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:%s"}}}}}' "$port" > '${dir}/serve.json' ;;
  "serve --https=8443 off") echo '{}' > '${dir}/serve.json' ;;
  *) echo "unexpected: $*" >&2; exit 2 ;;
esac
`);
  await chmod(program, 0o755);
  return program;
}
async function setup(options: { status?: unknown; serve?: string; allowed?: boolean; ac?: boolean; program?: string | null } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-remote-svc-'))); roots.push(root);
  const program = options.program === null ? null : options.program ?? await stubTailscale(root, options.status, options.serve);
  const vault = new Map<string, string>(), stub: KeyVault = { read: async n => vault.get(n) ?? null, write: async (n, v) => { vault.set(n, v); }, remove: async n => { vault.delete(n); } };
  const backend: RemoteBackend = { agents: () => [], folders: async () => [], screen: async () => ({ lines: [], fingerprint: 'f'.repeat(64), waiting: null }), answer: async () => {}, send: async () => {}, stop: async () => {}, start: async () => ({ id: 'x', title: 'x' }) };
  let clock = Date.now(), awake = 0;
  const awakeFor: number[] = [];
  const make = () => { const s = new RemoteService({ root, keys: new KeyStore(root, { vault: stub }), backend, log: { error: () => {}, info: () => {} }, tailscale: program, allowed: async () => options.allowed ?? true, power: { onAc: async () => options.ac ?? true, keepAwake: pid => { awake++; awakeFor.push(pid); return { stop: () => { awake--; } }; } }, now: () => clock, pid: 4242 }); services.push(s); return s; };
  const calls = async () => (await readFile(join(root, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean);
  return { root, program, make, calls, tick: (ms: number) => { clock += ms; }, awake: () => awake, awakeFor };
}

it('/remote on publishes the 127.0.0.1 server with tailscale serve on its own port, shows the pairing URL, and keeps the Mac awake on AC power', async () => {
  const s = await setup(), remote = s.make();
  const status = validateRemoteStatus(await remote.on());
  expect(status).toMatchObject({ state: 'on', host: 'mac.tail1234.ts.net:8443', awake: true, phones: [] });
  expect(status.pair?.url).toMatch(/^https:\/\/mac\.tail1234\.ts\.net:8443\/pair#[A-Za-z0-9_-]{32,}$/);
  const calls = await s.calls();
  expect(calls.slice(0, 3)).toEqual(['status --json', 'serve --help', 'serve status --json']);
  expect(calls[3]).toMatch(/^serve --bg --https=8443 http:\/\/127\.0\.0\.1:\d+$/);
  expect(s.awakeFor).toEqual([4242]);
  // The log is private and never holds the code.
  const log = join(s.root, 'remote.log');
  expect((await stat(log)).mode & 0o777).toBe(0o600);
  expect(await readFile(log, 'utf8')).not.toContain(status.pair?.url.split('#')[1] ?? 'none');
  await remote.off('command');
  expect((await s.calls()).at(-1)).toBe('serve --https=8443 off');
  expect(s.awake()).toBe(0);
  expect((await remote.status()).state).toBe('off');
  expect(await readFile(log, 'utf8')).toMatch(/"action":"off".*"reason":"command"/);
});

it('no tailscale, a logged-out tailscale, the switch off in /settings, or port 8443 already yours: one line each, and nothing is served', async () => {
  for (const [options, line] of [[{ program: null }, REMOTE_ERRORS[0]], [{ status: { ...STATUS, BackendState: 'NeedsLogin' } }, REMOTE_ERRORS[1]], [{ allowed: false }, REMOTE_ERRORS[2]],
    [{ serve: '{"TCP":{"8443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:9999"}}}}}' }, REMOTE_ERRORS[3]]] as const) {
    const s = await setup(options), remote = s.make();
    await expect(remote.on()).rejects.toThrow(line);
    expect((await s.calls()).filter(c => c.startsWith('serve --bg'))).toEqual([]);
    expect((await remote.status()).state).toBe('off');
  }
});

it('turns off by itself after 30 minutes with no requests; on battery it lets the Mac sleep', async () => {
  const s = await setup({ ac: false }), remote = s.make();
  expect((await remote.on()).awake).toBe(false);
  expect(s.awake()).toBe(0);
  s.tick(REMOTE_IDLE_MS - 60_000); await remote.tick();
  expect((await remote.status()).state).toBe('on');
  s.tick(120_000); await remote.tick();
  expect((await remote.status()).state).toBe('off');
  expect((await s.calls()).at(-1)).toBe('serve --https=8443 off');
  expect(await readFile(join(s.root, 'remote.log'), 'utf8')).toMatch(/"reason":"idle"/);
});

it('a daemon restart leaves /remote off: the next start removes the old serve entry if it is still AI Term\'s', async () => {
  const s = await setup(), first = s.make();
  await first.on();
  // The daemon dies without turning it off: its state file and the serve entry are left behind.
  const port = ((await s.calls()).find(c => c.startsWith('serve --bg')) ?? '').match(/127\.0\.0\.1:(\d+)/)?.[1];
  const second = s.make();
  await second.cleanup();
  expect((await s.calls()).at(-1)).toBe('serve --https=8443 off');
  expect((await second.status()).state).toBe('off');
  await expect(stat(join(s.root, 'remote-state.json'))).rejects.toThrow();
  // Someone else's entry on that port is never touched.
  await writeFile(join(s.root, 'serve.json'), '{"TCP":{"8443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:1"}}}}}');
  await writeFile(join(s.root, 'remote-state.json'), JSON.stringify({ httpsPort: 8443, backend: `http://127.0.0.1:${port}` }));
  const before = (await s.calls()).length;
  await s.make().cleanup();
  expect((await s.calls()).slice(before)).toEqual(['serve status --json']);
});

it('/remote lists the paired phones; revoke removes one by name, and its token stops working', async () => {
  const s = await setup(), remote = s.make();
  await remote.on();
  expect((await remote.status()).phones).toEqual([]);
  await expect(remote.revoke('nobody')).rejects.toThrow(REMOTE_ERRORS[4]);
});

it('MEDIUM (reviews): a serve entry that was made but not confirmed is removed again', async () => {
  const s = await setup();
  // serve --bg succeeds, but the status read afterwards doesn't show AI Term's proxy (as if Tailscale rewrote it).
  await writeFile(s.program ?? '', (await readFile(s.program ?? '', 'utf8')).replace(`printf '{"TCP"`, `printf '{"TCP":{"8443":{"HTTPS":true}},"Web":{"mac.tail1234.ts.net:8443":{"Handlers":{"/":{"Proxy":"http://localhost:%s"}}}}}' "$port" > /dev/null; printf '{"TCP"`).replace('"Proxy":"http://127.0.0.1:%s"', '"Proxy":"http://localhost:%s"'));
  await expect(s.make().on()).rejects.toThrow("tailscale serve didn't publish");
  expect((await s.calls()).filter(c => c.includes('off') || c.startsWith('serve --bg')).map(c => c.replace(/\d+$/, 'N'))).toEqual(['serve --bg --https=8443 http://127.0.0.1:N', 'serve --https=8443 off']);
});

it('LOW (TS review): a caffeinate that can\'t start is logged, and the Mac is no longer said to stay awake', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-remote-awake-'))); roots.push(root);
  const program = await stubTailscale(root), errors: string[] = [];
  const vault: KeyVault = { read: async () => null, write: async () => {}, remove: async () => {} };
  const backend: RemoteBackend = { agents: () => [], folders: async () => [], screen: async () => ({ lines: [], fingerprint: 'f'.repeat(64), waiting: null }), answer: async () => {}, send: async () => {}, stop: async () => {}, start: async () => ({ id: 'x', title: 'x' }) };
  const remote = new RemoteService({ root, keys: new KeyStore(root, { vault }), backend, log: { error: text => errors.push(text), info: () => {} }, tailscale: program, allowed: async () => true, power: { onAc: async () => true, keepAwake: (_pid, failed) => { setImmediate(failed); return { stop: () => {} }; } }, pid: 1 });
  services.push(remote);
  await remote.on();
  await new Promise(done => setImmediate(done));
  expect((await remote.status()).awake).toBe(false);
  expect(errors).toContain("Remote: caffeinate couldn't keep the Mac awake");
});

import { afterEach, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { KeyStore, type KeyVault } from '../src/daemon/keys.js';
import { PairingCodes, RemotePhones } from '../src/daemon/remote/phones.js';
import { RemoteHttp, type RemoteBackend } from '../src/daemon/remote/http.js';
import { PAGE_JS } from '../src/daemon/remote/page.js';
import { REMOTE_CODE_MS, type RemoteAgent } from '../src/shared/remote.js';

// v1.0.8 /remote (D54): the phone server listens on 127.0.0.1 only; Tailscale serve publishes it on the tailnet. Every
// request is checked: Host, Tailscale identity, Origin, the phone's token cookie, CSRF on changes, rate limits.
const roots: string[] = [], servers: RemoteHttp[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.close(); for (const r of roots.splice(0)) await rm(r, { recursive: true, force: true }); });
const HOST = 'mac.tail1234.ts.net:8443', LOGIN = 'yaniv@example.com', ORIGIN = `https://${HOST}`;
const AGENT: RemoteAgent = { id: '6f1c2a4e-8b3d-4c5e-9f00-112233445566', title: 'fixer', engine: 'claude-code', status: 'waiting', detail: 'permission', ctx: 42, tokens: 1200, costUsd: null, waiting: 'permission' };
interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: string }
async function setup() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ai-remote-'))); roots.push(root);
  const vault = new Map<string, string>(), stub: KeyVault = { read: async n => vault.get(n) ?? null, write: async (n, v) => { vault.set(n, v); }, remove: async n => { vault.delete(n); } };
  const phones = new RemotePhones(root, new KeyStore(root, { vault: stub })), codes = new PairingCodes();
  let clock = Date.now();
  const calls: unknown[][] = [], log: Record<string, unknown>[] = [];
  let lines = ['Bash command', '  rm -rf build', 'Do you want to proceed?', '❯ 1. Yes'];
  const backend: RemoteBackend = {
    agents: () => [AGENT], folders: async () => ['/Users/me/project'],
    screen: async () => ({ lines, fingerprint: 'f'.repeat(64), waiting: 'permission' }),
    answer: async (...a) => { calls.push(['answer', ...a]); }, send: async (...a) => { calls.push(['send', ...a]); }, stop: async (...a) => { calls.push(['stop', ...a]); },
    start: async (...a) => { calls.push(['start', ...a]); return { id: AGENT.id, title: 'new' }; },
  };
  let activity = 0;
  const http = new RemoteHttp({ host: HOST, login: LOGIN, phones, codes, backend, log: entry => log.push({ ...entry }), activity: () => { activity++; }, now: () => clock }); servers.push(http);
  const port = await http.listen();
  const send = (method: string, path: string, headers: Record<string, string> = {}, body?: string) => new Promise<Reply>((done, fail) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers: { host: HOST, 'tailscale-user-login': LOGIN, ...body !== undefined ? { 'content-type': 'application/json', origin: ORIGIN } : {}, ...headers } }, res => { let text = ''; res.setEncoding('utf8'); res.on('data', c => { text += c; }); res.on('end', () => done({ status: res.statusCode ?? 0, headers: res.headers, body: text })); });
    req.on('error', fail); req.end(body);
  });
  const pair = async (name = 'pixel') => {
    const { code } = codes.issue(clock);
    const reply = await send('POST', '/api/pair', { 'x-ai-term-csrf': 'pair' }, JSON.stringify({ code, name }));
    const cookie = String(reply.headers['set-cookie']?.[0] ?? '').split(';')[0] ?? '';
    return { reply, cookie, code };
  };
  const me = async (cookie: string) => JSON.parse((await send('GET', '/api/me', { cookie })).body) as { name: string; csrf: string };
  return { root, port, phones, codes, vault, calls, log, send, pair, me, setLines: (l: string[]) => { lines = l; }, tick: (ms: number) => { clock += ms; }, activity: () => activity };
}

it('listens on 127.0.0.1 only, and a wrong Host or a foreign Tailscale user is refused before anything else', async () => {
  const s = await setup();
  expect((await s.send('GET', '/pair', { host: `127.0.0.1:${s.port}` })).status).toBe(421);
  expect((await s.send('GET', '/pair', { host: 'evil.example:8443' })).status).toBe(421);
  expect((await s.send('GET', '/pair', { 'tailscale-user-login': 'someone@else.com' })).status).toBe(403);
  expect((await s.send('GET', '/pair', { 'tailscale-user-login': '' })).status).toBe(403);
  expect(s.activity()).toBe(0);
  const ok = await s.send('GET', '/pair');
  expect(ok.status).toBe(200);
  expect(ok.headers['content-security-policy']).toContain("default-src 'none'");
  expect(ok.headers['content-security-policy']).toContain("script-src 'self'");
  expect(ok.headers['x-content-type-options']).toBe('nosniff');
  expect(s.activity()).toBe(1);
});

it('pairing: a one-time code from the fragment gives the phone a token in a Secure, HttpOnly, SameSite=Strict cookie; the Keychain keeps only its hash', async () => {
  const s = await setup();
  const { reply, cookie, code } = await s.pair();
  expect(reply.status).toBe(200);
  const set = String(reply.headers['set-cookie']?.[0] ?? '');
  for (const part of ['__Host-aiterm=', 'Secure', 'HttpOnly', 'SameSite=Strict', 'Path=/']) expect(set).toContain(part);
  const token = cookie.split('.')[1] ?? '';
  expect(token.length).toBeGreaterThanOrEqual(43);
  expect([...s.vault.values()].join('\n')).not.toContain(token);
  expect([...s.vault.keys()].every(k => k.startsWith('remote-phone:'))).toBe(true);
  expect(JSON.stringify(s.log)).not.toContain(code); expect(JSON.stringify(s.log)).not.toContain(token);
  expect(s.log.at(-1)).toMatchObject({ action: 'pair', phone: 'pixel' });
  expect((await s.me(cookie)).name).toBe('pixel');
  expect((await s.phones.list()).map(p => p.name)).toEqual(['pixel']);
});

it('a reused or expired code is refused, and pairing needs its CSRF header and the same Origin', async () => {
  const s = await setup();
  const { code } = await s.pair();
  expect((await s.send('POST', '/api/pair', { 'x-ai-term-csrf': 'pair' }, JSON.stringify({ code, name: 'again' }))).status).toBe(403);
  const late = s.codes.issue(Date.now()).code; s.tick(REMOTE_CODE_MS + 1000);
  expect((await s.send('POST', '/api/pair', { 'x-ai-term-csrf': 'pair' }, JSON.stringify({ code: late, name: 'late' }))).status).toBe(403);
  const fresh = s.codes.issue(Date.now() + REMOTE_CODE_MS + 1000).code;
  expect((await s.send('POST', '/api/pair', {}, JSON.stringify({ code: fresh, name: 'x' }))).status).toBe(403);
  expect((await s.send('POST', '/api/pair', { 'x-ai-term-csrf': 'pair', origin: 'https://evil.example' }, JSON.stringify({ code: fresh, name: 'x' }))).status).toBe(403);
  expect((await s.phones.list()).map(p => p.name)).toEqual(['pixel']);
});

it('a missing, wrong or revoked token gets nothing; a foreign Origin is refused; changes need the CSRF header', async () => {
  const s = await setup();
  expect((await s.send('GET', '/api/agents')).status).toBe(401);
  const { cookie } = await s.pair();
  const [id] = cookie.slice('__Host-aiterm='.length).split('.');
  expect((await s.send('GET', '/api/agents', { cookie: `__Host-aiterm=${id}.${'A'.repeat(43)}` })).status).toBe(401);
  expect((await s.send('GET', '/api/agents', { cookie, origin: 'https://evil.example' })).status).toBe(403);
  const agents = await s.send('GET', '/api/agents', { cookie });
  expect(agents.status).toBe(200);
  expect(JSON.parse(agents.body)).toEqual({ agents: [AGENT], folders: ['/Users/me/project'] });
  const { csrf } = await s.me(cookie);
  const path = `/api/agents/${AGENT.id}/send`, body = JSON.stringify({ text: 'run the tests' });
  expect((await s.send('POST', path, { cookie }, body)).status).toBe(403);
  expect((await s.send('POST', path, { cookie, 'x-ai-term-csrf': 'wrong' }, body)).status).toBe(403);
  expect((await s.send('POST', path, { cookie, 'x-ai-term-csrf': csrf, origin: '' }, body)).status).toBe(403);
  expect((await s.send('POST', path, { cookie, 'x-ai-term-csrf': csrf }, body)).status).toBe(200);
  expect(s.calls).toEqual([['send', AGENT.id, 'run the tests']]);
  // The log names phone, action, agent and time, and only the message's length.
  expect(s.log.at(-1)).toMatchObject({ phone: 'pixel', action: 'send', agent: 'fixer', length: 13 });
  expect(JSON.stringify(s.log)).not.toContain('run the tests');
  await s.phones.revoke('pixel');
  expect((await s.send('GET', '/api/agents', { cookie })).status).toBe(401);
});

it('a hostile agent screen reaches the phone as escaped JSON text, and the page writes it only as text', async () => {
  const s = await setup();
  s.setLines(['<script>alert(1)</script>', '<img src=x onerror=alert(2)>', 'a\u001b[31mred\u0007', '"quoted" & </pre>']);
  const { cookie } = await s.pair();
  const reply = await s.send('GET', `/api/agents/${AGENT.id}/screen`, { cookie });
  expect(reply.status).toBe(200);
  expect(reply.headers['content-type']).toBe('application/json; charset=utf-8');
  expect(reply.body).not.toMatch(/[<>]/);
  expect(reply.body).not.toContain('\u001b');
  const screen = JSON.parse(reply.body) as { lines: string[] };
  expect(screen.lines[0]).toBe('<script>alert(1)</script>');
  expect(screen.lines[2]).toBe('a?[31mred?');
  // The page builds every node with textContent: no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval.
  expect(PAGE_JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/);
});

it('approve sends back the screen it saw; start is Ask only and can\'t ask for anything else; stop is a POST', async () => {
  const s = await setup();
  const { cookie } = await s.pair(), { csrf } = await s.me(cookie), headers = { cookie, 'x-ai-term-csrf': csrf };
  expect((await s.send('POST', `/api/agents/${AGENT.id}/approve`, headers, JSON.stringify({ answer: 'yes', fingerprint: 'f'.repeat(64) }))).status).toBe(200);
  expect((await s.send('POST', `/api/agents/${AGENT.id}/approve`, headers, JSON.stringify({ answer: 'maybe', fingerprint: 'f'.repeat(64) }))).status).toBe(400);
  expect((await s.send('POST', '/api/agents', headers, JSON.stringify({ engine: 'claude-code', folder: '/Users/me/project', message: 'hi', permission: 'dontAsk' }))).status).toBe(400);
  expect((await s.send('POST', '/api/agents', headers, JSON.stringify({ engine: 'ai-term', folder: '/Users/me/project', message: 'hi' }))).status).toBe(400);
  expect((await s.send('POST', '/api/agents', headers, JSON.stringify({ engine: 'codex', folder: '/Users/me/project', message: 'hi' }))).status).toBe(200);
  expect((await s.send('GET', `/api/agents/${AGENT.id}/stop`, { cookie })).status).toBe(404);
  expect((await s.send('POST', `/api/agents/${AGENT.id}/stop`, headers, '{}')).status).toBe(200);
  expect(s.calls).toEqual([['answer', AGENT.id, true, 'f'.repeat(64)], ['start', { engine: 'codex', folder: '/Users/me/project', message: 'hi' }], ['stop', AGENT.id]]);
  expect(s.log.map(e => e.action)).toEqual(['pair', 'approve', 'start', 'stop']);
});

it('bodies must be small JSON, and repeated failures are rate limited', async () => {
  const s = await setup();
  const { cookie } = await s.pair(), { csrf } = await s.me(cookie), headers = { cookie, 'x-ai-term-csrf': csrf };
  expect((await s.send('POST', `/api/agents/${AGENT.id}/send`, headers, JSON.stringify({ text: 'x'.repeat(20_000) }))).status).toBe(413);
  expect((await s.send('POST', `/api/agents/${AGENT.id}/send`, { ...headers, 'content-type': 'text/plain' }, 'hi')).status).toBe(415);
  const statuses: number[] = [];
  for (let n = 0; n < 40; n++) statuses.push((await s.send('GET', '/api/agents', { cookie: '__Host-aiterm=0000000000000000.bad' })).status);
  expect(statuses).toContain(429);
  expect(await readFile(join(s.root, 'remote-phones.json'), 'utf8')).not.toContain(cookie.split('.')[1] ?? 'none');
});

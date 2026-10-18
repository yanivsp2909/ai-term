import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { isUUID } from '../../shared/validate.js';
import { validateRemoteStart, type RemoteAgent, type RemoteScreen, type RemoteStart } from '../../shared/remote.js';
import { COOKIE, PhoneError, type PairingCodes, type RemotePhones } from './phones.js';
import { PAGE_CSS, PAGE_HTML, PAGE_JS } from './page.js';

// v1.0.8 /remote (D54): the phone server. It listens on 127.0.0.1 only; `tailscale serve` is what puts it on your
// tailnet, over HTTPS. Every request, in this order: not rate limited; Host is the Mac's own tailnet name; the
// Tailscale identity header is your own tailnet user (Tailscale sets it for requests from your tailnet); Origin, when
// sent, is this page's own; then, except for the page itself and pairing, a paired phone's token cookie (compared in
// constant time) and, on every change, a CSRF header bound to that phone. Every action is logged; no message text is.
export class RemoteRefusal extends Error {}
export interface RemoteBackend {
  agents(): RemoteAgent[];
  folders(): Promise<string[]>;
  screen(id: string): Promise<RemoteScreen>;
  answer(id: string, yes: boolean, fingerprint: string): Promise<void>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  start(request: RemoteStart): Promise<{ id: string; title: string }>;
}
export interface RemoteLogEntry { action: string; phone?: string; phoneId?: string; agent?: string; length?: number; reason?: string }
export interface RemoteHttpOptions { host: string; login: string; phones: RemotePhones; codes: PairingCodes; backend: RemoteBackend; log: (entry: RemoteLogEntry) => void; activity: () => void; now?: () => number; fail?: (text: string) => void }
const MAX_BODY = 16 * 1024, WINDOW_MS = 60_000, FAILURE_LIMIT = 30, PHONE_LIMIT = 240, PAIR_LIMIT = 10;
const HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Cross-Origin-Resource-Policy': 'same-origin',
};
// Counts in a sliding minute per key.
class Window {
  private hits = new Map<string, number[]>();
  constructor(private limit: number) {}
  full(key: string, now: number): boolean { return (this.hits.get(key) ?? []).filter(at => now - at < WINDOW_MS).length >= this.limit; }
  add(key: string, now: number): void { const kept = (this.hits.get(key) ?? []).filter(at => now - at < WINDOW_MS); kept.push(now); this.hits.set(key, kept); }
}
// JSON that stays text even if something sniffs it as HTML: no raw < > & or line separators.
const json = (value: unknown) => JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
const shown = (line: string) => line.replace(/[\p{C}]/gu, '?').slice(0, 400);
const same = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
class Refused extends Error { constructor(readonly status: number, message: string) { super(message); } }

export class RemoteHttp {
  private server: Server | null = null;
  private secret = randomBytes(32);
  private failures = new Window(FAILURE_LIMIT); private phones = new Window(PHONE_LIMIT); private pairs = new Window(PAIR_LIMIT);
  port = 0;
  constructor(private options: RemoteHttpOptions) {}
  private now(): number { return this.options.now?.() ?? Date.now(); }
  listen(): Promise<number> {
    const server = createServer((req, res) => { void this.handle(req, res).catch(() => { this.options.fail?.('Remote: a request failed'); if (!res.headersSent) this.reply(res, 500, { error: 'Something went wrong on your Mac' }); else res.destroy(); }); });
    server.requestTimeout = 10_000; server.headersTimeout = 10_000;
    server.on('clientError', (_error, socket) => socket.destroy());
    this.server = server;
    return new Promise((done, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', () => { const address = server.address(); this.port = typeof address === 'object' && address ? address.port : 0; done(this.port); }); });
  }
  async close(): Promise<void> {
    const server = this.server; this.server = null; if (!server) return;
    await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); });
  }
  private reply(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}): void {
    res.writeHead(status, { ...HEADERS, 'Content-Type': type, ...extra });
    res.end(typeof body === 'string' ? body : json(body));
  }
  private csrf(id: string): string { return createHmac('sha256', this.secret).update(id).digest('base64url'); }
  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    if (req.headers['content-type'] !== 'application/json') throw new Refused(415, 'Send JSON');
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY) throw new Refused(413, 'Too large');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) { size += (chunk as Buffer).length; if (size > MAX_BODY) throw new Refused(413, 'Too large'); chunks.push(chunk as Buffer); }
    let parsed: unknown; try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; } catch { throw new Refused(400, 'Malformed request'); }
    const value = object(parsed); if (!value) throw new Refused(400, 'Malformed request');
    return value;
  }
  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const now = this.now();
    if (this.failures.full('all', now)) { this.reply(res, 429, { error: 'Too many refused requests · wait a minute' }); return; }
    try { await this.route(req, res, now); }
    catch (error) {
      if (error instanceof Refused) { if (error.status !== 429) this.failures.add('all', now); this.reply(res, error.status, { error: error.message }); return; }
      if (error instanceof RemoteRefusal || error instanceof PhoneError) { this.reply(res, 409, { error: error.message }); return; }
      throw error;
    }
  }
  private async route(req: IncomingMessage, res: ServerResponse, now: number): Promise<void> {
    const { host, login } = this.options, origin = req.headers.origin, own = `https://${host}`;
    if (req.headers.host !== host) throw new Refused(421, 'Wrong host');
    const user = req.headers['tailscale-user-login'];
    if (typeof user !== 'string' || !user || !same(user, login)) throw new Refused(403, 'Only your own tailnet user can use this page');
    this.options.activity();
    if (origin !== undefined && origin !== own) throw new Refused(403, 'Wrong origin');
    const path = new URL(req.url ?? '/', 'http://local').pathname, method = req.method ?? 'GET';
    if (method === 'GET' && (path === '/' || path === '/pair')) { this.reply(res, 200, PAGE_HTML, 'text/html; charset=utf-8'); return; }
    if (method === 'GET' && path === '/app.js') { this.reply(res, 200, PAGE_JS, 'text/javascript; charset=utf-8'); return; }
    if (method === 'GET' && path === '/app.css') { this.reply(res, 200, PAGE_CSS, 'text/css; charset=utf-8'); return; }
    if (method !== 'GET' && method !== 'POST') throw new Refused(405, 'Not allowed');
    // A change must come from this page: its own Origin, a JSON body, and a CSRF header (which no other site can send).
    const body = method === 'POST' ? origin === own ? await this.body(req) : (() => { throw new Refused(403, 'Wrong origin'); })() : null;
    if (method === 'POST' && path === '/api/pair') { await this.pair(req, res, body ?? {}, now); return; }
    const phone = await this.options.phones.check(cookie(req.headers.cookie));
    if (!phone) throw new Refused(401, "This phone isn't paired, or it was revoked · run /remote on on your Mac to pair it");
    if (this.phones.full(phone.id, now)) throw new Refused(429, 'Too many requests · wait a minute');
    this.phones.add(phone.id, now);
    await this.options.phones.seen(phone.id, now).catch(() => this.options.fail?.('Remote: the phone record could not be updated'));
    if (body) { const header = req.headers['x-ai-term-csrf']; if (typeof header !== 'string' || !same(header, this.csrf(phone.id))) throw new Refused(403, 'Missing or wrong CSRF header'); }
    const log = (entry: Omit<RemoteLogEntry, 'phone' | 'phoneId'>) => this.options.log({ ...entry, phone: phone.name, phoneId: phone.id });
    const agentPath = path.match(/^\/api\/agents\/([0-9a-f-]{36})\/(screen|approve|send|stop)$/), backend = this.options.backend;
    if (method === 'GET' && path === '/api/me') { this.reply(res, 200, { name: phone.name, csrf: this.csrf(phone.id) }); return; }
    if (method === 'GET' && path === '/api/agents') { log({ action: 'list' }); this.reply(res, 200, { agents: backend.agents(), folders: await backend.folders() }); return; }
    if (method === 'POST' && path === '/api/agents') {
      let start: RemoteStart; try { start = validateRemoteStart(body); } catch { throw new Refused(400, 'Pick Claude Code or Codex, a folder and a message'); }
      const made = await backend.start(start); log({ action: 'start', agent: made.title, length: Buffer.byteLength(start.message) });
      this.reply(res, 200, { id: made.id }); return;
    }
    const id = agentPath?.[1], action = agentPath?.[2];
    if (!id || !action || !isUUID(id) || (action === 'screen') !== (method === 'GET')) throw new Refused(404, 'Not found');
    const agent = backend.agents().find(a => a.id === id); if (!agent) throw new Refused(404, 'No such agent');
    if (action === 'screen') { const screen = await backend.screen(id); log({ action: 'view', agent: agent.title }); this.reply(res, 200, { lines: screen.lines.slice(-200).map(shown), fingerprint: screen.fingerprint, waiting: screen.waiting }); return; }
    const fields = Object.keys(body ?? {});
    if (action === 'approve') {
      if (fields.length !== 2 || (body?.answer !== 'yes' && body?.answer !== 'no') || typeof body.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(body.fingerprint)) throw new Refused(400, 'Answer yes or no for the screen you saw');
      await backend.answer(id, body.answer === 'yes', body.fingerprint); log({ action: body.answer === 'yes' ? 'approve' : 'deny', agent: agent.title });
    } else if (action === 'send') {
      if (fields.length !== 1 || typeof body?.text !== 'string' || !body.text.trim()) throw new Refused(400, 'Type a message');
      await backend.send(id, body.text); log({ action: 'send', agent: agent.title, length: Buffer.byteLength(body.text) });
    } else {
      if (fields.length) throw new Refused(400, 'Malformed request');
      await backend.stop(id); log({ action: 'stop', agent: agent.title });
    }
    this.reply(res, 200, { ok: true });
  }
  private async pair(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>, now: number): Promise<void> {
    if (req.headers['x-ai-term-csrf'] !== 'pair') throw new Refused(403, 'Missing or wrong CSRF header');
    if (this.pairs.full('all', now)) throw new Refused(429, 'Too many pairing attempts · wait a minute');
    this.pairs.add('all', now);
    if (Object.keys(body).length !== 2 || typeof body.name !== 'string' || !this.options.codes.redeem(body.code, now)) throw new Refused(403, 'This pairing code expired or was already used · run /remote on on your Mac for a new one');
    const name = body.name.trim().replace(/[\p{C}]/gu, '').slice(0, 40) || 'phone';
    const { phone, cookie: value } = await this.options.phones.pair(name, now);
    this.options.log({ action: 'pair', phone: phone.name, phoneId: phone.id });
    this.reply(res, 200, { ok: true }, undefined, { 'Set-Cookie': `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000` });
  }
}
function cookie(header: string | undefined): string | undefined {
  for (const part of (header ?? '').split(';')) { const [name, ...rest] = part.trim().split('='); if (name === COOKIE) return rest.join('='); }
  return undefined;
}

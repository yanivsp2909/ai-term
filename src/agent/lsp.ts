import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, realpath, stat } from 'node:fs/promises';
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isFsError } from '../shared/paths.js';
import { sandboxedArgv, type BashOptions } from './bash.js';
import { killGroup } from '../shared/kill-tree.js';

// v0.9.3 LSP diagnostics for AI Term's agent (D55, off by default: they add tokens to every write or edit). After a write
// or edit the agent gets that file's errors from a language server, as a short tool result. Only a server on PATH outside
// the worktree and any node_modules/.bin (the agent can write those). It runs under the bash sandbox (D57) with bash's
// env (no keys); without a sandbox no server starts, said once. One server per language, stopped when the agent exits or
// after 10 idle minutes. The client is a minimal LSP over stdio: initialize, didOpen/didChange, publishDiagnostics.
export const LSP_IDLE_MS = 10 * 60_000, LSP_MAX_LINES = 40, LSP_WAIT_MS = 8000, LSP_SETTLE_MS = 300;
export interface Language { id: string; server: string; args: string[]; languageId: (ext: string) => string }
const LANGUAGES: readonly (Language & { exts: readonly string[] })[] = [
  { id: 'typescript', server: 'typescript-language-server', args: ['--stdio'], exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], languageId: ext => ext.includes('ts') ? (ext === '.tsx' ? 'typescriptreact' : 'typescript') : ext === '.jsx' ? 'javascriptreact' : 'javascript' },
  { id: 'python', server: 'pyright-langserver', args: ['--stdio'], exts: ['.py', '.pyi'], languageId: () => 'python' },
  { id: 'go', server: 'gopls', args: [], exts: ['.go'], languageId: () => 'go' },
  { id: 'rust', server: 'rust-analyzer', args: [], exts: ['.rs'], languageId: () => 'rust' },
];
export function languageOf(path: string): Language | null {
  const ext = extname(path).toLowerCase();
  return LANGUAGES.find(language => language.exts.includes(ext)) ?? null;
}
const inside = (path: string, root: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);
// The first executable `name` in PATH's absolute folders that isn't in the worktree or a node_modules/.bin, by its real
// path too (a link from PATH into the worktree counts as the worktree).
export async function findServer(name: string, path: string, root: string): Promise<string | null> {
  const realRoot = await realpath(root).catch(() => root);
  for (const folder of path.split(delimiter)) {
    if (!isAbsolute(folder) || folder.split(/[\\/]/).join('/').includes('node_modules/.bin') || inside(resolve(folder), root) || inside(resolve(folder), realRoot)) continue;
    const candidate = join(folder, name);
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      const real = await realpath(candidate);
      if (inside(real, realRoot) || real.split(/[\\/]/).join('/').includes('node_modules/.bin')) continue;
      return candidate;
    } catch (error) { if (!isFsError(error, 'ENOENT') && !isFsError(error, 'EACCES') && !isFsError(error, 'ENOTDIR')) throw error; }
  }
  return null;
}
interface Diagnostic { range: { start: { line: number; character?: unknown } }; severity?: unknown; code?: unknown; message: string }
const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'];
// eslint-disable-next-line no-control-regex -- a server's text goes to the model and the screen as one plain line each.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
export function formatDiagnostics(path: string, diagnostics: readonly Diagnostic[]): string {
  if (!diagnostics.length) return `diagnostics for ${path}: none`;
  const errors = diagnostics.filter(d => typeof d.severity !== 'number' || d.severity <= 1 || d.severity > 4).length, others = diagnostics.length - errors;
  const head = `diagnostics for ${path}: ${[errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', others ? `${others} other${others === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`;
  // A server's fields as plain values: a missing column is 1, an odd severity is an error, a code that isn't a string or
  // number is left out (review: they read as NaN and [object Object]).
  const int = (value: unknown, fallback: number) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : fallback;
  const lines = diagnostics.map(d => { const code = typeof d.code === 'string' || typeof d.code === 'number' ? ` ${String(d.code).replace(CONTROL, ' ').slice(0, 20)}` : ''; return `${int(d.range.start.line, 0) + 1}:${int(d.range.start.character, 0) + 1} ${SEVERITY[int(d.severity, 1)] ?? 'error'}${code} ${d.message.replace(CONTROL, ' ').trim().slice(0, 200)}`; });
  const room = LSP_MAX_LINES - 2;
  return [head, ...lines.slice(0, lines.length > room + 1 ? room : room + 1), ...lines.length > room + 1 ? [`… ${lines.length - room} more`] : []].join('\n');
}
// One server: JSON-RPC over stdio with Content-Length framing.
class Server {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private readonly pending = new Map<number, (result: unknown) => void>();
  private readonly waiting = new Map<string, ((diagnostics: Diagnostic[] | null) => void)[]>();
  private readonly versions = new Map<string, number>();
  ready: Promise<void>;
  lastUsed = Date.now();
  envKeys: string[] = [];
  // Set when the server's pipe broke or it couldn't be stopped; the pool drops it.
  failed = false;
  constructor(private readonly child: ChildProcessWithoutNullStreams, root: string) {
    child.stdout.on('data', (chunk: Buffer) => this.read(chunk));
    // A server that died mid-write: its broken pipe marks it failed instead of crashing the agent.
    child.stdin.on('error', () => { this.failed = true; });
    // A server that ends (or never starts) answers every open request and wait with nothing, so no write waits on it.
    const gone = () => { this.failed = true; for (const resolve of this.pending.values()) resolve(null); this.pending.clear(); for (const list of this.waiting.values()) for (const resolve of list) resolve(null); this.waiting.clear(); };
    child.once('close', gone); child.once('error', gone);
    child.stderr.resume();
    this.ready = this.request('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, capabilities: { textDocument: { publishDiagnostics: {}, synchronization: { didSave: false } } }, workspaceFolders: [{ uri: pathToFileURL(root).href, name: 'root' }] })
      .then(result => { const info = (result as { serverInfo?: { env?: unknown } } | null)?.serverInfo; if (Array.isArray(info?.env)) this.envKeys = info.env.filter((key): key is string => typeof key === 'string'); this.notify('initialized', {}); });
  }
  private send(message: object): void { if (!this.child.stdin.writable) return; const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', ...message })); this.child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`); this.child.stdin.write(body); }
  request(method: string, params: unknown): Promise<unknown> { const id = this.nextId++; if (this.failed) return Promise.resolve(null); return new Promise(resolve => { this.pending.set(id, resolve); this.send({ id, method, params }); }); }
  notify(method: string, params: unknown): void { this.send({ method, params }); }
  private read(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const head = this.buffer.indexOf('\r\n\r\n'); if (head < 0) return;
      const length = Number(this.buffer.subarray(0, head).toString('ascii').match(/Content-Length: *(\d+)/i)?.[1] ?? NaN);
      if (!Number.isSafeInteger(length) || length > 8 * 1024 * 1024) { this.child.kill('SIGKILL'); return; }
      if (this.buffer.length < head + 4 + length) return;
      const body = this.buffer.subarray(head + 4, head + 4 + length); this.buffer = this.buffer.subarray(head + 4 + length);
      let message: { id?: number; method?: string; result?: unknown; params?: { uri?: string; diagnostics?: Diagnostic[] } };
      // A body that isn't JSON is the server's bug; it is skipped and the wait for diagnostics times out with a plain line.
      try { message = JSON.parse(body.toString('utf8')) as typeof message; } catch (error) { if (error instanceof SyntaxError) continue; throw error; }
      if (message.id !== undefined && !message.method) { this.pending.get(message.id)?.(message.result); this.pending.delete(message.id); continue; }
      // A request from the server (workspace/configuration and the like) gets an empty answer.
      if (message.id !== undefined && message.method) { this.send({ id: message.id, result: message.method === 'workspace/configuration' ? [] : null }); continue; }
      if (message.method === 'textDocument/publishDiagnostics' && message.params?.uri) {
        const list = Array.isArray(message.params.diagnostics) ? message.params.diagnostics.filter(d => d && typeof d.message === 'string' && Number.isSafeInteger(d.range?.start?.line)) : [];
        for (const resolve of this.waiting.get(message.params.uri) ?? []) resolve(list);
        this.waiting.delete(message.params.uri);
      }
    }
  }
  // Opens or updates the file and waits for its diagnostics: the last ones that come within a short settle after the
  // first, so a server that publishes twice (syntax, then types) is read whole. Every wait is bounded (review: one that
  // never answered initialize held the write, and the whole agent, forever) and an interrupted turn stops it at once.
  async diagnose(file: string, languageId: string, text: string, waitMs: number, signal?: AbortSignal): Promise<Diagnostic[] | 'timeout' | 'gone' | 'aborted'> {
    const within = <T>(work: Promise<T>, ms: number): Promise<T | 'timeout' | 'aborted'> => new Promise(resolve => {
      if (signal?.aborted) { resolve('aborted'); return; }
      const timer = setTimeout(() => finish('timeout'), ms); timer.unref();
      const onAbort = () => finish('aborted');
      function finish(value: T | 'timeout' | 'aborted') { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); resolve(value); }
      signal?.addEventListener('abort', onAbort, { once: true });
      void work.then(finish);
    });
    const ready = await within(this.ready.then(() => 'ready' as const), waitMs);
    if (ready !== 'ready') return ready;
    if (this.failed) return 'gone';
    this.lastUsed = Date.now();
    const uri = pathToFileURL(file).href, version = (this.versions.get(uri) ?? 0) + 1;
    const next = () => new Promise<Diagnostic[] | null>(resolve => { const list = this.waiting.get(uri) ?? []; list.push(resolve); this.waiting.set(uri, list); });
    const first = within(next(), waitMs);
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.versions.set(uri, version);
    let result = await first;
    if (result === null) return 'gone';
    if (typeof result === 'string') return result;
    for (;;) { const later = await within(next(), LSP_SETTLE_MS); if (later === null || typeof later === 'string') break; result = later; }
    this.lastUsed = Date.now();
    return result;
  }
  // The crash path: the agent is exiting now, so its group goes at once, without the polite shutdown.
  killNow(): void { const pid = this.child.pid; if (pid !== undefined && this.child.exitCode === null && this.child.signalCode === null) try { killGroup(pid, 'SIGKILL', () => { this.failed = true; }); } catch (error) { if (!isFsError(error, 'ESRCH')) this.failed = true; } }
  async stop(): Promise<void> {
    const ended = new Promise<void>(resolve => { if (this.child.exitCode !== null || this.child.signalCode !== null) resolve(); else this.child.once('close', () => resolve()); });
    if (this.child.stdin.writable) { await Promise.race([this.request('shutdown', null), new Promise(resolve => setTimeout(resolve, 1000).unref())]); this.notify('exit', null); }
    // A server that ignores exit, or left children behind, goes with its whole group a second later.
    const pid = this.child.pid;
    const kill = setTimeout(() => { if (pid !== undefined) try { killGroup(pid, 'SIGKILL', () => { this.failed = true; }); } catch (error) { if (!isFsError(error, 'ESRCH')) this.failed = true; } }, 1000); kill.unref();
    await ended; clearTimeout(kill);
  }
}
export interface LspOptions { root: string; env: Record<string, string>; sandbox: NonNullable<BashOptions['sandbox']>; waitMs?: number }
// A server that misses this many answers in a row is stopped, like one that crashed.
const MAX_SILENT = 3;
export class LspPool {
  // The start itself is kept, before any await (review: two writes at once started two servers, one never stopped).
  private readonly starting = new Map<string, Promise<Server | string>>();
  private readonly servers = new Map<string, Server>();
  // Languages whose server crashed or stopped answering: off until the agent restarts, said once.
  private readonly broken = new Set<string>();
  private readonly silent = new Map<string, number>();
  private told = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: LspOptions) { this.timer = setInterval(() => { void this.idleCheck(Date.now()); }, 60_000); this.timer.unref(); }
  running(): string[] { return [...this.servers.keys()]; }
  serverEnv(language: string): string[] { return [...this.servers.get(language)?.envKeys ?? []]; }
  // A running server for the language, or the one-time note when none can run here ('' after the first time).
  private server(language: Language): Promise<Server | string> {
    let entry = this.starting.get(language.id);
    if (!entry) { entry = this.start(language); this.starting.set(language.id, entry); }
    return entry;
  }
  private async start(language: Language): Promise<Server | string> {
    const program = await findServer(language.server, this.options.env.PATH ?? '', this.options.root); if (!program) return '';
    // bash's env (no keys) and bash's sandbox; without a sandbox nothing starts.
    const argv = await sandboxedArgv([program, ...language.args], { cwd: this.options.root, env: this.options.env, sandbox: { ...this.options.sandbox, require: false } });
    if (argv.unsandboxed) { if (this.told) return ''; this.told = true; return `diagnostics are off for this agent: language servers run only in AI Term's sandbox, and ${argv.unsandboxed}`; }
    const env = Object.fromEntries(Object.entries(this.options.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|AITERM|AI_TERM/i.test(name)));
    const child = spawn(argv.program, argv.args, { cwd: this.options.root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
    const server = new Server(child, this.options.root);
    child.once('close', () => { if (this.servers.get(language.id) === server) this.servers.delete(language.id); });
    this.servers.set(language.id, server);
    return server;
  }
  private turnOff(language: Language, server: Server): void {
    this.broken.add(language.id); this.servers.delete(language.id);
    void server.stop();
  }
  // The text for the agent after a write or edit of `path` (relative to the worktree): its diagnostics, a one-time note
  // when no server can run or one stopped, or nothing.
  async diagnose(path: string, signal?: AbortSignal): Promise<string> {
    const language = languageOf(path); if (!language || this.broken.has(language.id)) return '';
    const file = resolve(this.options.root, path), shown = relative(this.options.root, file);
    const server = await this.server(language);
    if (typeof server === 'string') { this.starting.delete(language.id); this.starting.set(language.id, Promise.resolve('')); return server; }
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (isFsError(error, 'ENOENT')) return ''; throw error; }
    const result = await server.diagnose(file, language.languageId(extname(file).toLowerCase()), text, this.options.waitMs ?? LSP_WAIT_MS, signal);
    if (result === 'aborted') return '';
    const stopped = `diagnostics for ${shown}: ${language.server} stopped; diagnostics for this language are off until the agent restarts`;
    if (result === 'gone') { this.turnOff(language, server); return stopped; }
    if (result === 'timeout') {
      const missed = (this.silent.get(language.id) ?? 0) + 1; this.silent.set(language.id, missed);
      if (missed >= MAX_SILENT) { this.turnOff(language, server); return stopped; }
      return `diagnostics for ${shown}: the language server didn't answer in time`;
    }
    this.silent.delete(language.id);
    return formatDiagnostics(shown, result);
  }
  async idleCheck(now: number): Promise<void> {
    for (const [id, server] of this.servers) if (now - server.lastUsed >= LSP_IDLE_MS) { this.servers.delete(id); this.starting.delete(id); await server.stop(); }
  }
  async stopAll(): Promise<void> {
    clearInterval(this.timer);
    // Starts still on their way are waited for, so none is left running unseen.
    const pending = await Promise.all([...this.starting.values()]); this.starting.clear();
    const all = new Set([...this.servers.values(), ...pending.filter((entry): entry is Server => typeof entry !== 'string')]); this.servers.clear();
    await Promise.all([...all].map(server => server.stop()));
  }
  // The crash path: every server's group, now.
  killNow(): void { clearInterval(this.timer); for (const server of this.servers.values()) server.killNow(); }
}

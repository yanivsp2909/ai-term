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
interface Diagnostic { range: { start: { line: number; character: number } }; severity?: number; code?: string | number; message: string }
const SEVERITY = ['error', 'error', 'warning', 'info', 'hint'];
// eslint-disable-next-line no-control-regex -- a server's text goes to the model and the screen as one plain line each.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
export function formatDiagnostics(path: string, diagnostics: readonly Diagnostic[]): string {
  if (!diagnostics.length) return `diagnostics for ${path}: none`;
  const errors = diagnostics.filter(d => (d.severity ?? 1) === 1).length, others = diagnostics.length - errors;
  const head = `diagnostics for ${path}: ${[errors ? `${errors} error${errors === 1 ? '' : 's'}` : '', others ? `${others} other${others === 1 ? '' : 's'}` : ''].filter(Boolean).join(', ')}`;
  const lines = diagnostics.map(d => `${d.range.start.line + 1}:${d.range.start.character + 1} ${SEVERITY[d.severity ?? 1] ?? 'error'}${d.code !== undefined ? ` ${String(d.code).replace(CONTROL, ' ').slice(0, 20)}` : ''} ${d.message.replace(CONTROL, ' ').trim().slice(0, 200)}`);
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
  // first, so a server that publishes twice (syntax, then types) is read whole.
  async diagnose(file: string, languageId: string, text: string): Promise<Diagnostic[] | null> {
    await this.ready; this.lastUsed = Date.now();
    const uri = pathToFileURL(file).href, version = (this.versions.get(uri) ?? 0) + 1;
    const next = () => new Promise<Diagnostic[] | null>(resolve => { const list = this.waiting.get(uri) ?? []; list.push(resolve); this.waiting.set(uri, list); });
    const first = Promise.race([next(), new Promise<null>(resolve => setTimeout(() => resolve(null), LSP_WAIT_MS).unref())]);
    if (version === 1) this.notify('textDocument/didOpen', { textDocument: { uri, languageId, version, text } });
    else this.notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text }] });
    this.versions.set(uri, version);
    let result = await first;
    if (result === null) return null;
    for (;;) { const later = await Promise.race([next(), new Promise<null>(resolve => setTimeout(() => resolve(null), LSP_SETTLE_MS).unref())]); if (later === null) break; result = later; }
    this.lastUsed = Date.now();
    return result;
  }
  async stop(): Promise<void> {
    const ended = new Promise<void>(resolve => { if (this.child.exitCode !== null || this.child.signalCode !== null) resolve(); else this.child.once('close', () => resolve()); });
    if (this.child.stdin.writable) { await Promise.race([this.request('shutdown', null), new Promise(resolve => setTimeout(resolve, 1000).unref())]); this.notify('exit', null); }
    // A server that ignores exit, or left children behind, goes with its whole group a second later.
    const pid = this.child.pid;
    const kill = setTimeout(() => { if (pid !== undefined) try { killGroup(pid, 'SIGKILL', () => { this.failed = true; }); } catch (error) { if (!isFsError(error, 'ESRCH')) this.failed = true; } }, 1000); kill.unref();
    await ended; clearTimeout(kill);
  }
}
export interface LspOptions { root: string; env: Record<string, string>; sandbox: NonNullable<BashOptions['sandbox']> }
export class LspPool {
  private readonly servers = new Map<string, Server>();
  private told = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly options: LspOptions) { this.timer = setInterval(() => { void this.idleCheck(Date.now()); }, 60_000); this.timer.unref(); }
  running(): string[] { return [...this.servers.keys()]; }
  serverEnv(language: string): string[] { return [...this.servers.get(language)?.envKeys ?? []]; }
  // The text for the agent after a write or edit of `path` (relative to the worktree): its diagnostics, a one-time note
  // when no server can run, or nothing.
  async diagnose(path: string): Promise<string> {
    const language = languageOf(path); if (!language) return '';
    const file = resolve(this.options.root, path);
    let server = this.servers.get(language.id);
    if (server?.failed) { this.servers.delete(language.id); server = undefined; }
    if (!server) {
      const program = await findServer(language.server, this.options.env.PATH ?? '', this.options.root); if (!program) return '';
      // Plain process env only, never the agent's own: bash's (no keys); the sandbox is required.
      const argv = await sandboxedArgv([program, ...language.args], { cwd: this.options.root, env: this.options.env, sandbox: { ...this.options.sandbox, require: false } });
      if (argv.unsandboxed) { if (this.told) return ''; this.told = true; return `diagnostics are off for this agent: language servers run only in AI Term's sandbox, and ${argv.unsandboxed.replace(/^this system has none/, 'this system has none')}`; }
      const env = Object.fromEntries(Object.entries(this.options.env).filter(([name]) => !/KEY|TOKEN|SECRET|PASSWORD|AITERM|AI_TERM/i.test(name)));
      const child = spawn(argv.program, argv.args, { cwd: this.options.root, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true, windowsHide: true });
      child.on('error', () => { this.servers.delete(language.id); });
      child.on('close', () => { if (this.servers.get(language.id) === server) this.servers.delete(language.id); });
      server = new Server(child, this.options.root);
      this.servers.set(language.id, server);
    }
    let text: string;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (isFsError(error, 'ENOENT')) return ''; throw error; }
    const diagnostics = await server.diagnose(file, language.languageId(extname(file).toLowerCase()), text);
    return diagnostics === null ? `diagnostics for ${relative(this.options.root, file)}: the language server didn't answer in time` : formatDiagnostics(relative(this.options.root, file), diagnostics);
  }
  async idleCheck(now: number): Promise<void> {
    for (const [id, server] of this.servers) if (now - server.lastUsed >= LSP_IDLE_MS) { this.servers.delete(id); await server.stop(); }
  }
  async stopAll(): Promise<void> { clearInterval(this.timer); const all = [...this.servers.values()]; this.servers.clear(); await Promise.all(all.map(server => server.stop())); }
}

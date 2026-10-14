import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { EXTENSION_FILE_BYTES, EXTENSION_TOTAL_BYTES, EXTENSION_MAX_ITEMS, extensionTokens, catalogTokens, type ExtensionCatalog, type ExtensionFile, type ExtensionKind, type ExtensionSource } from '../../shared/extensions.js';
import { parseExtension } from './frontmatter.js';
import { parseCodexAgent } from './toml.js';

const under = (root: string, path: string) => path === root || path.startsWith(root + sep);
export function deniedExtensionPath(home: string, path: string, directory = false): boolean {
  if (!under(home, path)) return true;
  const parts = relative(home, path).normalize('NFKC').toLowerCase().split(sep);
  const first = parts[0] ?? '', second = parts[1] ?? '';
  // These stores use filenames that don't say "auth" (SSH keys, netrc, package registry tokens).
  if (['.ssh','.gnupg','.aws','.azure','.docker','.kube'].includes(first) || first === '.config' && ['gh','gcloud'].includes(second)) return true;
  return parts.some((part, index) =>
    // CLI and shell history, sessions and logs, under any prefix: .zsh_history, fish_history, file-history, .zsh_sessions, log.
    /^(?:.*[._-])?(?:history|sessions|logs?|projects)(?:[._-].*)?$/.test(part) ||
    !directory && index === parts.length - 1 && (/(?:credentials?|auth|tokens?|passwords?|secrets?)(?:[._-]|$)/.test(part) || ['.netrc','.npmrc','.pypirc','.dockercfg','.authinfo','.authinfo.gpg','.yarnrc','.yarnrc.yml','.pgpass','.s3cfg','.boto','.my.cnf'].includes(part) || /\.(?:key|pem|p12|pfx)$/.test(part) || /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?$/.test(part)) || /^settings.*\.json$/.test(part) ||
    part.endsWith('.env') || part === '.env' || part.startsWith('.env.') || part === '.claude.json' || part === 'config.toml');
}
// A project inside the home's private folders (CLI state, credential stores) is never a source of extensions or MCP servers.
const PRIVATE_FIRST = ['.claude','.codex','.agents','.ssh','.gnupg','.aws','.azure','.docker','.kube'];
function privateProject(home: string, root: string): boolean {
  if (!under(home, root) || root === home) return false;
  const [first = '', second = ''] = relative(home, root).normalize('NFKC').toLowerCase().split(sep);
  return PRIVATE_FIRST.includes(first) || first === '.config' && ['gh', 'gcloud'].includes(second);
}
// Darwin O_NOFOLLOW_ANY rejects symlinks in every component of an already-resolved path. Node doesn't expose the
// constant (Darwin fcntl.h: 0x20000000). This closes parent-symlink swaps as well as O_NOFOLLOW's last-component race.
// Linux opens one component at a time through held directory descriptors, with O_NOFOLLOW at each step.
function secureOpen(path: string, directory: boolean): number {
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  if (process.platform === 'darwin') return openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | (directory ? constants.O_DIRECTORY : 0) | 0x20000000);
  if (process.platform !== 'linux') throw new Error('safe extension reads unsupported');
  let fd = openSync('/', flags | constants.O_DIRECTORY);
  try {
    const components=path.split('/').filter(Boolean);
    for (const [index,component] of components.entries()) {
      const next = openSync(`/proc/self/fd/${fd}/${component}`, flags | (index < components.length - 1 || directory ? constants.O_DIRECTORY : 0));
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}

// All CLI-extension filesystem access is confined to this reader. It never accepts an arbitrary read path: discovery
// starts from these literal roots and read() looks up a discovered ID. Symlink targets may be shared anywhere at home.
export class ExtensionReader {
  private readonly home: string;
  private readonly roots: { path: string; kind: ExtensionKind; source: ExtensionSource }[];
  private readonly project: string | null;
  private readonly projectNote: string | null;
  private files = new Map<string, ExtensionFile>();
  constructor(home: string, project: string) {
    this.home = realpathSync(home);
    // A project is untrusted (a cloned repo can carry relative symlinks), so its roots are checked against its own real
    // folder, wherever it is, and nothing they resolve to may leave it. Your own roots may share files across the home.
    let projectRoot: string | null;
    try { projectRoot = realpathSync(resolve(project)); } catch { projectRoot = null; }
    this.projectNote = projectRoot === null ? 'project folder unreadable' : privateProject(this.home, projectRoot) ? 'project is inside a private home folder' : null;
    this.project = this.projectNote === null ? projectRoot : null;
    this.roots = this.project === null ? [] : [
      ['.claude/skills', 'skill', 'this project'], ['.claude/agents', 'agent', 'this project'], ['.claude/commands', 'command', 'this project'], ['.agents/skills', 'skill', 'this project'],
    ].map(([path, kind, source]) => ({ path: join(this.project ?? '/', path ?? ''), kind: kind as ExtensionKind, source: source as ExtensionSource }));
    for (const [path, kind, source] of [
      ['.claude/skills', 'skill', 'Claude'], ['.claude/agents', 'agent', 'Claude'], ['.claude/commands', 'command', 'Claude'], ['.codex/prompts', 'command', 'Codex'], ['.codex/skills', 'skill', 'Codex'], ['.codex/agents', 'agent', 'Codex'], ['.agents/skills', 'skill', 'shared'],
    ] as const) this.roots.push({ path: join(this.home, path), kind, source });
  }
  scan(overrides: Record<string, boolean> = {}): ExtensionCatalog {
    this.files.clear(); const notes: string[] = [], visited = new Set<string>(), names = new Set<string>();
    let bytes = 0, entries = 0;
    const note = (logical: string, reason: string) => { if (notes.length < 100) notes.push(`skipped ${relative(this.home, logical).replace(/[\p{C}]/gu, '?')}: ${reason}`); };
    if (this.projectNote) notes.push(`skipped this project's extensions: ${this.projectNote}`);
    const visit = (logical: string, kind: ExtensionKind, source: ExtensionSource, depth: number) => {
      if (++entries > 4000 || depth > 8 || this.files.size >= EXTENSION_MAX_ITEMS) { note(logical, 'catalog limit'); return; }
      // Deny both spellings, including a denied logical alias to an otherwise allowed file.
      const base = source === 'this project' ? this.project : this.home;
      if (base === null) return;
      const denied = (path: string, directory: boolean) => deniedExtensionPath(base, path, directory);
      if (denied(logical, true)) { note(logical, 'denied path'); return; }
      let real: string;
      try { real = realpathSync(logical); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) note(logical, 'unreadable'); return; }
      if (base !== this.home && !under(base, real)) { note(logical, 'links outside the project'); return; }
      if (denied(real, true)) { note(logical, 'denied target'); return; }
      const identity = kind + ':' + real;
      if (visited.has(identity)) return;
      let fd: number | undefined;
      try {
        const before = statSync(real), directory = before.isDirectory();
        if (denied(logical,directory) || denied(real,directory)) {note(logical,'denied target');return;}
        if (before.isFile() && before.nlink !== 1) { note(logical,'hard links are not allowed'); return; }
        fd = secureOpen(real, directory); const info = fstatSync(fd);
        if (info.isFile() && info.nlink !== 1) { note(logical,'hard links are not allowed'); return; }
        if (realpathSync(logical) !== real || statSync(real).ino !== info.ino || statSync(real).dev !== info.dev) throw new Error('changed path');
        visited.add(identity);
        if (info.isDirectory()) {
          for (const child of readdirSync(real).sort()) {
            if (kind === 'skill' && child !== 'SKILL.md' && child.endsWith('.md')) continue;
            visit(join(logical, child), kind, source, depth + 1);
          }
          return;
        }
        if (!info.isFile()) { note(logical, 'not a regular file'); return; }
        const toml = kind === 'agent' && source === 'Codex' && logical.endsWith('.toml');
        if (kind === 'skill' ? basename(logical) !== 'SKILL.md' : !logical.endsWith('.md') && !toml) { note(logical, 'unsupported file'); return; }
        if (info.size > EXTENSION_FILE_BYTES || bytes + info.size > EXTENSION_TOTAL_BYTES) { note(logical, 'size limit'); return; }
        const buffer = Buffer.alloc(Math.min(info.size + 1, EXTENSION_TOTAL_BYTES - bytes)), count = readSync(fd, buffer, 0, buffer.length, 0);
        // Rejected contents still consumed IO and memory. Charge them before decoding or parsing can throw.
        bytes += count;
        const after = fstatSync(fd);
        if (count !== info.size || after.size !== info.size || after.nlink !== 1 || realpathSync(logical) !== real) throw new Error('changed file');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
        if (text.includes('\0')) throw new Error('binary file');
        const parsed = toml ? parseCodexAgent(text, basename(logical, '.toml')) : parseExtension(text, kind, kind === 'skill' ? basename(resolve(logical, '..')) : basename(logical, '.md'));
        const nameKey = kind + ':' + parsed.name;
        if (names.has(nameKey)) { note(logical, 'name clash; first source wins'); return; }
        names.add(nameKey);
        const id = createHash('sha256').update(kind + ':' + logical).digest('hex').slice(0, 16);
        const item = { id, kind, name: parsed.name, description: parsed.description, source, enabled: overrides[id] !== false,
          tokens: kind === 'command' ? 0 : extensionTokens(`${kind} ${parsed.name}: ${parsed.description}\n`), ...(parsed.model ? { model: parsed.model } : {}) };
        this.files.set(id, { item, text, body: parsed.body });
      } catch { note(logical, 'unreadable, changed or malformed file'); }
      finally { if (fd !== undefined) closeSync(fd); }
    };
    for (const root of this.roots) visit(root.path, root.kind, root.source, 0);
    const items = [...this.files.values()].map(f => f.item);
    return { items, notes, tokens: catalogTokens(items) };
  }
  read(id: string): ExtensionFile {
    // Bodies are from the just-validated bounded scan; no stale path is reopened after a popup/model selects an ID.
    const file = this.files.get(id); if (!file) throw new Error('Extension unavailable'); return file;
  }
  projectMcp(project: string): string | null {
    const root=realpathSync(project),logical=join(root,'.mcp.json');
    if(privateProject(this.home,root))throw new Error('MCP project is outside its allowed folder');
    let real:string;try{real=realpathSync(logical);}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return null;throw new Error('MCP project file unavailable',{cause:error});}
    if(!under(root,real)||deniedExtensionPath(root,real))throw new Error('MCP project file denied');
    const before=statSync(real);if(!before.isFile()||before.nlink!==1||before.size>EXTENSION_FILE_BYTES)throw new Error('MCP project file unsafe');
    const fd=secureOpen(real,false);
    try{const info=fstatSync(fd);if(info.ino!==before.ino||info.dev!==before.dev||info.nlink!==1||info.size>EXTENSION_FILE_BYTES||realpathSync(logical)!==real)throw new Error('MCP project changed');
      const buffer=Buffer.alloc(info.size+1),count=readSync(fd,buffer,0,buffer.length,0),after=fstatSync(fd);
      if(count!==info.size||after.size!==info.size||after.nlink!==1||realpathSync(logical)!==real)throw new Error('MCP project changed');
      return new TextDecoder('utf-8',{fatal:true}).decode(buffer.subarray(0,count));
    }finally{closeSync(fd);}
  }
}

import { constants, openSync, closeSync, fstatSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, join, relative, resolve, sep } from 'node:path';
import { EXTENSION_FILE_BYTES, EXTENSION_TOTAL_BYTES, EXTENSION_MAX_ITEMS, extensionTokens, catalogTokens, type ExtensionCatalog, type ExtensionFile, type ExtensionKind, type ExtensionSource } from '../../shared/extensions.js';
import { parseExtension } from './frontmatter.js';

const under = (root: string, path: string) => path === root || path.startsWith(root + sep);
export function deniedExtensionPath(home: string, path: string, directory = false): boolean {
  if (!under(home, path)) return true;
  const parts = relative(home, path).normalize('NFKC').toLowerCase().split(sep);
  return parts.some((part, index) =>
    /^(?:history|sessions|logs|projects)(?:[._-].*)?$/.test(part) ||
    !directory && index === parts.length - 1 && /(?:credentials?|auth)(?:[._-]|$)/.test(part) || /^settings.*\.json$/.test(part) ||
    part.endsWith('.env') || part === '.env' || part.startsWith('.env.') || part === '.claude.json' || part === 'config.toml');
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
  private files = new Map<string, ExtensionFile>();
  constructor(home: string, project: string) {
    this.home = realpathSync(home);
    const projectRoot = resolve(project);
    this.roots = [
      ['.claude/skills', 'skill', 'this project'], ['.claude/agents', 'agent', 'this project'], ['.claude/commands', 'command', 'this project'], ['.agents/skills', 'skill', 'this project'],
    ].map(([path, kind, source]) => ({ path: join(projectRoot, path ?? ''), kind: kind as ExtensionKind, source: source as ExtensionSource }));
    for (const [path, kind, source] of [
      ['.claude/skills', 'skill', 'Claude'], ['.claude/agents', 'agent', 'Claude'], ['.claude/commands', 'command', 'Claude'], ['.codex/prompts', 'command', 'Codex'], ['.agents/skills', 'skill', 'shared'],
    ] as const) this.roots.push({ path: join(this.home, path), kind, source });
  }
  scan(overrides: Record<string, boolean> = {}): ExtensionCatalog {
    this.files.clear(); const notes: string[] = [], visited = new Set<string>(), names = new Set<string>();
    let bytes = 0, entries = 0;
    const note = (logical: string, reason: string) => { if (notes.length < 100) notes.push(`skipped ${relative(this.home, logical).replace(/[\p{C}]/gu, '?')}: ${reason}`); };
    const visit = (logical: string, kind: ExtensionKind, source: ExtensionSource, depth: number) => {
      if (++entries > 4000 || depth > 8 || this.files.size >= EXTENSION_MAX_ITEMS) { note(logical, 'catalog limit'); return; }
      // Deny both spellings, including a denied logical alias to an otherwise allowed file.
      if (deniedExtensionPath(this.home, logical, true)) { note(logical, 'denied path'); return; }
      let real: string;
      try { real = realpathSync(logical); }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) note(logical, 'unreadable'); return; }
      if (deniedExtensionPath(this.home, real, true)) { note(logical, 'denied target'); return; }
      const identity = kind + ':' + real;
      if (visited.has(identity)) return;
      let fd: number | undefined;
      try {
        const directory = statSync(real).isDirectory();
        if (deniedExtensionPath(this.home,logical,directory) || deniedExtensionPath(this.home,real,directory)) {note(logical,'denied target');return;}
        fd = secureOpen(real, directory); const info = fstatSync(fd);
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
        if (kind === 'skill' ? basename(logical) !== 'SKILL.md' : !logical.endsWith('.md')) return;
        if (info.size > EXTENSION_FILE_BYTES || bytes + info.size > EXTENSION_TOTAL_BYTES) { note(logical, 'size limit'); return; }
        const buffer = Buffer.alloc(info.size + 1), count = readSync(fd, buffer, 0, buffer.length, 0);
        if (count > info.size || realpathSync(logical) !== real) throw new Error('changed file');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
        bytes += count;
        if (text.includes('\0')) throw new Error('binary file');
        const parsed = parseExtension(text, kind, kind === 'skill' ? basename(resolve(logical, '..')) : basename(logical, '.md'));
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
}

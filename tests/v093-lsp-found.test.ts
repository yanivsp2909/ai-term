import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { LspPool } from '../src/agent/lsp.js';
import { serversFound, LSP_LANGUAGES } from '../src/shared/lsp-languages.js';
import { buildBashEnv } from '../src/daemon/env.js';
import { CredentialsPanel } from '../src/client/tui/credentials.js';

// Yaniv: none of the four language servers is installed on this Mac, so the switch quietly did nothing. Now /settings
// says which are found, and the agent is told once per language how to install the missing one.
const roots: string[] = [], pools: LspPool[] = [];
afterEach(async () => { for (const pool of pools.splice(0)) await pool.stopAll(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const dir = await realpath(await mkdtemp(join(tmpdir(), 'ai-lsp-found-'))); roots.push(dir); return dir; }

it('each language names its server and the command that installs it', () => {
  expect(LSP_LANGUAGES.map(l => [l.label, l.server, l.install])).toEqual([
    ['TypeScript/JavaScript', 'typescript-language-server', 'npm i -g typescript-language-server typescript'],
    ['Python', 'pyright-langserver', 'npm i -g pyright'],
    ['Go', 'gopls', 'go install golang.org/x/tools/gopls@latest'],
    ['Rust', 'rust-analyzer', 'rustup component add rust-analyzer'],
  ]);
});

it('which servers are on PATH', async () => {
  const dir = await temp(); await writeFile(join(dir, 'gopls'), '#!/bin/sh\n'); await chmod(join(dir, 'gopls'), 0o755);
  expect(await serversFound(dir)).toEqual(['Go']);
  expect(await serversFound('/nonexistent')).toEqual([]);
});

it('the agent is told once per language when its server isn\'t installed, with the command that installs it', async () => {
  const dir = await temp(), tree = join(dir, 'tree'); await mkdir(tree); await writeFile(join(tree, 'a.ts'), 'x\n'); await writeFile(join(tree, 'b.ts'), 'x\n'); await writeFile(join(tree, 'c.py'), 'x\n');
  const pool = new LspPool({ root: tree, env: { ...buildBashEnv(process.env), PATH: '/usr/bin:/bin' }, sandbox: { home: join(dir, 'h') } }); pools.push(pool);
  expect(await pool.diagnose('a.ts')).toBe("diagnostics for TypeScript/JavaScript need typescript-language-server, and it isn't installed · npm i -g typescript-language-server typescript installs it");
  expect(await pool.diagnose('b.ts')).toBe('');
  expect(await pool.diagnose('c.py')).toBe("diagnostics for Python need pyright-langserver, and it isn't installed · npm i -g pyright installs it");
});

it('/settings says which language servers diagnostics found, or that none is installed', async () => {
  const dir = await temp(); await writeFile(join(dir, 'rust-analyzer'), '#!/bin/sh\n'); await chmod(join(dir, 'rust-analyzer'), 0o755);
  const panel = (path: string) => new CredentialsPanel('settings', { request: async body => ({ id: randomUUID(), ok: true, ...(body.kind === 'keys.list' ? { keys: [] } : body.kind === 'settings.get' ? { settings: { theme: 'graphite', lspDiagnostics: true } } : {}) }), changed: () => {}, close: () => {}, login: async () => {}, defaults: () => {}, theme: async () => {} }, path);
  const some = panel(dir); await some.load();
  expect(some.lines().join('\n')).toContain("diagnostics: on · servers found: Rust · AI Term's agent sees a file's errors after it writes (z)");
  const none = panel('/nonexistent'); await none.load();
  expect(none.lines().join('\n')).toContain('diagnostics: on · no language server installed; README lists them (z)');
});

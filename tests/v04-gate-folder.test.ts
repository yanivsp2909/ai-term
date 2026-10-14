import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateExtensionRequest, validateMcpRequest, validCwd } from '../src/shared/validate.js';

// v0.4 gate: a folder an agent may start in (validCwd) must also be one its extension and MCP queries accept, or every
// turn fails. Emoji built with a zero-width joiner and soft hyphens are ordinary in folder names.
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

it('a folder named with a ZWJ emoji or a soft hyphen works for extensions and MCP, as it does for starting the agent', async () => {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-folder-'))); roots.push(temp);
  for (const name of ['dev 👨‍💻', 'co­op']) {
    const cwd = join(temp, name); await mkdir(cwd);
    expect(await validCwd(cwd)).toBe(true);
    expect(() => validateExtensionRequest({ kind: 'extensions.list', cwd })).not.toThrow();
    expect(() => validateMcpRequest({ kind: 'mcp.list', cwd })).not.toThrow();
  }
  // Still refused: controls, a lone surrogate, line separators and dot segments.
  for (const cwd of ['/tmp/a\u0007b', '/tmp/a\ud800b', '/tmp/a b', '/tmp/../etc']) {
    expect(() => validateExtensionRequest({ kind: 'extensions.list', cwd })).toThrow();
    expect(() => validateMcpRequest({ kind: 'mcp.list', cwd })).toThrow();
  }
});

import { afterEach, expect, it } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:net';
import { findRea, reaIdentity, reverseServer, reverseTarget, REA_MISSING } from '../src/daemon/reverse.js';
import { buildArgs } from '../src/daemon/env.js';

// v1.0.7 /reverse: one agent gets the REA MCP server for itself only. REA is found, never installed; it runs under the
// agent sandbox (D57) with no network and can't write the target.
const roots: string[] = [], MAC = process.platform === 'darwin';
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
const temp = async (name: string) => { const path = await realpath(await mkdtemp(join(tmpdir(), name))); roots.push(path); return path; };
const script = async (path: string, body: string) => { await writeFile(path, `#!/bin/sh\n${body}\n`); await chmod(path, 0o755); return path; };

it('REA is found on PATH or at the path you set, never inside the folder; missing says how to install it', async () => {
  const bin = await temp('ai-rea-bin-'), folder = await temp('ai-rea-cwd-');
  await mkdir(join(folder, 'bin'));
  const local = await script(join(folder, 'bin', 'rea'), 'exit 0');
  // Only the folder's own copy: not used, and missing is one line with the install command and /reverse path.
  await expect(findRea(undefined, join(folder, 'bin'), folder)).rejects.toThrow(REA_MISSING);
  expect(REA_MISSING).toContain('npm install --global rea-agents');
  expect(REA_MISSING).toContain('/reverse path <path>');
  const found = await script(join(bin, 'rea'), 'exit 0');
  expect(await findRea(undefined, `${join(folder, 'bin')}:relative:${bin}`, folder)).toBe(found);
  // A set path wins, and must be an executable file.
  expect(await findRea(found, '', folder)).toBe(found);
  await writeFile(join(bin, 'plain'), 'x');
  await expect(findRea(join(bin, 'plain'), '', folder)).rejects.toThrow('/reverse path');
  await expect(findRea('relative/rea', '', folder)).rejects.toThrow('/reverse path');
  expect(local).toBeTruthy();
});

it('the target is a real path that exists; credential files and AI Term\'s own folder are refused', async () => {
  const folder = await temp('ai-rea-target-'), root = await temp('ai-rea-root-');
  await writeFile(join(folder, 'app.bin'), 'x'); await writeFile(join(folder, '.env'), 'x'); await writeFile(join(root, 'state.json'), '{}');
  expect(await reverseTarget(folder, 'app.bin', root)).toBe(join(folder, 'app.bin'));
  expect(await reverseTarget(folder, `"${join(folder, 'app.bin')}"`, root)).toBe(join(folder, 'app.bin'));
  await expect(reverseTarget(folder, '', root)).rejects.toThrow('/reverse <target>');
  await expect(reverseTarget(folder, 'missing.bin', root)).rejects.toThrow('No such target · check the path');
  await expect(reverseTarget(folder, '.env', root)).rejects.toThrow('credential');
  await expect(reverseTarget(folder, join(root, 'state.json'), root)).rejects.toThrow("AI Term's own folder");
});

it('Claude Code gets REA through --mcp-config with --strict-mcp-config; Codex never does', () => {
  const mcp = { command: '/usr/bin/env', args: ['-i', 'PATH=/usr/bin:/bin', '/usr/bin/sandbox-exec', '-f', '/x/p.sb', '--', '/opt/rea', 'mcp'] };
  const addon = { bundle: '/home/u/.ai-term/addons/' + 'a'.repeat(64), readOnly: true, mcp };
  const claude = buildArgs({ engine: 'claude-code', model: null, permission: 'ask', addon });
  const config = claude.find(arg => arg.startsWith('--mcp-config='));
  expect(JSON.parse(config?.slice('--mcp-config='.length) ?? '')).toEqual({ mcpServers: { rea: { type: 'stdio', command: mcp.command, args: mcp.args } } });
  expect(claude.filter(arg => arg === '--strict-mcp-config')).toHaveLength(1);
  expect(claude).toContain('--permission-mode=default');
  // Codex merges -c mcp_servers into your own config, so it never gets a server (security review).
  expect(() => buildArgs({ engine: 'codex', model: null, permission: 'ask', addon })).toThrow('Invalid add-on MCP server');
});

let listener: Server | undefined;
afterEach(async () => { await new Promise<void>(done => { if (listener) listener.close(() => done()); else done(); }); listener = undefined; });
it.skipIf(!MAC)('macOS: REA runs in the agent sandbox with no network: it can\'t write the target, read AI Term\'s folder, reach 127.0.0.1 or resolve a name', async () => {
  const folder = await temp('ai-rea-run-'), root = await temp('ai-rea-home-'), target = join(folder, 'Target.app');
  await mkdir(target); await writeFile(join(target, 'main.bin'), 'original'); await writeFile(join(root, 'secret.txt'), 'secret');
  listener = createServer(socket => socket.end('hello')); await new Promise<void>(done => listener?.listen(0, '127.0.0.1', done));
  const address = listener.address(), port = typeof address === 'object' && address ? address.port : 0;
  // The stub stands in for REA: each line says whether one forbidden thing worked.
  const rea = await script(join(folder, 'rea'), [
    `echo changed > '${join(target, 'main.bin')}' 2>/dev/null && echo write-target-ok || echo write-target-refused`,
    `cat '${join(root, 'secret.txt')}' >/dev/null 2>&1 && echo read-home-ok || echo read-home-refused`,
    `/usr/bin/nc -z -G 2 127.0.0.1 ${port} >/dev/null 2>&1 && echo tcp-ok || echo tcp-refused`,
    // Name lookups go through mDNSResponder's socket (localhost is answered locally either way, so it proves nothing).
    `${process.execPath} -e "const s=require('net').connect('/var/run/mDNSResponder');s.on('connect',()=>{console.log('dns-ok');s.destroy()});s.on('error',()=>console.log('dns-refused'))"`,
    `cat '${join(target, 'main.bin')}' >/dev/null && echo read-target-ok`,
    `echo "args:$*"`,
  ].join('\n'));
  const server = await reverseServer({ rea, target, cwd: folder, root, home: root, env: { PATH: '/usr/bin:/bin', HOME: folder, ANTHROPIC_API_KEY: 'sk-ant-AITERMCANARY0000', TMPDIR: folder } });
  expect(server.command).toBe('/usr/bin/env');
  expect(server.args.slice(0, 1)).toEqual(['-i']);
  expect(server.args.join(' ')).not.toContain('AITERMCANARY');
  expect(server.args.slice(-3)).toEqual(['--', rea, 'mcp']);
  const profile = server.args[server.args.indexOf('-f') + 1] ?? '';
  expect((await stat(profile)).mode & 0o777).toBe(0o600);
  expect(profile.startsWith(join(root, 'reverse'))).toBe(true);
  const stdout = await new Promise<string>((done, fail) => execFile(server.command, server.args, { timeout: 20_000 }, (error, text) => error ? fail(error) : done(text)));
  expect(stdout.trim().split('\n')).toEqual(['write-target-refused', 'read-home-refused', 'tcp-refused', 'dns-refused', 'read-target-ok', 'args:mcp']);
  expect(await readFile(join(target, 'main.bin'), 'utf8')).toBe('original');
}, 30_000);

it.skipIf(!MAC)('HIGH/MEDIUM (reviews): REA reads no key folder or secret-named file, writes only its own state and temp, makes no hard link, opens no app and reaches no unix socket', async () => {
  const folder = await temp('ai-rea-gate-'), root = await temp('ai-rea-gate-root-'), home = await temp('ai-rea-gate-home-'), target = join(folder, 'Target.app');
  await mkdir(target); await writeFile(join(target, 'main.bin'), 'original'); await writeFile(join(target, '.env'), 'TOKEN=x');
  await mkdir(join(home, '.ssh')); await writeFile(join(home, '.ssh', 'id_ed25519'), 'key'); await mkdir(join(home, '.rea'));
  const sock = join(folder, 's.sock'); listener = createServer(socket => socket.end('hi')); await new Promise<void>(done => listener?.listen(sock, done));
  const rea = await script(join(folder, 'rea'), [
    `cat '${join(home, '.ssh', 'id_ed25519')}' >/dev/null 2>&1 && echo key-ok || echo key-refused`,
    `cat '${join(target, '.env')}' >/dev/null 2>&1 && echo env-ok || echo env-refused`,
    `echo x > '${join(folder, 'elsewhere.txt')}' 2>/dev/null && echo write-elsewhere-ok || echo write-elsewhere-refused`,
    `mv '${target}' '${target}.moved' 2>/dev/null && echo move-ok || echo move-refused`,
    `ln '${join(target, 'main.bin')}' "$TMPDIR/hard" 2>/dev/null && echo link-ok || echo link-refused`,
    `echo x > '${join(home, '.rea', 'state')}' && echo rea-state-ok`,
    `echo x > "$TMPDIR/scratch" && echo temp-ok`,
    `/usr/bin/osascript -e 'return 1' >/dev/null 2>&1 && echo osascript-ok || echo osascript-refused`,
    `${process.execPath} -e "const s=require('net').connect('${sock}');s.on('connect',()=>{console.log('unix-ok');s.destroy()});s.on('error',()=>console.log('unix-refused'))"`,
  ].join('\n'));
  const server = await reverseServer({ rea, target, cwd: folder, root, home, env: { PATH: '/usr/bin:/bin', HOME: home } });
  const stdout = await new Promise<string>((done, fail) => execFile(server.command, server.args, { timeout: 20_000 }, (error, text) => error ? fail(error) : done(text)));
  expect(stdout.trim().split('\n')).toEqual(['key-refused', 'env-refused', 'write-elsewhere-refused', 'move-refused', 'link-refused', 'rea-state-ok', 'temp-ok', 'osascript-refused', 'unix-refused']);
  await expect(stat(join(folder, 'elsewhere.txt'))).rejects.toThrow();
}, 30_000);

it.skipIf(!MAC)('MEDIUM (TS review): a PATH too long for one argument is shortened, never dropped: REA\'s and node\'s folders come first', async () => {
  const folder = await temp('ai-rea-path-'), root = await temp('ai-rea-path-root-'), rea = await script(join(folder, 'rea'), 'exit 0');
  const long = Array.from({ length: 200 }, (_, i) => `/opt/tool-${i}/bin`).join(':');
  const server = await reverseServer({ rea, target: folder, cwd: folder, root, home: root, env: { PATH: `${long}:/usr/bin:/bin`, HOME: root } });
  const path = server.args.find(arg => arg.startsWith('PATH='));
  expect(path).toBeDefined();
  expect(Buffer.byteLength(path ?? '')).toBeLessThanOrEqual(2048);
  expect(path?.slice(5).split(':').slice(0, 2)).toEqual([folder, join(process.execPath, '..')]);
  expect(path?.split(':')).toContain('/usr/bin');
});

it('LOW (TS review): the receipt binds REA\'s file itself, so a REA replaced after the popup is a changed input', async () => {
  const bin = await temp('ai-rea-id-'), rea = await script(join(bin, 'rea'), 'exit 0'), before = await reaIdentity(rea);
  await rm(rea); await script(rea, 'exit 1');
  expect(await reaIdentity(rea)).not.toEqual(before);
});

import { afterEach, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExtensionReader, deniedExtensionPath } from '../src/agent/extensions/reader.js';

// v0.4 gate, S21/D48: a project folder is untrusted (a cloned repo can carry relative symlinks), so its extension roots
// must not reach outside the project; the user roots may share files across the home but never history or credentials.
// Fake homes only: nothing here reads the real ~/.claude, ~/.codex, ~/.agents or shell history.
const temps: string[] = [];
afterEach(async () => { for (const p of temps.splice(0)) await rm(p, { recursive: true, force: true }); });
async function home() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-gate-reader-'))); temps.push(temp);
  const home = join(temp, 'home'); await mkdir(home);
  const file = async (path: string, text: string) => { const p = join(home, path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); return p; };
  await file('.bash_history', 'export GITHUB_TOKEN=FAKE-history\n');
  await file('.zsh_history', 'FAKE-zsh-history\n');
  await file('.pgpass', 'db:5432:*:me:FAKE-pgpass\n');
  await file('.ollama/id_ed25519', '-----BEGIN OPENSSH ' + 'PRIVATE KEY-----\nFAKE-key\n-----END OPENSSH PRIVATE KEY-----\n');
  await file('.zsh_sessions/ABC.history', 'FAKE-session\n');
  await file('.codex/log/codex-tui.md', 'FAKE-log\n');
  await file('.claude/file-history/x/1.md', 'FAKE-file-history\n');
  await file('Documents/private-notes.md', 'FAKE-private-notes\n');
  return { temp, home, file };
}
const bodies = (reader: ExtensionReader) => reader.scan().items.map(item => reader.read(item.id).body).join('\n');
const command = '---\ndescription: Say hi\n---\nSay hello to $ARGUMENTS\n';

it('a cloned project cannot link its agents, commands or skills to files outside the project', async () => {
  const h = await home(), project = join(h.home, 'Developer', 'clients', 'evil-repo');
  for (const folder of ['.claude/agents', '.claude/commands', '.claude/skills', '.agents/skills']) await mkdir(join(project, folder), { recursive: true });
  // One link per depth, as a repo that doesn't know where it will be cloned would ship them.
  for (let depth = 1; depth <= 8; depth++) {
    const up = '../'.repeat(depth);
    await symlink(`${up}.bash_history`, join(project, `.claude/agents/history${depth}.md`));
    await symlink(`${up}Documents/private-notes.md`, join(project, `.claude/commands/notes${depth}.md`));
    await symlink(`${up}Documents`, join(project, `.claude/commands/docs${depth}`));
    await symlink(`${up}.ollama`, join(project, `.claude/skills/key${depth}`));
  }
  await writeFile(join(project, '.claude/commands/hello.md'), command);
  const reader = new ExtensionReader(h.home, project), catalog = reader.scan(), text = bodies(reader);
  expect(catalog.items.map(i => i.name)).toEqual(['hello']);
  expect(text).not.toMatch(/FAKE-/);
  expect(catalog.notes.some(note => note.includes('outside the project'))).toBe(true);
});

it('a link that stays inside the project still works', async () => {
  const h = await home(), project = join(h.home, 'code', 'app');
  await mkdir(join(project, 'docs'), { recursive: true }); await mkdir(join(project, '.claude/commands'), { recursive: true });
  await writeFile(join(project, 'docs/hello.md'), command);
  await symlink('../../docs/hello.md', join(project, '.claude/commands/hello.md'));
  expect(new ExtensionReader(h.home, project).scan().items.map(i => i.name)).toEqual(['hello']);
});

it('user roots never follow a shared link to shell history, sessions, logs or a private key', async () => {
  const h = await home();
  await mkdir(join(h.home, '.claude/commands'), { recursive: true }); await mkdir(join(h.home, '.claude/agents'), { recursive: true }); await mkdir(join(h.home, '.agents/skills'), { recursive: true });
  for (const [target, link] of [['.bash_history', '.claude/agents/a.md'], ['.zsh_history', '.claude/agents/b.md'], ['.pgpass', '.claude/commands/c.md'], ['.ollama/id_ed25519', '.claude/commands/d.md'], ['.zsh_sessions', '.claude/commands/sessions'], ['.codex/log', '.claude/commands/logs'], ['.claude/file-history', '.claude/commands/fh']] as const)
    await symlink(join(h.home, target), join(h.home, link));
  await symlink(join(h.home, 'Documents/private-notes.md'), join(h.home, '.claude/commands/notes.md'));
  const reader = new ExtensionReader(h.home, join(h.home, 'nowhere')), names = reader.scan().items.map(i => i.name), text = bodies(reader);
  // A shared Markdown file elsewhere in the home is still allowed for your own roots (S21); nothing denied is read.
  expect(names).toEqual(['notes']);
  expect(text).toContain('FAKE-private-notes');
  expect(text.replace('FAKE-private-notes', '')).not.toMatch(/FAKE-/);
  for (const path of ['.zsh_history', '.bash_history', 'fish_history', '.pgpass', '.ollama/id_ed25519', '.zsh_sessions/ABC.history', '.codex/log/x.md', '.claude/file-history/x.md'])
    expect(deniedExtensionPath(h.home, join(h.home, path))).toBe(true);
});

it('projects kept under ~/Projects or in folders named like logs or history keep their extensions and .mcp.json', async () => {
  const h = await home();
  for (const path of ['Projects/app', 'code/logs-viewer', 'code/history-app', 'sessions/app']) {
    const project = join(h.home, path);
    await mkdir(join(project, '.claude/commands'), { recursive: true });
    await writeFile(join(project, '.claude/commands/hello.md'), command);
    await writeFile(join(project, '.mcp.json'), '{"mcpServers":{}}');
    const reader = new ExtensionReader(h.home, project);
    expect(reader.scan().items.map(i => i.name)).toEqual(['hello']);
    expect(reader.projectMcp(project)).toBe('{"mcpServers":{}}');
  }
});

it('a project outside the home keeps its own extensions', async () => {
  const h = await home(), project = join(h.temp, 'volume', 'app');
  await mkdir(join(project, '.claude/commands'), { recursive: true });
  await writeFile(join(project, '.claude/commands/hello.md'), command);
  expect(new ExtensionReader(h.home, project).scan().items.map(i => i.name)).toEqual(['hello']);
});

it('a project inside a private home folder still gets nothing', async () => {
  const h = await home();
  for (const path of ['.ssh/app', '.claude/projects/app', '.codex/app']) {
    const project = join(h.home, path);
    await mkdir(join(project, '.claude/commands'), { recursive: true });
    await writeFile(join(project, '.claude/commands/hello.md'), command);
    await writeFile(join(project, '.mcp.json'), '{"mcpServers":{}}');
    const reader = new ExtensionReader(h.home, project);
    expect(reader.scan().items).toEqual([]);
    expect(() => reader.projectMcp(project)).toThrow();
  }
});

it('extensions named like git-log, show-history, analyze-logs or web-sessions still load; only state files are denied', async () => {
  const h = await home(), project = join(h.home, 'code', 'app');
  const names = ['git-log', 'show-history', 'log-analyzer', 'web-sessions'];
  for (const name of names) await h.file(`code/app/.claude/commands/${name}.md`, command);
  for (const name of ['commit-history', 'analyze-logs']) await h.file(`.claude/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\nbody\n`);
  const found = new ExtensionReader(h.home, project).scan().items.map(i => i.name).sort();
  expect(found).toEqual([...names, 'commit-history', 'analyze-logs'].sort());
  for (const path of ['.claude/history.jsonl', '.claude/projects/x/a.md', '.codex/sessions/a.md', '.codex/log/a.md', '.zsh_history', '.python_history', 'fish_history', '.claude/file-history/a.md'])
    expect(deniedExtensionPath(h.home, join(h.home, path))).toBe(true);
});

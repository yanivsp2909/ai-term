import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { lstat, mkdtemp, open, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { resolveExecutable } from './engines.js';
import { fitEscaped, quoted } from './addon-text.js';

// v1.1 /deps: AI Term itself runs only read-only queries, argv only, for the package tools the project uses and that
// are installed. Upgrading is the agent's job in its worktree, under its own permission prompts. The queries' text is
// passed to the model as data, summarized and quoted.
// Review (security, reproduced): a query run in the repository runs the repository's code: python3 -m pip puts the
// folder first on sys.path, a .npmrc or .cargo/config.toml can name programs, go.mod can name a toolchain to download.
// So the queries run in a fresh temp folder holding only copies of the manifests and lockfiles, python with -I, and the
// tools' own code-running settings pinned off by env (which beats any config they still read).
export const DEPS_TIMEOUT_MS = 60_000, DEPS_OUTPUT_MAX = 8 * 1024 * 1024, DEPS_LINES = 60, DEPS_DATA_BYTES = 9000;
const MANIFESTS = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'go.mod', 'go.sum', 'requirements.txt', 'pyproject.toml', 'Cargo.toml', 'Cargo.lock'];
// GOPROXY without direct and GOVCS off: go never fetches a module straight from a host go.mod names (follow-up review).
const PINNED: Record<string, string> = { GOPROXY: 'https://proxy.golang.org', GOVCS: '*:off', GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOWORK: 'off', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', CARGO_BUILD_RUSTC_WRAPPER: '', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '', PYTHONNOUSERSITE: '1' };
interface Query { tool: string; marker: string[]; program: string; argv: string[][]; requires?: string }
// In the order shown. npm outdated and npm audit exit 1 when they find something: their JSON is read either way.
const QUERIES: readonly Query[] = [
  { tool: 'npm', marker: ['package.json'], program: 'npm', argv: [['outdated', '--json'], ['audit', '--json']] },
  { tool: 'go', marker: ['go.mod'], program: 'go', argv: [['list', '-m', '-u', '-json', 'all']] },
  { tool: 'pip', marker: ['requirements.txt', 'pyproject.toml'], program: 'python3', argv: [['-I', '-m', 'pip', 'list', '--outdated', '--format=json', '--disable-pip-version-check', '--no-input']] },
  { tool: 'cargo', marker: ['Cargo.toml'], program: 'cargo', argv: [['outdated', '--root-deps-only', '--format', 'json']], requires: 'cargo-outdated' },
];
// Read through one descriptor opened without following links (a link swapped in after a check would be followed).
async function copyManifest(from: string, to: string): Promise<void> {
  let file;
  try { file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ELOOP') || isFsError(error, 'ENOTDIR')) return; throw error; }
  try { const info = await file.stat(); if (info.isFile() && info.size <= DEPS_OUTPUT_MAX) await writeFile(to, await file.readFile(), { flag: 'wx', mode: 0o600 }); } finally { await file.close(); }
}
const present = async (path: string) => { try { return (await lstat(path)).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } };
// null: the query failed (killed or timed out, a tool that exits non-zero on failure, an npm error object, a go module
// whose update lookup failed); said as such, never read as "nothing outdated" (review). npm outdated and npm audit exit
// 1 when they find something, so for npm only its error object counts; a dependency named "error" is not one.
function query(tool: string, file: string, argv: string[], cwd: string, env: Record<string, string>): Promise<string | null> {
  return new Promise(resolve => execFile(file, argv, { cwd, env: { ...env, ...PINNED }, timeout: DEPS_TIMEOUT_MS, maxBuffer: DEPS_OUTPUT_MAX, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    const out = typeof stdout === 'string' ? stdout : '', npmError = object(object(json(out)).error);
    const killed = !!error && ((error as { killed?: boolean }).killed === true || typeof (error as { code?: unknown }).code !== 'number');
    const failed = killed || (tool === 'npm' ? typeof npmError.code === 'string' || typeof npmError.summary === 'string' : !!error) || tool === 'go' && /"Error"\s*:/.test(out);
    resolve(failed ? null : out);
  }));
}
// A manifest naming a source outside the package registry (git, a URL, a local path) would make the query fetch or read
// it: that tool is skipped and the facts say so (follow-up review). npm workspaces would read folders outside the copy.
async function outsideSource(tool: string, folder: string): Promise<string | null> {
  if (tool === 'npm') {
    const manifest = object(json(await readFile(join(folder, 'package.json'), 'utf8')));
    if (manifest.workspaces !== undefined) return 'skipped: workspaces; run /deps <package folder>';
    // Only registry specs pass (final review: git@host:…, host:user/repo, gist: and other git shorthands slipped a
    // deny-list): a range or dist-tag never holds : / # or @, and an npm: alias must point at one.
    const registry = (range: string) => !/[:/#@]/.test(range) && !range.startsWith('.');
    const allowed = (spec: unknown) => typeof spec === 'string' && (spec.startsWith('npm:') ? ((m: RegExpMatchArray | null) => !!m && registry(m[2] ?? '*'))(spec.slice(4).match(/^((?:@[\w.-]+\/)?[\w.-]+)(?:@(.*))?$/)) : registry(spec));
    if (!['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies', 'overrides'].flatMap(key => Object.values(object(manifest[key]))).every(allowed)) return "skipped: package.json names a source outside the registry; AI Term won't contact it";
  }
  // Quoted TOML keys count too ("git" = …), and a [patch] table however it is spaced.
  if (tool === 'cargo' && /["']?\b(?:git|path|registry|registry-index)\b["']?\s*=|\[\s*patch\b/m.test(await readFile(join(folder, 'Cargo.toml'), 'utf8'))) return "skipped: Cargo.toml names a source outside the registry; AI Term won't contact it";
  return null;
}
const json = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch (error) { if (error instanceof SyntaxError) return null; throw error; } };
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const str = (v: unknown) => typeof v === 'string' ? v.slice(0, 120) : '?';
function summarize(tool: string, outputs: string[]): { lines: string[]; fact: string } {
  if (tool === 'npm') {
    const outdated = Object.entries(object(json(outputs[0] ?? ''))).map(([name, v]) => `${name.slice(0, 120)} ${str(object(v).current)} → ${str(object(v).latest)}`);
    const counts = object(object(object(json(outputs[1] ?? '')).metadata).vulnerabilities), audit = ['critical', 'high', 'moderate', 'low'].flatMap(level => Number(counts[level]) > 0 ? [`${Number(counts[level])} ${level}`] : []);
    const vulnerable = Object.entries(object(object(json(outputs[1] ?? '')).vulnerabilities)).map(([name, v]) => `${name.slice(0, 120)}: ${str(object(v).severity)} vulnerability`);
    return { lines: [...outdated, ...vulnerable], fact: `npm: ${outdated.length} outdated · audit: ${audit.join(', ') || 'nothing found'}` };
  }
  if (tool === 'go') {
    // go list -json prints one JSON object after another, not an array.
    const modules = (outputs[0] ?? '').split(/\n(?=\{)/).map(chunk => object(json(chunk))).filter(m => object(m.Update).Version);
    const lines = modules.map(m => `${str(m.Path)} ${str(m.Version)} → ${str(object(m.Update).Version)}`);
    return { lines, fact: lines.length ? `go: ${lines.length} update${lines.length === 1 ? '' : 's'}` : 'go: no updates' };
  }
  if (tool === 'pip') {
    const list = json(outputs[0] ?? ''), lines = Array.isArray(list) ? list.map(p => `${str(object(p).name)} ${str(object(p).version)} → ${str(object(p).latest_version)}`) : [];
    return { lines, fact: `pip: ${lines.length} outdated` };
  }
  const deps = object(json(outputs[0] ?? '')).dependencies, lines = Array.isArray(deps) ? deps.map(d => `${str(object(d).name)} ${str(object(d).project)} → ${str(object(d).latest)}`) : [];
  return { lines, fact: `cargo: ${lines.length} outdated` };
}
// folder: the folder whose manifests are queried (the repository's top, or the scope /deps [path] names).
export async function depsQueries(folder: string, options: { path: string; env: Record<string, string> }): Promise<{ data: string; facts: string[] }> {
  const work = await mkdtemp(join(await realpath(tmpdir()), 'ai-term-deps-'));
  try {
    // Only regular files are copied: a link would be followed out of the repository.
    for (const name of MANIFESTS) await copyManifest(join(folder, name), join(work, name));
    return await run(work, options);
  } finally { await rm(work, { recursive: true, force: true }); }
}
async function run(repo: string, options: { path: string; env: Record<string, string> }): Promise<{ data: string; facts: string[] }> {
  const facts: string[] = [], sections: string[] = [];
  for (const q of QUERIES) {
    const used = (await Promise.all(q.marker.map(name => present(join(repo, name))))).some(Boolean);
    if (!used) continue;
    const file = await resolveExecutable(q.program, options.path), helper = q.requires ? await resolveExecutable(q.requires, options.path) : file;
    if (!file || !helper) { facts.push(`${q.tool}: ${q.requires && file ? q.requires : q.program} isn't installed; skipped`); continue; }
    const outside = await outsideSource(q.tool, repo); if (outside) { facts.push(`${q.tool}: ${outside}`); continue; }
    const outputs: string[] = [];
    let failed = false;
    for (const argv of q.argv) { const out = await query(q.tool, file, argv, repo, options.env); if (out === null) failed = true; outputs.push(out ?? ''); }
    const { lines, fact } = summarize(q.tool, outputs);
    // A failed query's counts would read as an all-clear: only the failure is said.
    facts.push(failed ? `${q.tool}: a query failed (no network, or the tool errored); its results are incomplete` : fact);
    sections.push(`${q.tool} (${q.argv.map(a => `${q.program} ${a.join(' ')}`).join('; ')}):`, ...lines.slice(0, DEPS_LINES), ...lines.length > DEPS_LINES ? [`… ${lines.length - DEPS_LINES} more`] : []);
  }
  if (!facts.length) facts.push('no package files found (package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml)');
  return { data: fitEscaped(quoted(sections.join('\n') || 'No query ran.'), DEPS_DATA_BYTES), facts };
}

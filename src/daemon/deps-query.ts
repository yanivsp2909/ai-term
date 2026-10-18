import { execFile } from 'node:child_process';
import { copyFile, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
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
const PINNED: Record<string, string> = { GOTOOLCHAIN: 'local', GOFLAGS: '-mod=readonly', GOWORK: 'off', npm_config_ignore_scripts: 'true', npm_config_update_notifier: 'false', npm_config_fund: 'false', CARGO_BUILD_RUSTC_WRAPPER: '', CARGO_BUILD_RUSTC_WORKSPACE_WRAPPER: '', PYTHONNOUSERSITE: '1' };
interface Query { tool: string; marker: string[]; program: string; argv: string[][]; requires?: string }
// In the order shown. npm outdated and npm audit exit 1 when they find something: their JSON is read either way.
const QUERIES: readonly Query[] = [
  { tool: 'npm', marker: ['package.json'], program: 'npm', argv: [['outdated', '--json'], ['audit', '--json']] },
  { tool: 'go', marker: ['go.mod'], program: 'go', argv: [['list', '-m', '-u', '-json', 'all']] },
  { tool: 'pip', marker: ['requirements.txt', 'pyproject.toml'], program: 'python3', argv: [['-I', '-m', 'pip', 'list', '--outdated', '--format=json', '--disable-pip-version-check', '--no-input']] },
  { tool: 'cargo', marker: ['Cargo.toml'], program: 'cargo', argv: [['outdated', '--root-deps-only', '--format', 'json']], requires: 'cargo-outdated' },
];
const present = async (path: string) => { try { return (await lstat(path)).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } };
// null: the query failed (timed out, crashed, printed nothing, or answered with an error object such as an offline npm
// audit); said as such, never read as "nothing outdated" (review).
function query(file: string, argv: string[], cwd: string, env: Record<string, string>): Promise<string | null> {
  return new Promise(resolve => execFile(file, argv, { cwd, env: { ...env, ...PINNED }, timeout: DEPS_TIMEOUT_MS, maxBuffer: DEPS_OUTPUT_MAX, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
    const out = typeof stdout === 'string' ? stdout : '';
    if (out.trim() && !Object.hasOwn(object(json(out)), 'error')) resolve(out); else resolve(error || out.trim() ? null : '');
  }));
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
    for (const name of MANIFESTS) if (await present(join(folder, name))) await copyFile(join(folder, name), join(work, name));
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
    const outputs: string[] = [];
    let failed = false;
    for (const argv of q.argv) { const out = await query(file, argv, repo, options.env); if (out === null) failed = true; outputs.push(out ?? ''); }
    const { lines, fact } = summarize(q.tool, outputs);
    // A failed query's counts would read as an all-clear: only the failure is said.
    facts.push(failed ? `${q.tool}: a query failed (no network, or the tool errored); its results are incomplete` : fact);
    sections.push(`${q.tool} (${q.argv.map(a => `${q.program} ${a.join(' ')}`).join('; ')}):`, ...lines.slice(0, DEPS_LINES), ...lines.length > DEPS_LINES ? [`… ${lines.length - DEPS_LINES} more`] : []);
  }
  if (!facts.length) facts.push('no package files found (package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml)');
  return { data: fitEscaped(quoted(sections.join('\n') || 'No query ran.'), DEPS_DATA_BYTES), facts };
}

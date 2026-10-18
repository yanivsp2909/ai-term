import { execFile } from 'node:child_process';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { isFsError } from '../shared/paths.js';
import { resolveExecutable } from './engines.js';

// v1.1 /deps: AI Term itself runs only read-only queries, argv only, for the package tools the project uses and that
// are installed. Upgrading is the agent's job in its worktree, under its own permission prompts. The queries' text is
// passed to the model as data, summarized.
export const DEPS_TIMEOUT_MS = 60_000, DEPS_OUTPUT_MAX = 8 * 1024 * 1024, DEPS_LINES = 60;
interface Query { tool: string; marker: string[]; program: string; argv: string[][]; requires?: string }
// In the order shown. npm outdated and npm audit exit 1 when they find something: their JSON is read either way.
const QUERIES: readonly Query[] = [
  { tool: 'npm', marker: ['package.json'], program: 'npm', argv: [['outdated', '--json'], ['audit', '--json']] },
  { tool: 'go', marker: ['go.mod'], program: 'go', argv: [['list', '-m', '-u', '-json', 'all']] },
  { tool: 'pip', marker: ['requirements.txt', 'pyproject.toml'], program: 'python3', argv: [['-m', 'pip', 'list', '--outdated', '--format=json']] },
  { tool: 'cargo', marker: ['Cargo.toml'], program: 'cargo', argv: [['outdated', '--root-deps-only', '--format', 'json']], requires: 'cargo-outdated' },
];
const present = async (path: string) => { try { return (await lstat(path)).isFile(); } catch (error) { if (isFsError(error, 'ENOENT') || isFsError(error, 'ENOTDIR')) return false; throw error; } };
// null: the query failed (timed out, crashed, printed nothing); said as such, never read as "nothing outdated".
function query(file: string, argv: string[], cwd: string, env: Record<string, string>): Promise<string | null> {
  return new Promise(resolve => execFile(file, argv, { cwd, env, timeout: DEPS_TIMEOUT_MS, maxBuffer: DEPS_OUTPUT_MAX, encoding: 'utf8', windowsHide: true }, (error, stdout) => resolve(typeof stdout === 'string' && stdout.trim() ? stdout : error ? null : '')));
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
export async function depsQueries(repo: string, options: { path: string; env: Record<string, string> }): Promise<{ data: string; facts: string[] }> {
  const facts: string[] = [], sections: string[] = [];
  for (const q of QUERIES) {
    const used = (await Promise.all(q.marker.map(name => present(join(repo, name))))).some(Boolean);
    if (!used) continue;
    const file = await resolveExecutable(q.program, options.path), helper = q.requires ? await resolveExecutable(q.requires, options.path) : file;
    if (!file || !helper) { facts.push(`${q.tool}: ${q.requires && file ? q.requires : q.program} isn't installed; skipped`); continue; }
    const outputs: string[] = [];
    let failed = false;
    for (const argv of q.argv) { const out = await query(file, argv, repo, options.env); if (out === null) failed = true; outputs.push(out ?? ''); }
    if (failed) { facts.push(`${q.tool}: a query failed (no network, or the tool errored); its results are incomplete`); }
    const { lines, fact } = summarize(q.tool, outputs);
    facts.push(fact);
    sections.push(`${q.tool} (${q.argv.map(a => `${q.program} ${a.join(' ')}`).join('; ')}):`, ...lines.slice(0, DEPS_LINES), ...lines.length > DEPS_LINES ? [`… ${lines.length - DEPS_LINES} more`] : []);
  }
  if (!facts.length) facts.push('no package files found (package.json, go.mod, requirements.txt, pyproject.toml, Cargo.toml)');
  return { data: sections.join('\n') || 'No query ran.', facts };
}

import { stripVTControlCharacters } from 'node:util';
import { isAbsolute } from 'node:path';

// v0.7.4 auto-test (D55, on). A project's test command is an argument list, never a shell line: typed once with
// /test-cmd, kept per repository in settings, run in an agent's worktree when it finishes a turn.
export const MAX_TEST_WORDS = 32, MAX_TEST_WORD = 512, MAX_TEST_CHANGED = 20;
// B26: blocked = the sandbox stopped something (what: `network`, `read ~/.ssh/x`, `write /path`); nosandbox = no working
// sandbox, so nothing runs by itself and /test asks every time.
export type TestResult = { state: 'running' } | { state: 'pass' } | { state: 'fail'; failing: number | null } | { state: 'timeout' } | { state: 'error' } | { state: 'ask'; changed: string[] } | { state: 'blocked'; what: string } | { state: 'nosandbox' };
export const MAX_BLOCKED_WHAT = 80;
// What /test shows before it runs: the command, where, the test setup files the agent changed, whether it runs sandboxed
// (B26) and whether the project lets its tests reach 127.0.0.1.
export interface TestPlan { title: string; command: string[]; cwd: string; changed: string[]; fingerprint: string; sandbox: boolean; loopback: boolean }
export interface ProjectTestLoopback { repo: string; loopback: boolean }
export interface ProjectTestCommand { repo: string; command: string[] | null }

// eslint-disable-next-line no-control-regex -- refusing controls is the point.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
export function isTestCommand(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= MAX_TEST_WORDS && value.every(word => typeof word === 'string' && word.length > 0 && word.length <= MAX_TEST_WORD && !CONTROL.test(word));
}
// Words split on spaces; "double" or 'single' quotes keep spaces inside one word. A shell would do more (pipes, $VARS,
// globs, &&): here those are plain characters of a word, because nothing runs through a shell.
export function parseTestCommand(text: string): string[] | null {
  const words: string[] = [];
  let word = '', quote: '"' | "'" | null = null, started = false;
  for (const char of text.trim()) {
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === '"' || char === "'") { quote = char; started = true; continue; }
    if (char === ' ' || char === '\t') { if (started) { words.push(word); word = ''; started = false; } continue; }
    word += char; started = true;
  }
  if (quote) return null;
  if (started) words.push(word);
  return isTestCommand(words) ? words : null;
}
// The command as one line again, quoting only the words that need it.
export function testCommandText(command: readonly string[]): string {
  return command.map(word => /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`).join(' ');
}
// The usual runners' summary lines, most specific first; null when the output doesn't say (the exit code still does).
const COUNTS: readonly RegExp[] = [
  /Tests:?\s+(\d+) failed/,                       // vitest, jest
  /test result: FAILED\.\s+\d+ passed;\s+(\d+) failed/, // cargo
  /^\s*(\d+) failing\b/m,                          // mocha
  /=+[^=\n]*?\b(\d+) failed\b[^=\n]*=+/,           // pytest
  /\b\d+ examples?, (\d+) failures?\b/,            // rspec
];
export function failingCount(output: string): number | null {
  const text = stripVTControlCharacters(output);
  // A count of 0 on a failed run says nothing useful (errors, not failures): unknown.
  for (const pattern of COUNTS) { const match = text.match(pattern); if (match?.[1]) return Number(match[1]) || null; }
  const go = text.match(/^--- FAIL: /gm);
  return go ? go.length : null;
}
// Files that decide what a test command runs: package manager and runner configs, build files, toolchain pins, and the
// command's own script when it names one in the project. A change to one of them means the agent changed the test
// setup itself, so AI Term asks before running it ("and the like": the list is deliberately broad).
const CONFIG_NAMES = new Set(['package.json', '.npmrc', '.yarnrc', '.yarnrc.yml', '.pnpmfile.cjs', 'pnpm-workspace.yaml', 'bunfig.toml', 'deno.json', 'deno.jsonc',
  'conftest.py', 'pytest.ini', 'pyproject.toml', 'setup.cfg', 'setup.py', 'tox.ini', 'noxfile.py', '.coveragerc',
  'makefile', 'gnumakefile', 'justfile', 'rakefile', 'gemfile', '.rspec', 'cargo.toml', 'build.rs', 'go.mod', 'pom.xml', 'mvnw', 'gradlew', 'build.gradle', 'build.gradle.kts', 'settings.gradle', 'settings.gradle.kts', 'gradle.properties',
  'composer.json', 'phpunit.xml', 'phpunit.xml.dist', 'cmakelists.txt', 'meson.build', 'build.zig',
  '.tool-versions', '.nvmrc', '.node-version', '.python-version', '.ruby-version', 'mise.toml', '.mise.toml', 'rust-toolchain', 'rust-toolchain.toml', '.envrc', '.env', '.env.test',
  '.gitignore', 'go.work', '.pnp.cjs', '.pnp.loader.mjs', 'sitecustomize.py', 'usercustomize.py']);
const CONFIG_PATTERNS: readonly RegExp[] = [
  /^(?:vitest|vite|jest|babel|karma|playwright|cypress|ava|webpack|rollup|esbuild|tsup|nyc|c8|wdio|nightwatch)\.(?:config|setup|workspace)\.[a-z]+$/,
  /^(?:jest|vitest)\.[a-z.]*\.[cm]?[jt]s$/, /\.pth$/, /\.gradle(?:\.kts)?$/, /^\.mocharc(?:\.[a-z]+)?$/, /^\.babelrc(?:\.[a-z]+)?$/, /^tsconfig(?:\.[\w-]+)?\.json$/, /^\.c8rc(?:\.json)?$/, /^\.nycrc(?:\.[a-z]+)?$/, /\.mk$/,
];
const CONFIG_FOLDERS = /(?:^|\/)(?:\.cargo|\.mvn|\.husky|gradle|\.yarn|\.bundle)\//;
export function isTestConfig(path: string, command: readonly string[]): boolean {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (CONFIG_NAMES.has(name) || CONFIG_PATTERNS.some(pattern => pattern.test(name)) || CONFIG_FOLDERS.test(path)) return true;
  // `./scripts/test.sh`, `bash scripts/test.sh`, `node ./run.js`: a relative path word is part of the setup. A bare name
  // (`npm`) is found on PATH; an absolute path is outside the worktree.
  return command.some(word => !word.startsWith('/') && !word.startsWith('-') && (word.includes('/') || /\.[A-Za-z0-9]{1,8}$/.test(word)) && word.replace(/^\.\//, '') === path);
}
// Ignored folders package managers fill with code that test commands run (node_modules/.bin, a virtualenv): a fresh
// worktree has none, so whatever is there came from the agent's turns (an install, or a planted file).
const DEPENDENCY_FOLDERS = new Set(['node_modules', '.venv', 'venv', 'env', '.tox', '.nox', '__pypackages__', 'vendor', '.bundle', '.yarn', 'bower_components', 'jspm_packages', '.pnpm-store', '.gradle', '.m2']);
export function isDependencyPath(path: string): boolean { return path.split('/').some(part => DEPENDENCY_FOLDERS.has(part)); }

const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !CONTROL.test(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v);
const isChanged = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_TEST_CHANGED && v.every(isPath);
export function validateTestResult(value: unknown): TestResult {
  const r = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const ok = !!r && (['running', 'pass', 'timeout', 'error', 'nosandbox'].includes(String(r.state)) && exact(r, ['state'])
    || r.state === 'blocked' && exact(r, ['state', 'what']) && typeof r.what === 'string' && r.what.length > 0 && [...r.what].length <= MAX_BLOCKED_WHAT && !CONTROL.test(r.what)
    || r.state === 'fail' && exact(r, ['state', 'failing']) && (r.failing === null || Number.isSafeInteger(r.failing) && Number(r.failing) >= 0)
    || r.state === 'ask' && exact(r, ['state', 'changed']) && isChanged(r.changed));
  if (!ok) throw new Error('Invalid test result');
  return r as unknown as TestResult;
}
export function validateTestPlan(value: unknown): TestPlan {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || !exact(p, ['title', 'command', 'cwd', 'changed', 'fingerprint', 'sandbox', 'loopback']) || typeof p.sandbox !== 'boolean' || typeof p.loopback !== 'boolean' || typeof p.title !== 'string' || [...p.title].length > 60 || CONTROL.test(p.title) || !isTestCommand(p.command) || !isPath(p.cwd) || !isAbsolute(String(p.cwd))
    || !isChanged(p.changed) || typeof p.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.fingerprint)) throw new Error('Invalid test plan');
  return p as unknown as TestPlan;
}
export function validateProjectTestCommand(value: unknown): ProjectTestCommand {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || !exact(p, ['repo', 'command']) || !isPath(p.repo) || !isAbsolute(String(p.repo)) || !(p.command === null || isTestCommand(p.command))) throw new Error('Invalid test command');
  return p as unknown as ProjectTestCommand;
}
export function validateProjectTestLoopback(value: unknown): ProjectTestLoopback {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || !exact(p, ['repo', 'loopback']) || !isPath(p.repo) || !isAbsolute(String(p.repo)) || typeof p.loopback !== 'boolean') throw new Error('Invalid test loopback');
  return p as unknown as ProjectTestLoopback;
}

import { stripVTControlCharacters } from 'node:util';

// v0.7.4 auto-test (D55, on). A project's test command is an argument list, never a shell line: typed once with
// /test-cmd, kept per repository in settings, run in an agent's worktree when it finishes a turn.
export const MAX_TEST_WORDS = 32, MAX_TEST_WORD = 512, MAX_TEST_CHANGED = 20;
export type TestResult = { state: 'running' } | { state: 'pass' } | { state: 'fail'; failing: number | null } | { state: 'timeout' } | { state: 'error' } | { state: 'ask'; changed: string[] };
// What /test shows before it runs: the command, where, and the test setup files the agent changed.
export interface TestPlan { title: string; command: string[]; cwd: string; changed: string[]; fingerprint: string }
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
  for (const pattern of COUNTS) { const match = text.match(pattern); if (match?.[1]) return Number(match[1]); }
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
  '.tool-versions', '.nvmrc', '.node-version', '.python-version', '.ruby-version', 'mise.toml', '.mise.toml', 'rust-toolchain', 'rust-toolchain.toml', '.envrc', '.env', '.env.test']);
const CONFIG_PATTERNS: readonly RegExp[] = [
  /^(?:vitest|vite|jest|babel|karma|playwright|cypress|ava|webpack|rollup|esbuild|tsup|nyc|c8|wdio|nightwatch)\.(?:config|setup|workspace)\.[a-z]+$/,
  /^(?:jest|vitest)\.[a-z.]*\.[cm]?[jt]s$/, /^\.mocharc(?:\.[a-z]+)?$/, /^\.babelrc(?:\.[a-z]+)?$/, /^tsconfig(?:\.[\w-]+)?\.json$/, /^\.c8rc(?:\.json)?$/, /^\.nycrc(?:\.[a-z]+)?$/, /\.mk$/,
];
const CONFIG_FOLDERS = /(?:^|\/)(?:\.cargo|\.mvn|\.husky|gradle)\//;
export function isTestConfig(path: string, command: readonly string[]): boolean {
  const name = path.split('/').at(-1)?.toLowerCase() ?? '';
  if (CONFIG_NAMES.has(name) || CONFIG_PATTERNS.some(pattern => pattern.test(name)) || CONFIG_FOLDERS.test(path)) return true;
  // `./scripts/test.sh` or `scripts/test.sh`: the script is part of the setup. A bare name (`npm`) is found on PATH.
  const program = command[0] ?? '';
  return program.includes('/') && !program.startsWith('/') && program.replace(/^\.\//, '') === path;
}

const isPath = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 1024 && !CONTROL.test(v);
const exact = (v: Record<string, unknown>, keys: string[]) => Object.keys(v).length === keys.length && keys.every(k => k in v);
const isChanged = (v: unknown): v is string[] => Array.isArray(v) && v.length <= MAX_TEST_CHANGED && v.every(isPath);
export function validateTestResult(value: unknown): TestResult {
  const r = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const ok = !!r && (['running', 'pass', 'timeout', 'error'].includes(String(r.state)) && exact(r, ['state'])
    || r.state === 'fail' && exact(r, ['state', 'failing']) && (r.failing === null || Number.isSafeInteger(r.failing) && Number(r.failing) >= 0)
    || r.state === 'ask' && exact(r, ['state', 'changed']) && isChanged(r.changed));
  if (!ok) throw new Error('Invalid test result');
  return r as unknown as TestResult;
}
export function validateTestPlan(value: unknown): TestPlan {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || !exact(p, ['title', 'command', 'cwd', 'changed', 'fingerprint']) || typeof p.title !== 'string' || [...p.title].length > 60 || CONTROL.test(p.title) || !isTestCommand(p.command) || !isPath(p.cwd) || !String(p.cwd).startsWith('/')
    || !isChanged(p.changed) || typeof p.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(p.fingerprint)) throw new Error('Invalid test plan');
  return p as unknown as TestPlan;
}
export function validateProjectTestCommand(value: unknown): ProjectTestCommand {
  const p = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  if (!p || !exact(p, ['repo', 'command']) || !isPath(p.repo) || !String(p.repo).startsWith('/') || !(p.command === null || isTestCommand(p.command))) throw new Error('Invalid test command');
  return p as unknown as ProjectTestCommand;
}

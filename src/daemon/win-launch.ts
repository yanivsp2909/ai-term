import { readFile, stat } from 'node:fs/promises';
import { win32 } from 'node:path';

// v0.8.2 Windows. Claude Code and Codex installed with npm arrive as .cmd launchers (npm's cmd-shim). Node refuses to run a
// .cmd without a shell, and cmd.exe would read %, &, |, ^ and quotes in an argument (a first message, a handoff note) as
// its own syntax. So AI Term never runs the .cmd: it reads the one line that names the CLI's script and runs that script
// with node, the arguments staying an array. A native .exe (Claude Code's installer, Codex's binary) runs directly. A .cmd
// that isn't npm's launcher is refused: running it would need cmd.exe and a command line built from text.
export class CliLaunchError extends Error {}
export const CLI_LAUNCH_ERRORS = ["This CLI's .cmd launcher isn't npm's, so AI Term won't run it through cmd.exe; reinstall it with npm or its own installer"];
// npm's launcher ends with: "%_prog%"  "%dp0%\node_modules\<package>\<script>" %*
const SHIM_LINE = /"%_prog%"\s+"%dp0%\\([^"%]+)"\s+%\*\s*$/m;
// npm's and npx's own launchers (npm.cmd, npx.cmd) name their script in a SET line instead.
const NPM_LINE = /^SET "NP[MX]_CLI_JS=%~dp0\\([^"%]+)"\s*$/m;
export function parseNpmShim(text: string, folder: string): string | null {
  if (text.length > 4096) return null;
  const relative = text.match(SHIM_LINE)?.[1] ?? text.match(NPM_LINE)?.[1];
  if (!relative || !/\.(?:c|m)?js$/i.test(relative) || relative.split('\\').some(part => part === '..' || part === '.' || part === '')) return null;
  const script = win32.join(folder, relative);
  return script.startsWith(`${win32.normalize(folder)}\\`) ? script : null;
}
export interface LaunchFacts { shim: string | null; node: string | null; script: boolean }
export interface Recipe { executable: string; args: string[] }
export function windowsCommand(recipe: Recipe, facts: LaunchFacts): Recipe {
  if (!/\.cmd$/i.test(recipe.executable)) return recipe;
  const script = facts.shim !== null ? parseNpmShim(facts.shim, win32.dirname(recipe.executable)) : null;
  if (!script || !facts.node || !facts.script) throw new CliLaunchError(CLI_LAUNCH_ERRORS[0]);
  return { executable: facts.node, args: [script, ...recipe.args] };
}
// What windowsCommand needs to know, read from disk: the launcher's text and a node to run its script (npm's own choice:
// node.exe beside the launcher, else node.exe on PATH).
export async function launchFacts(executable: string, path: string): Promise<LaunchFacts> {
  if (!/\.cmd$/i.test(executable)) return { shim: null, node: null, script: false };
  const shim = await readFile(executable, 'utf8').catch(() => null);
  const script = shim !== null ? parseNpmShim(shim, win32.dirname(executable)) : null;
  const beside = win32.join(win32.dirname(executable), 'node.exe');
  const node = await stat(beside).then(info => info.isFile() ? beside : null, () => null) ?? await findNode(path);
  return { shim, node, script: script !== null && await stat(script).then(info => info.isFile(), () => false) };
}
async function findNode(path: string): Promise<string | null> {
  for (const folder of path.split(';')) {
    if (!win32.isAbsolute(folder)) continue;
    const candidate = win32.join(folder, 'node.exe');
    if (await stat(candidate).then(info => info.isFile(), () => false)) return candidate;
  }
  return null;
}
// The recipe a PTY or execFile can run on Windows; unchanged elsewhere.
export async function windowsRecipe(recipe: Recipe, path: string, platform: NodeJS.Platform = process.platform): Promise<Recipe> {
  return platform === 'win32' ? windowsCommand(recipe, await launchFacts(recipe.executable, path)) : recipe;
}
// A shell session on Windows is PowerShell (7 when installed, else Windows PowerShell), started with no arguments: an
// interactive shell you asked for, not a way to run text.
export function windowsShell(env: Readonly<Record<string, string | undefined>>, exists: (path: string) => boolean): string {
  const seven = win32.join(env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe');
  return exists(seven) ? seven : win32.join(env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}
// A test command on Windows (v0.8.2): its program found on PATH (.exe, .com, then .cmd read as above); a .bat, or a .cmd
// that isn't npm's, can't run without cmd.exe and is refused.
export async function windowsTestCommand(command: readonly string[], path: string): Promise<string[]> {
  const [program, ...args] = command;
  if (!program) throw new CliLaunchError(CLI_LAUNCH_ERRORS[0]);
  let found: string | null = win32.isAbsolute(program) ? program : null;
  for (const folder of found ? [] : path.split(';').filter(dir => win32.isAbsolute(dir))) {
    for (const ext of /\.[A-Za-z]{3}$/.test(program) ? [''] : ['.exe', '.com', '.cmd']) {
      const candidate = win32.join(folder, program + ext);
      if (await stat(candidate).then(info => info.isFile(), () => false)) { found = candidate; break; }
    }
    if (found) break;
  }
  if (!found) return [...command];
  const recipe = await windowsRecipe({ executable: found, args }, path);
  return [recipe.executable, ...recipe.args];
}

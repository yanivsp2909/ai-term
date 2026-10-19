#!/usr/bin/env node
// Part C: builds the public source snapshot of AI Term in a new folder, from one commit of this repository.
//   node scripts/public-snapshot.mjs <empty or new folder> [commit]          builds the tree only
//   node scripts/public-snapshot.mjs --commit <that folder>                  makes its one git commit
// It never pushes, never creates a GitHub repository and never touches this checkout: git archive reads the commit,
// tar writes only into the new folder. Every process gets an argument array, never a shell.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OVERLAY = join(ROOT, 'public');
// The public commit's author: GitHub's noreply address, so no real email is published.
const AUTHOR = { name: 'Yaniv', email: '77485644+yanivsp2909@users.noreply.github.com' };
const MAX = 64 * 1024 * 1024;

// Left out, with why (PUBLIC_SNAPSHOT.md repeats this list).
const LEFT_OUT = [
  ['PROGRESS.md', 'private build log: handovers, manual checks and machine details'],
  ['docs/reviews', 'private review transcripts'],
  ['docs/spikes/v0.1-cli-facts.md', 'personal paths and a real Azure resource name'],
  ['docs/spikes/v0.1-codex-setup.md', 'an inventory of a personal home folder'],
  ['docs/spikes/v0.1-daemon-core.md', 'personal paths and file listings'],
  ['docs/testing/v093-perf-ab.json', 'measurement output with personal paths'],
  ['docs/addons/inventory.md', 'an inventory of locally installed skills, agents and commands'],
  ['tests/addon-inventory.test.ts', 'it checks docs/addons/inventory.md, which is left out'],
  ['.claude', 'local agent settings for development'],
  ['.codex', 'local agent settings for development'],
  ['.agents', 'local agent settings for development'],
  ['public', 'the overlay this script copies in'],
  ['scripts/public-snapshot.mjs', 'this script'],
];
// Shared add-on copies are kept only when their source license allows sharing: the License line of the header (the
// lines right after the front matter) must name MIT, Apache-2.0 or a BSD license and nothing else.
const PERMISSIVE = /^License: (?:MIT|Apache[ -]2\.0|BSD(?:-[23]-Clause)?)(?: \([^()]*\))?\.?$/;
export function permissive(text) {
  const lines = text.split('\n'), end = lines[0] === '---' ? lines.indexOf('---', 1) : -1;
  if (end < 0) return false;
  const header = [];
  for (const line of lines.slice(end + 1)) { if (!line.trim()) break; header.push(line); }
  const licenses = header.filter(line => line.startsWith('License:'));
  return licenses.length === 1 && PERMISSIVE.test(licenses[0]);
}
// A tree with any of these in it is refused: real names this repository's history once held. Fake ones in tests are
// listed as allowed. Built from parts so this file doesn't trip its own check.
// (The GitHub handle in SECURITY.md and the noreply author are public on purpose; the macOS user name is not.)
const FORBIDDEN = [...[['yaniv', 'sp(?!2909)'], ['yaniv', '2909sp'], ['gmail', '\\.com'], ['narvis', '-resource'], ['Jeru', 'salem']].map(parts => new RegExp(parts.join(''), 'i')),
  new RegExp(["(?:'|····)IT", 'id\\b'].join(''))];
const ALLOWED = {
  users: new Set(['me', 'test', 'x', 'y', 'foo', 'secret', 'someone', 'victim']),
  homes: new Set(['me', 'u', 'brain', 'linuxbrew', 'addons', 'stop', 'reattach', 'plans']),
  windowsUsers: new Set(['me']),
  tailnets: new Set(['tail1234']),
  azure: new Set(['example', 'example-resource', 'r', 'x', 'b28', 'secrets']),
};

async function git(args, cwd = ROOT) { return (await run('git', args, { cwd, maxBuffer: MAX })).stdout; }
async function gone(path) { try { await lstat(path); return false; } catch (error) { if (error?.code === 'ENOENT') return true; throw error; } }
// Every file under dir. A link is refused: tar keeps tracked links, and writes, deletes or reads through one could
// reach outside the snapshot (Part C review).
async function walk(dir, base = dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`${relative(base, full)} is a link; the snapshot holds none`);
    if (entry.isDirectory()) { if (entry.name !== '.git') out.push(...await walk(full, base)); }
    else out.push(relative(base, full));
  }
  return out;
}

export async function build(target, ref) {
  const out = resolve(target);
  if (!(await gone(out)) && (await readdir(out)).length) throw new Error(`${out} is not empty; give a new folder`);
  const commit = (await git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`])).trim();
  await mkdir(out, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), 'ai-term-snapshot-')), tar = join(scratch, 'tree.tar');
  try {
    await git(['archive', '--format=tar', `--output=${tar}`, '--end-of-options', commit]);
    await run('tar', ['-xf', tar, '-C', out], { maxBuffer: MAX });
  } finally { await rm(scratch, { recursive: true, force: true }); }

  for (const [path] of LEFT_OUT) await rm(join(out, path), { recursive: true, force: true });

  await walk(out);
  const shared = join(out, 'addons', '_shared'), leftCopies = [];
  for (const file of (await walk(shared)).sort()) {
    if (!file.endsWith('.md')) throw new Error(`addons/_shared/${file} is not a guide this script knows how to check`);
    if (!permissive(await readFile(join(shared, file), 'utf8'))) { leftCopies.push(file); await rm(join(shared, file)); }
  }
  for (const dir of await readdir(join(shared, 'skills'))) if (!(await readdir(join(shared, 'skills', dir))).length) await rm(join(shared, 'skills', dir), { recursive: true });
  await writeFile(join(shared, 'LEFT_OUT.txt'), leftCopies.join('\n') + '\n');
  const fallbacks = [];
  for (const name of (await readdir(join(out, 'addons'))).sort()) {
    if (name.startsWith('_')) continue;
    const text = await readFile(join(out, 'addons', name, 'addon.md'), 'utf8');
    const list = key => JSON.parse(text.match(new RegExp(`^${key}: (\\[.*\\])$`, 'm'))?.[1] ?? '[]');
    const used = [...list('skills').map(s => `skills/${s}/SKILL.md`), ...list('agents').map(a => `agents/${a}.md`)], missing = used.filter(p => leftCopies.includes(p));
    if (missing.length) fallbacks.push(`/${name}${missing.length === used.length ? '' : ' (keeps the rest)'}`);
  }

  const readme = await readFile(join(out, 'README.md'), 'utf8'), from = readme.indexOf('\n## Install');
  if (from < 0) throw new Error('README.md has no ## Install section to keep');
  await writeFile(join(out, 'README.md'), (await readFile(join(OVERLAY, 'README.md'), 'utf8')).trimEnd() + '\n' + readme.slice(from));
  for (const file of ['LICENSE', 'SECURITY.md', '.gitleaks.toml']) await copyFile(join(OVERLAY, file), join(out, file));
  await mkdir(join(out, 'licenses'), { recursive: true });
  await copyFile(join(OVERLAY, 'licenses', 'Apache-2.0.txt'), join(out, 'licenses', 'Apache-2.0.txt'));
  await writeFile(join(out, 'THIRD_PARTY_NOTICES.md'), await notices(out, shared));
  const template = await readFile(join(OVERLAY, 'PUBLIC_SNAPSHOT.md'), 'utf8');
  await writeFile(join(out, 'PUBLIC_SNAPSHOT.md'), template
    .replaceAll('{{COMMIT}}', commit)
    .replaceAll('{{DATE}}', (await git(['show', '-s', '--format=%cs', '--end-of-options', commit])).trim())
    .replace('{{LEFT_OUT}}', LEFT_OUT.filter(([path]) => !['public', 'scripts/public-snapshot.mjs'].includes(path)).map(([path, why]) => `- \`${path}\`: ${why}.`).join('\n'))
    .replace('{{COPIES}}', String(leftCopies.length))
    .replace('{{FALLBACKS}}', fallbacks.join(', '))
    .replace('{{VERIFICATION}}', 'Not verified yet: run the checks below, then record their last lines here before the commit.'));

  const found = await markers(out);
  if (found.length) throw new Error(`Personal markers left in the snapshot:\n${found.join('\n')}`);
  process.stdout.write(`Snapshot of ${commit} in ${out}: ${leftCopies.length} shared copies left out; add-ons on their own steps: ${fallbacks.join(', ')}\n`);
}

// npm packages and their licenses from package-lock.json (none of them is in this tree; npm installs them), and the
// shared copies this snapshot keeps with the license their source states.
async function notices(out, shared) {
  const lock = JSON.parse(await readFile(join(out, 'package-lock.json'), 'utf8')), by = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), license = typeof meta.license === 'string' ? meta.license : 'not stated in package-lock.json';
    const set = by.get(license) ?? new Set(); set.add(`${name}@${meta.version}`); by.set(license, set);
  }
  const kept = [];
  for (const file of (await walk(shared)).sort()) {
    if (!file.endsWith('.md')) continue;
    const text = await readFile(join(shared, file), 'utf8');
    const license = text.match(/^License: (.*)$/m)?.[1] ?? 'not stated';
    kept.push(`- \`addons/_shared/${file}\`: adapted from ${text.match(/^Source: (.*)$/m)?.[1]?.replace(/~\/[^ ]*\/([^/ ]+)\/SKILL\.md/, 'the `$1` skill') ?? 'a source not stated'} License: ${license} Its changes are listed in the file's "What changed" line.${/Apache/.test(license) ? ' The license text is in `licenses/Apache-2.0.txt`.' : ''}`);
  }
  const sections = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([license, names]) => `### ${license} (${names.size})\n\n${[...names].sort().join(', ')}`);
  return `# Third-party notices

AI Term's own code is under the MIT license (LICENSE).

## Adapted skill and agent texts

Add-ons bundle short guides adapted from skills and agents. This snapshot keeps only those whose source states a
license that allows sharing; the others are left out (PUBLIC_SNAPSHOT.md).

${kept.join('\n')}

## Price data

\`data/usage-prices.json\` holds list prices and limits taken from the Models.dev catalog (https://models.dev), under
that catalog's own license.

## npm packages

This tree contains no third-party code: \`npm ci\` installs these packages, each under its own license (as recorded
in package-lock.json, including development and optional packages).

${sections.join('\n\n')}
`;
}

// What a line (or a file name) holds that the snapshot must not: a real name, or a home, tailnet or Azure name that
// isn't one of the tests' fakes.
function lineMarkers(line) {
  const found = FORBIDDEN.filter(pattern => pattern.test(line)).map(pattern => pattern.source);
  for (const [, name] of line.matchAll(/\/Users\/([A-Za-z0-9._-]+)/gi)) if (!ALLOWED.users.has(name)) found.push(`/Users/${name}`);
  for (const [, name] of line.matchAll(/\/home\/([A-Za-z0-9._-]+)/gi)) if (!ALLOWED.homes.has(name)) found.push(`/home/${name}`);
  for (const [, name] of line.matchAll(/[A-Za-z]:\\+Users\\+([A-Za-z0-9._-]+)/gi)) if (!ALLOWED.windowsUsers.has(name.toLowerCase())) found.push(`C:\\Users\\${name}`);
  for (const [, name] of line.matchAll(/([a-z0-9-]+)\.ts\.net/gi)) if (!ALLOWED.tailnets.has(name)) found.push(`${name}.ts.net`);
  for (const [, name] of line.matchAll(/([a-z0-9-]+)\.openai\.azure\.com/gi)) if (!ALLOWED.azure.has(name)) found.push(`${name}.openai.azure.com`);
  return found;
}
// files: the paths to check (default: every file under out). A file that isn't text is reported, never skipped.
export async function markers(out, files) {
  const found = [];
  for (const file of files ?? await walk(out)) {
    for (const marker of lineMarkers(file)) found.push(`${file}: name matches ${marker}`);
    const text = await readFile(join(out, file), 'utf8');
    if (text.includes('\u0000')) { found.push(`${file}: not text; check it by hand and leave it out`); continue; }
    text.split('\n').forEach((line, index) => { for (const marker of lineMarkers(line)) found.push(`${file}:${index + 1}: ${marker}`); });
  }
  return found;
}

// base: only PATH (and SystemRoot on Windows) is taken from it. Git gets an empty home and config, UTC, no template, no
// hooks and no signing, so nothing of this machine (an ignore file, GIT_DIR, a hook, a key, the time zone) shapes the
// public commit (Part C review). The files git would commit are checked again, and nothing is committed on a refusal.
export async function commit(target, base = process.env) {
  const out = resolve(target);
  if (!(await gone(join(out, '.git')))) throw new Error(`${out} already has a git repository`);
  const snapshot = await readFile(join(out, 'PUBLIC_SNAPSHOT.md'), 'utf8'), source = snapshot.match(/commit `([0-9a-f]{40})`/)?.[1];
  if (!source) throw new Error('PUBLIC_SNAPSHOT.md names no source commit');
  if (snapshot.includes('Not verified yet')) throw new Error('PUBLIC_SNAPSHOT.md is not verified yet: run its checks and record them first');
  const home = await mkdtemp(join(tmpdir(), 'ai-term-snapshot-home-')), empty = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const env = { PATH: base.PATH ?? '', ...(base.SystemRoot ? { SystemRoot: base.SystemRoot } : {}), HOME: home, XDG_CONFIG_HOME: home, TZ: 'UTC', LANG: 'C', GIT_CONFIG_GLOBAL: empty, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: AUTHOR.name, GIT_AUTHOR_EMAIL: AUTHOR.email, GIT_COMMITTER_NAME: AUTHOR.name, GIT_COMMITTER_EMAIL: AUTHOR.email };
  const g = args => run('git', ['-c', `core.hooksPath=${empty}`, '-c', `core.excludesFile=${empty}`, '-c', 'commit.gpgsign=false', ...args], { cwd: out, env, maxBuffer: MAX });
  try {
    await g(['init', '-q', '-b', 'main', '--template=', '--', out]);
    await g(['add', '-A', '--', '.']);
    const files = (await g(['ls-files', '-z'])).stdout.split('\0').filter(Boolean);
    for (const file of files) if ((await lstat(join(out, file))).isSymbolicLink()) throw new Error(`${file} is a link; the snapshot holds none`);
    const found = await markers(out, files);
    if (found.length) throw new Error(`Personal markers left in the snapshot:\n${found.join('\n')}`);
    await g(['commit', '-q', '-m', `AI Term public source snapshot\n\nExported from private commit ${source.slice(0, 12)}; see PUBLIC_SNAPSHOT.md.`]);
    process.stdout.write((await g(['log', '--format=%H %an <%ae> %ai %s', '-1'])).stdout);
  } catch (error) { await rm(join(out, '.git'), { recursive: true, force: true }); throw error; }
  finally { await rm(home, { recursive: true, force: true }); }
}

const [first, second, third] = process.argv.slice(2);
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) try {
  if (third) throw new Error('Too many arguments');
  if (first === '--commit' && second) await commit(second);
  else if (first && !first.startsWith('-')) await build(first, second ?? 'main');
  else { process.stderr.write('usage: node scripts/public-snapshot.mjs <new folder> [commit] | --commit <folder>\n'); process.exitCode = 2; }
} catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }

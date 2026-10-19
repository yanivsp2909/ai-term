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
  ['tests/partc-snapshot.test.ts', 'it tests this script, which stays private'],
];
// v1.2: the add-on guides are AI Term's own; each starts with this MIT header. A guide without it, or any leftover
// copy of the old shared guides (sources with no license), stops the export.
export const GUIDE_HEADER = '<!-- Copyright (c) 2026 AI Term contributors. MIT license: see LICENSE in the repository root. -->';
export async function guideProblems(out) {
  const found = [];
  if (!(await gone(join(out, 'addons', '_shared')))) found.push('addons/_shared: the old shared guides must not ship');
  const guides = join(out, 'addons', 'guides');
  for (const file of (await walk(guides)).sort()) {
    if (!file.endsWith('.md')) { found.push(`addons/guides/${file}: not a guide`); continue; }
    if ((await readFile(join(guides, file), 'utf8')).split('\n')[0] !== GUIDE_HEADER) found.push(`addons/guides/${file}: no MIT header`);
  }
  return found;
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

  const removed = [];
  for (const [path, why] of LEFT_OUT) { if (!(await gone(join(out, path)))) removed.push([path, why]); await rm(join(out, path), { recursive: true, force: true }); }

  await walk(out);
  const problems = await guideProblems(out);
  if (problems.length) throw new Error(`Add-on guides that can't ship:\n${problems.join('\n')}`);
  const guides = (await walk(join(out, 'addons', 'guides'))).length;

  const readme = await readFile(join(out, 'README.md'), 'utf8'), from = readme.indexOf('\n## Install');
  if (from < 0) throw new Error('README.md has no ## Install section to keep');
  const kept = readme.slice(from).replace('git clone <this repository> ai-term', 'git clone https://github.com/yanivsp2909/ai-term-public.git ai-term');
  await writeFile(join(out, 'README.md'), (await readFile(join(OVERLAY, 'README.md'), 'utf8')).trimEnd() + '\n' + kept);
  // design.md links the private mockups in Claude Design; nobody else can open them.
  const design = join(out, 'docs', 'design.md');
  await writeFile(design, (await readFile(design, 'utf8')).replace(/Mockups: canvas "AI Term screens" \(https:\/\/claude\.ai\/artifact\/\w+\); design system: https:\/\/claude\.ai\/artifact\/\w+\. Agents can't open those/, "Its mockups and design system are private. Nobody else can open those"));
  for (const file of ['LICENSE', 'SECURITY.md', '.gitleaks.toml']) await copyFile(join(OVERLAY, file), join(out, file));
  await writeFile(join(out, 'THIRD_PARTY_NOTICES.md'), await notices(out));
  const template = await readFile(join(OVERLAY, 'PUBLIC_SNAPSHOT.md'), 'utf8');
  await writeFile(join(out, 'PUBLIC_SNAPSHOT.md'), template
    .replaceAll('{{COMMIT}}', commit)
    .replaceAll('{{DATE}}', (await git(['show', '-s', '--format=%cs', '--end-of-options', commit])).trim())
    .replace('{{LEFT_OUT}}', removed.filter(([path]) => !['public', 'scripts/public-snapshot.mjs', 'tests/partc-snapshot.test.ts'].includes(path)).map(([path, why]) => `- \`${path}\`: ${why}.`).join('\n'))
    .replace('{{GUIDES}}', String(guides))
    .replace('{{VERIFICATION}}', 'Not verified yet: run the checks below, then record their last lines here before the commit.'));

  const found = await markers(out);
  if (found.length) throw new Error(`Personal markers left in the snapshot:\n${found.join('\n')}`);
  process.stdout.write(`Snapshot of ${commit} in ${out}: ${guides} add-on guides\n`);
}

// npm packages and their licenses from package-lock.json (none of them is in this tree; npm installs them).
async function notices(out) {
  const lock = JSON.parse(await readFile(join(out, 'package-lock.json'), 'utf8')), by = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length), license = typeof meta.license === 'string' ? meta.license : 'not stated in package-lock.json';
    const set = by.get(license) ?? new Set(); set.add(`${name}@${meta.version}`); by.set(license, set);
  }
  const sections = [...by.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([license, names]) => `### ${license} (${names.size})\n\n${[...names].sort().join(', ')}`);
  return `# Third-party notices

AI Term's own code is under the MIT license (LICENSE).

## Add-on guides

The guides in \`addons/guides/\` were written for AI Term and are under its MIT license, like the rest of its code.

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

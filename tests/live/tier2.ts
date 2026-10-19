import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { RESET_MODES } from '../../src/client/terminal-modes.js';
import { answerKeys, approvable } from '../../src/daemon/remote/backend.js';
import type { Cleanup } from './cleanup.js';
import { Home } from './home.js';
import { runChecks, type Check } from './runner.js';
import { KEY, LiveFailure, sleep, type Screen } from './screen.js';
import { expectedApproval, MAX_APPROVALS, removeRunKeys } from './tier2-rules.js';
import { textOf } from './tier1-helpers.js';
import { connect, connectOrStart, endWorld, git, makeRepo, makeWorld, startAi, type World } from './world.js';

// Tier 2 (npm run live -- --with-logins): your own Claude Code and Codex logins, one API key of yours and your gh login,
// in a throwaway AI Term folder (never ~/.ai-term). It runs with your real home, so the CLIs find their own logins;
// AI Term never reads them. What it can't answer by itself (your key, a prompt it doesn't know) it hands to you in this
// terminal: you type as usual, and it takes over again when that's done, or when you press Ctrl+].
// Prompts it answers: Claude Code's folder trust for this run's own temp folder ("1. Yes, proceed"), and only plain
// yes/no permission prompts for exactly what it asked (tier2-rules.ts), with the phone remote's own keys.
const run = promisify(execFile);
const HAND_BACK = '\x1d', CTRL_C = '\x03';
const KEY_MODEL: Record<string, string> = { anthropic: 'claude-haiku-4-5', openai: 'gpt-5-mini' };
export interface Tier2Options { github: string; issue: string; pr: string; keyModel: string | null }
interface Tier2 { world: World; repo: string; ai: Screen; home: Home; out: (line: string) => void; options: Tier2Options; github: string | null; input: Input }

// Every tier 2 flag, checked before anything starts (review: a bad --issue was found after tier 1 had run).
export function tier2Options(args: readonly string[]): Tier2Options {
  const value = (name: string) => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`); return v; };
  const number = (name: string) => { const v = value(name) ?? '1'; if (!/^[1-9]\d{0,6}$/.test(v)) throw new Error(`${name} takes a number, like ${name} 12`); return v; };
  const keyModel = value('--key-model') ?? null;
  if (keyModel !== null && !/^[A-Za-z0-9][\w.:/-]{0,120}$/.test(keyModel)) throw new Error('--key-model takes a model id, like claude-haiku-4-5');
  return { github: value('--github') ?? join(homedir(), 'ai-term'), issue: number('--issue'), pr: number('--pr'), keyModel };
}

// Your keyboard during tier 2. Raw from the start (security review: in cooked mode a key pasted early echoed in clear and
// reached ai later), dropped unless a hand-off forwards it; Ctrl+C outside a hand-off stops the run as usual.
class Input {
  private forward: ((text: string) => void) | null = null;
  private readonly listener = (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    if (this.forward) this.forward(text);
    else if (text.includes(CTRL_C)) process.kill(process.pid, 'SIGINT');
  };
  start(): void { process.stdin.setRawMode(true); process.stdin.on('data', this.listener); process.stdin.resume(); }
  to(forward: ((text: string) => void) | null): void { this.forward = forward; }
  stop(): void { process.stdin.off('data', this.listener); if (process.stdin.isTTY) process.stdin.setRawMode(false); process.stdin.pause(); }
}

const step = (id: string, name: string, look: string, body: (t: Tier2) => Promise<void>): Check<Tier2> => ({ id, name, look, run: body });
const fail = async (t: Tier2, message: string): Promise<never> => { throw new LiveFailure(message, await t.ai.text()); };
const lines = async (t: Tier2) => (await t.ai.text()).split('\n');

// Your terminal, given to ai until `done` holds or you press Ctrl+]. The PTY takes your window's size meanwhile, so ai
// redraws everything for you; your terminal answers ai's queries then (the mirror stays quiet), and its modes are reset
// afterwards. A key typed after ai exited is dropped, never thrown (review).
async function handOff(t: Tier2, why: string, done: () => Promise<boolean>): Promise<void> {
  t.out(`\n→ ${why}\n  ai opens here in a moment; type as you usually would. The suite takes over again by itself, or when you press Ctrl+].`);
  await sleep(2500);
  process.stdout.write('\x1b[?1049h\x1b[2J\x1b[H');
  const untap = t.ai.tap(data => process.stdout.write(data));
  t.ai.answering = false; t.ai.resize(process.stdout.columns || 120, process.stdout.rows || 40);
  let back = false;
  t.input.to(text => { if (text.includes(HAND_BACK)) back = true; else if (!t.ai.finished) t.ai.write(text); });
  try { while (!back && !await done()) { if (t.ai.finished) await fail(t, 'ai exited while it was yours'); await sleep(200); } }
  finally { t.input.to(null); untap(); process.stdout.write(`${RESET_MODES}\x1b[?1049l`); t.ai.answering = true; t.ai.resize(120, 40); await sleep(500); }
}

// An agent of `engine` started from the homepage with `message`, then attached; its prompts are answered as above until
// `finished` holds. A plain yes/no permission prompt must have been seen, AI Term's card saying "asks: permission" while
// it was up; at most MAX_APPROVALS yeses, each only for `expected` (anything else goes to you).
async function cliTurn(t: Tier2, engine: 'claude-code' | 'codex', title: string, message: string, expected: string, finished: () => Promise<boolean>): Promise<string> {
  await t.home.command(message); await t.ai.waitFor('Start a new agent');
  if (/✗ /.test(await t.ai.text())) await fail(t, `the start box refuses ${title}`);
  t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent'); await t.home.waitCard(title);
  await t.home.attach(title);
  let asked = '', approvals = 0;
  const deadline = Date.now() + 5 * 60_000, world = basename(t.world.root);
  while (!await finished()) {
    if (Date.now() > deadline) await fail(t, `${title} didn't finish within 5 minutes`);
    const screen = await lines(t), text = screen.join('\n');
    if (engine === 'codex' && /update (?:available|now)|new version of codex/i.test(text)) await fail(t, 'Codex offers an update: never approve one from here. Update Codex yourself, then run this again');
    // Claude Code's folder trust, only for this run's own temp folder (security review: never your checkout or home).
    if (engine === 'claude-code' && /trust the files in this folder/i.test(text) && /1\.\s*Yes, proceed/.test(text)) {
      if (!text.includes(world)) await fail(t, `Claude Code asks to trust a folder outside this run's temp folder (${world}): not answered`);
      t.out('  answered: Claude Code\'s folder trust for this temp folder, 1. Yes, proceed'); t.ai.write('1'); await sleep(1500); continue;
    }
    if (approvable(engine, screen)) {
      asked = screen.filter(line => /\S/.test(line)).slice(-8).join(' / ').replace(/\s+/g, ' ');
      if (!expectedApproval(engine, screen, expected) || approvals >= MAX_APPROVALS) {
        await handOff(t, `${title} asks for something the suite didn't ask for (or asks again): answer it yourself, as you would.`, async () => !approvable(engine, await lines(t)));
        continue;
      }
      // What AI Term shows meanwhile: the card says it's asking for permission (what notifications and the phone use).
      t.ai.write(KEY.ctrlE); await t.home.home();
      await t.home.waitStatus(title, /asks: permission|● waiting/, 30_000, 'asking for permission');
      await t.home.attach(title); await sleep(800);
      if (!expectedApproval(engine, await lines(t), expected)) await fail(t, `${title}'s permission prompt was gone or changed when the suite came back to answer it`);
      approvals++; t.ai.write(answerKeys(engine, true)); await sleep(1500); continue;
    }
    if (/Do you trust|trust this folder|trust the contents/i.test(text)) { await handOff(t, `${title} asks whether to trust its temporary folder. Answer it as you would.`, async () => !/Do you trust|trust this folder|trust the contents/i.test(await t.ai.text())); continue; }
    await sleep(500);
  }
  t.ai.write(KEY.ctrlE); await t.home.home();
  if (!asked) await fail(t, `${title} did it without a permission prompt: Ask mode didn't hold`);
  return asked;
}
async function worktreeOf(repo: string, branch: string): Promise<string> {
  const list = await git(repo, 'worktree', 'list', '--porcelain');
  const path = list.split('\n\n').find(b => b.split('\n').includes(`branch refs/heads/${branch}`))?.split('\n').find(l => l.startsWith('worktree '))?.slice(9);
  if (!path) throw new LiveFailure(`git lists no worktree on ${branch}`, list);
  return path;
}
const fileSays = async (path: string, word: string) => (await textOf(path)).trim() === word;

const TIER2: readonly Check<Tier2>[] = [
  step('start', 'ai finds your Claude Code and Codex logins', 'the homepage without the login popup; the bottom line says claude code · own login', async t => {
    await t.home.home(); await sleep(2500);
    // v1.2: a new AI Term folder opens the first-run setup first; skip it.
    if ((await t.ai.text()).includes("What's installed")) { t.ai.write(KEY.esc); await t.ai.waitGone("What's installed"); }
    if ((await t.ai.text()).includes('Connect a provider')) await fail(t, 'AI Term found no Claude Code or Codex login. Log in to them first (claude, then codex login), then run this again');
    // B35: the bottom line shows each field whole or not at all, auth right after the engine (no folder or empty field
    // between), so a correct line reads "<model> · claude code · own login …".
    await t.ai.waitFor(/· claude code · own login/, 10_000, 'claude code · own login on the bottom line');
  }),
  step('claude', 'Claude Code in Ask on your login: one tiny prompt, its permission prompt, approved', 'Claude Code asking "Do you want to create live.txt?" (1. Yes), AI Term\'s card saying it asks for permission, then live.txt in its worktree', async t => {
    let worktree = '';
    const asked = await cliTurn(t, 'claude-code', 'Claude Code', 'Create a file named live.txt containing the single word hi. Nothing else.', 'live.txt', async () => {
      worktree ||= await worktreeOf(t.repo, 'ai/claude-code').catch(() => ''); return !!worktree && fileSays(join(worktree, 'live.txt'), 'hi');
    });
    t.out(`  saw: ${asked}`);
  }),
  step('codex', 'Codex in Ask on your login: one tiny prompt that needs your approval (a write outside its folder), approved with y', 'Codex asking to write outside its worktree (1. Yes … (y)), AI Term\'s card saying it asks, then the file written', async t => {
    const outside = join(t.world.root, 'c.txt');
    await t.home.command('/model'); await t.ai.waitFor('Select model'); await t.ai.type('codex', false); await sleep(300); t.ai.write(KEY.enter);
    await t.ai.waitFor(/· codex · own login/, 10_000, 'codex · own login on the bottom line');
    const asked = await cliTurn(t, 'codex', 'Codex', `Write the single word hi to the file ${outside} with one printf command (it is outside your folder, so ask me first). Nothing else.`, outside, () => fileSays(outside, 'hi'));
    t.out(`  saw: ${asked}`);
  }),
  step('key', 'a keyed AI Term agent turn with its cost line (you add the key; the suite removes it at the end)', 'the turn line ending in its cost, like "· turn · … · $0.0012"', async t => {
    await t.home.command('/login'); await t.ai.waitFor('Connect a provider');
    await handOff(t, 'Add one API key of yours in the login popup: pick Anthropic or OpenAI, paste the key, ⏎. It goes to your Keychain only (service ai-term); the suite removes it when it ends.', async () => (await t.ai.text()).includes('✓ saved to the OS keychain'));
    await t.home.close('Login');
    const connection = await connect(t.world);
    let provider: string;
    try { provider = ((await connection.request({ kind: 'keys.list' })).keys ?? [])[0]?.provider ?? ''; } finally { connection.close(); }
    const model = t.options.keyModel ?? KEY_MODEL[provider];
    if (!model) await fail(t, `no key was added (or it's a ${provider || 'different'} key): use Anthropic or OpenAI, or pass --key-model <model id>`);
    await t.home.command('/model'); await t.ai.waitFor('Select model'); await t.ai.type(model ?? '', false); await sleep(300); t.ai.write(KEY.enter);
    await t.ai.waitFor(new RegExp(`${model} · ai term · key ····`), 10_000, `${model} · ai term · key on the bottom line`);
    await t.home.command('Reply with the single word ok. Nothing else.'); await t.ai.waitFor('Start a new agent'); t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
    await t.home.waitCard('AI Term'); await t.home.attach('AI Term');
    const screen = await t.ai.waitFor(/· turn · .*\$\d+\.\d{4}/, 120_000, 'the turn line with its cost');
    t.out(`  saw: ${screen.split('\n').find(line => /· turn · /.test(line))?.trim() ?? ''}`);
    if (/price unknown/.test(screen)) await fail(t, `${model} has no price, so the cost line can't be checked`);
    t.ai.write(KEY.ctrlE); await t.home.home();
  }),
  step('issue', '/issue with your gh login: the popup names the GitHub issue gh read (nothing starts; Esc)', '"issue <owner/repo>#<n>" in the Add-on popup', async t => {
    if (!t.github) await fail(t, `${t.options.github} has no GitHub origin: pass --github <a folder whose origin is on GitHub>`);
    await t.home.command('/cd'); await t.ai.waitFor('Select folder'); await t.ai.type(t.github ?? '', false); await sleep(100); t.ai.write(KEY.enter); await t.ai.waitGone('Select folder');
    await t.home.command(`/issue ${t.options.issue}`);
    const text = await t.ai.waitFor(new RegExp(`issue [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#${t.options.issue}\\b`), 60_000, `issue <owner/repo>#${t.options.issue} (if gh couldn't read it, pass --issue <a number that exists>)`);
    t.out(`  saw: ${text.split('\n').find(line => /issue \S+#/.test(line))?.replace(/[│╭╰]/g, '').trim() ?? ''}`);
    await t.home.close('Add-on');
  }),
  step('prreview', '/pr-review with your gh login: the popup names the PR, y runs the read-only review on Claude Code', '"PR <owner/repo>#<n>", then the review\'s summary with "c copies"', async t => {
    await t.home.command(`/pr-review ${t.options.pr}`);
    await t.ai.waitFor(new RegExp(`PR [A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+#${t.options.pr}\\b`), 60_000, `PR <owner/repo>#${t.options.pr} (if gh couldn't read it, pass --pr <a number that exists>)`);
    await t.ai.waitFor(/claude-code · /, 5000, 'Claude Code as the reviewer'); t.ai.write('y');
    await t.ai.waitFor(/c copies/, 10 * 60_000, 'the review (c copies it)');
    t.out(`  saw: ${(await t.ai.text()).split('\n').find(line => /finding|no findings|summary/i.test(line))?.replace(/[│╭╰]/g, '').trim() ?? 'the review'}`);
    await t.home.close('Add-on');
  }),
];

// A temporary clone of your GitHub checkout whose origin is the same GitHub URL, so gh reads the same repository and
// nothing happens in your own checkout.
async function githubClone(world: World, source: string): Promise<string | null> {
  let url: string;
  try { url = await git(source, 'remote', 'get-url', '--', 'origin'); } catch (error) { if (error instanceof Error) return null; throw error; }
  if (!/^(?:https:\/\/github\.com\/|git@github\.com:)[\w.-]+\/[\w.-]+?(?:\.git)?$/.test(url)) return null;
  const clone = join(world.root, 'repos', 'github');
  await mkdir(join(world.root, 'repos'), { recursive: true });
  await run('/usr/bin/git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--', source, clone]);
  await git(clone, 'remote', 'set-url', '--', 'origin', url); await git(clone, 'checkout', '--quiet');
  return clone;
}
// The keys this run added, by provider:id, as the Keychain names them (read from the run's own settings file).
async function keyAccounts(world: World): Promise<string[]> {
  const raw = await textOf(join(world.aiHome, 'settings.json'));
  const keys = (raw ? (JSON.parse(raw) as { keys?: unknown }).keys : undefined) ?? [];
  return Array.isArray(keys) ? keys.flatMap(k => k && typeof k === 'object' && 'id' in k && 'provider' in k ? [`${String(k.provider)}:${String(k.id)}`] : []) : [];
}

export async function tier2(out: (line: string) => void, options: Tier2Options, cleanup: Cleanup): Promise<boolean> {
  const world = await makeWorld({ realHome: true });
  // Run newest first: your key is removed while the daemon still runs, then the world goes (unless the key is still in
  // your Keychain: then the world, which holds its name, stays for you).
  let keep = false;
  cleanup.add('the temporary world and its daemon', async () => { if (keep) { out(`  kept ${world.root} (its settings.json names the key)`); return; } const notes = await endWorld(world); if (notes.length) throw new Error(notes.join('; ')); });
  cleanup.add('your key', async () => {
    if (await removeRunKeys(() => connectOrStart(world), out)) return;
    keep = true; for (const account of await keyAccounts(world)) out(`  in Keychain Access: service ai-term, account ${account}`);
  });
  const input = new Input(); input.start(); cleanup.add('your terminal', async () => { input.stop(); });
  await mkdir(world.aiHome, { recursive: true, mode: 0o700 });
  await writeFile(join(world.aiHome, 'settings.json'), JSON.stringify({ theme: 'graphite', notifications: false }), { mode: 0o600 });
  const repo = await makeRepo(world, 'tier2'), github = await githubClone(world, options.github);
  const ai = startAi(world, repo);
  cleanup.add('ai', () => ai.close());
  const t: Tier2 = { world, repo, ai, home: new Home(ai), out, options, github, input };
  const report = await runChecks(`Tier 2 · your logins · ${TIER2.length} checks · AI Term folder ${world.aiHome} (temporary)`, TIER2, t, out);
  out(report.failed === null ? `Tier 2 passed: ${report.passed} checks in ${report.seconds} s` : `Tier 2 stopped at "${report.failed}" after ${report.passed} passed (${report.seconds} s)`);
  return report.failed === null;
}

import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, readlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageInfo from '../../package.json' with { type: 'json' };
import { Home } from './home.js';
import type { Check } from './runner.js';
import { KEY, LiveFailure, sleep, type Screen } from './screen.js';
import { STUB_MODEL, startStubOllama, type StubOllama } from './stub-ollama.js';
import { aiCommand, FAKE_KNOWN_HOSTS, git, makeRepo, makeWorld, startAi, type World } from './world.js';

// Tier 1: no login, no key, no phone. Everything runs in the throwaway world, against the stub Ollama on 127.0.0.1.
export interface Tier1 { world: World; stub: StubOllama; repo: string; ai: Screen; home: Home }
// A tiny server for /dev: it answers on the port AI Term gives it, on 127.0.0.1 only.
const SERVER = "require('node:http').createServer((q, s) => s.end('LIVE-DEV-OK')).listen(Number(process.env.PORT), '127.0.0.1');\n";
// Fake secrets in the daemon's own environment (never real keys, never sk- shaped): an agent's command must see none.
export const PLANTED_SECRETS: Record<string, string> = { OPENAI_API_KEY: 'LIVESECRET-openai', ANTHROPIC_API_KEY: 'LIVESECRET-anthropic', AITERM_LIVE_TOKEN: 'LIVESECRET-aiterm', GITHUB_TOKEN: 'LIVESECRET-github' };

export async function setUpTier1(): Promise<Tier1> {
  const world = await makeWorld();
  Object.assign(world.env, PLANTED_SECRETS);
  const stub = await startStubOllama();
  const repo = await makeRepo(world, 'app', { 'README.md': '# app\n', 'server.js': SERVER });
  // Notifications off before the daemon first starts: a banner must never pop up on your screen during a run.
  await mkdir(world.aiHome, { recursive: true, mode: 0o700 });
  await writeFile(join(world.aiHome, 'settings.json'), JSON.stringify({ theme: 'graphite', notifications: false }), { mode: 0o600 });
  const ai = startAi(world, repo);
  return { world, stub, repo, ai, home: new Home(ai) };
}

const step = (id: string, name: string, look: string, run: (t: Tier1) => Promise<void>): Check<Tier1> => ({ id, name, look, run });
const fail = async (t: Tier1, message: string): Promise<never> => { throw new LiveFailure(message, await t.ai.text()); };

export const TIER1: readonly Check<Tier1>[] = [
  step('start', 'start: ai opens its homepage and, with nothing connected, the login popup', 'the homepage with "Connect a provider" over it; Esc closes it', async t => {
    await t.ai.waitFor('Connect a provider', 20_000);
    await t.home.home();
    t.ai.write(KEY.esc); await t.ai.waitGone('Connect a provider');
  }),
  step('version', 'the homepage shows the version you run', `"v${packageInfo.version}" in the This Mac panel`, async t => {
    await t.ai.waitFor(`v${packageInfo.version}`, 5000, `v${packageInfo.version} in the This Mac panel`);
  }),
  step('ollama', 'login: Ollama on this Mac is added through the popup, no key', '"✓ saved · Ollama needs no key" and the stub model ready', async t => {
    await t.home.command('/login'); await t.ai.waitFor('Connect a provider');
    for (let i = 0; i < 9; i++) { t.ai.write(KEY.down); await sleep(40); }
    await t.ai.waitFor('› Ollama'); t.ai.write(KEY.enter);
    await t.ai.waitFor('Add Ollama · this Mac, no key'); t.ai.write(KEY.enter);
    await t.ai.waitFor('› endpoint: http://127.0.0.1:11434');
    for (let i = 0; i < 'http://127.0.0.1:11434'.length; i++) t.ai.write(KEY.backspace);
    t.ai.write(t.stub.endpoint); await t.ai.waitFor(`› endpoint: ${t.stub.endpoint}`); t.ai.write(KEY.enter);
    await t.ai.waitFor('✓ saved · Ollama needs no key'); await t.ai.waitFor(`${STUB_MODEL}: ready`);
    t.ai.write(KEY.esc); await sleep(80); t.ai.write(KEY.esc); await t.ai.waitGone('Ollama needs no key'); await t.home.home();
  }),
  step('settings', '/settings: notifications off, then queue and dev servers switched on (b, y)', '"notifications: off (n)", "queue: on", "dev servers: on"', async t => {
    await t.home.command('/settings'); await t.ai.waitFor('notifications: off (n)');
    t.ai.write('b'); await t.ai.waitFor('queue: on');
    t.ai.write('y'); await t.ai.waitFor('dev servers: on');
    t.ai.write(KEY.esc); await t.ai.waitGone('dev servers: on'); await t.home.home();
  }),
  step('shell', 'a shell agent: /shell, ⏎ opens it full screen, Ctrl+E comes home with its text in the preview', 'LIVE_SHELL_OK inside the shell, then in the preview', async t => {
    await t.home.command('/shell'); await t.home.waitCard(/shell/);
    await t.home.select('shell'); t.ai.write(KEY.enter);
    await t.ai.waitGone(/^ AI Term_/m, 15_000, 'the homepage');
    await sleep(500); await t.ai.type("printf 'LIVE_%s\\n' SHELL_OK"); await t.ai.waitFor('LIVE_SHELL_OK');
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.ai.waitFor('LIVE_SHELL_OK', 5000, 'the shell\'s text in the preview');
  }),
  step('resize', 'resize: a smaller window drops the This Mac panel, the full size brings it back', '"This Mac" gone at 99×29, back at 120×40', async t => {
    t.ai.resize(99, 29); await t.ai.waitGone('This Mac');
    t.ai.resize(120, 40); await t.ai.waitFor('This Mac');
  }),
  step('paste', 'multiline paste: three pasted lines become one token and the start box\'s first message', '"[pasted · 3 lines]" in the command bar and the start box; Esc starts nothing', async t => {
    await t.home.emptyBar();
    t.ai.paste('LIVE paste one\nLIVE paste two\nLIVE paste three'); await t.ai.waitFor('[pasted · 3 lines]');
    t.ai.write(KEY.enter); await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('[pasted · 3 lines] LIVE paste one');
    // Esc closes the box and gives the text back to the command bar; a second Esc clears it.
    t.ai.write(KEY.esc); await t.ai.waitGone('Start a new agent'); await t.ai.waitFor('│ › [pasted · 3 lines]');
    await t.home.emptyBar();
    if ((await t.home.cards()).includes('AI Term')) await fail(t, 'Esc in the start box started an agent');
  }),
  step('model', '/model picks the stub Ollama model for AI Term\'s agent', `the bottom line names ${STUB_MODEL} and ai term`, async t => {
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA');
    await t.ai.type(STUB_MODEL, false); await sleep(200); t.ai.write(KEY.enter);
    await t.ai.waitFor(new RegExp(`${STUB_MODEL} · ai term`), 10_000, `${STUB_MODEL} · ai term on the bottom line`);
  }),
  step('agent', 'AI Term\'s agent in Ask: its own worktree and branch, a permission prompt, /send refused while it asks, y inside, the cost line', '"new worktree · ai/ai-term", "● allow bash", "is asking for permission", "✓ allowed", "$0.0000"', async t => {
    await t.home.command('LIVE run: printf LIVE_ASK_OK > made.txt');
    await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('new worktree · ai/ai-term from'); await t.ai.waitFor(`${STUB_MODEL} · ai term · local · no key`);
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
    await t.home.waitCard('AI Term'); await t.home.waitCard(/● waiting/, 30_000, 'AI Term waiting for you');
    await t.home.command('/send AI Term hello'); await t.ai.waitFor('AI Term is asking for permission, go inside to answer');
    await t.home.select('AI Term'); await t.home.emptyBar(); t.ai.write(KEY.enter);
    await t.ai.waitFor('allow bash'); await t.ai.waitFor('printf LIVE_ASK_OK > made.txt'); await t.ai.waitFor('y allows · n denies');
    t.ai.write('y'); await t.ai.waitFor('✓ allowed'); await t.ai.waitFor('LIVE-STUB: the command finished.'); await t.ai.waitFor('$0.0000', 15_000, 'the turn\'s cost line ($0.0000)');
    t.ai.write(KEY.ctrlE); await t.home.home();
    const worktree = await worktreeOf(t, 'ai/ai-term');
    if ((await readFile(join(worktree, 'made.txt'), 'utf8').catch(() => '')) !== 'LIVE_ASK_OK') await fail(t, `made.txt isn't in the agent's worktree (${worktree})`);
    if (existsSync(join(t.repo, 'made.txt'))) await fail(t, 'made.txt landed in your checkout instead of the worktree');
  }),
  step('send', '/send to an idle agent: one line, then two pasted lines', '"✓ sent to AI Term", then "✓ sent to AI Term · 2 lines"; the agent got both', async t => {
    await t.home.waitCard(/✓ done/, 20_000, 'AI Term done');
    await t.home.command('/send AI Term LIVE hello idle'); await t.ai.waitFor('✓ sent to AI Term');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE hello idle')), 'the agent receiving "LIVE hello idle"');
    await t.home.command('/send AI Term ', false); t.ai.paste('LIVE line one\nLIVE line two'); await sleep(150); t.ai.write(KEY.enter);
    await t.ai.waitFor('✓ sent to AI Term · 2 lines');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE line one') && m.includes('LIVE line two')), 'the agent receiving both pasted lines as one message');
    // Renamed, so the next AI Term agent can be told apart: r, a new name, ⏎.
    await t.home.waitCard(/✓ done/, 20_000, 'AI Term done again'); await t.home.select('AI Term'); await t.home.emptyBar();
    t.ai.write('r'); await t.ai.waitFor('rename: type a name'); t.ai.write(KEY.ctrlU); await t.ai.type('builder'); await t.home.waitCard('builder');
  }),
  step('trust', '/send to an agent still at its trust prompt is refused (a stand-in Claude Code that never reports in)', '"Claude Code may be asking to trust its folder · go inside first"', async t => {
    await writeFile(join(t.world.bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA'); await t.ai.type('claude', false); await sleep(200);
    await t.ai.waitFor(/› .*[Cc]laude/, 5000, 'a Claude Code row in /model'); t.ai.write(KEY.enter);
    await t.ai.waitFor(/· claude code ·/, 10_000, 'claude code on the bottom line');
    await t.home.command('LIVE trust me'); await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('new worktree · ai/claude-code');
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent'); await t.home.waitCard('Claude Code');
    await t.home.command('/send Claude Code hello'); await t.ai.waitFor('Claude Code may be asking to trust its folder · go inside first');
  }),
  step('dontask', 'the agent bash sandbox (D57): a Don\'t ask agent can\'t read AI Term\'s settings, and its commands see no secrets', '"! don\'t ask" on its card; the command\'s report says "blocked by sandbox: ~/.ai-term/settings.json"; env shows none of the planted secrets', async t => {
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA'); await t.ai.type(STUB_MODEL, false); await sleep(200); t.ai.write(KEY.enter);
    await t.ai.waitFor(new RegExp(`${STUB_MODEL} · ai term`), 10_000, `${STUB_MODEL} · ai term on the bottom line`);
    await t.home.command("/mode don't ask"); await t.ai.waitFor(/don't ask/, 5000, "don't ask on the bottom line");
    const before = t.stub.toolResults.length;
    await t.home.command('LIVE run: cat ~/.ai-term/settings.json; env | sort');
    await t.ai.waitFor('Start a new agent'); await t.ai.waitFor("! don't ask"); await t.ai.waitFor('new worktree · ai/ai-term-2');
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
    await until(t, () => t.stub.toolResults.length > before, 'the command\'s report reaching the model', 30_000);
    const report = t.stub.toolResults.at(-1) ?? '';
    if (!report.includes('blocked by sandbox: ~/.ai-term/settings.json')) await fail(t, 'the agent\'s command read ~/.ai-term/settings.json, or its report doesn\'t say the sandbox blocked it');
    if (report.includes('"theme"')) await fail(t, 'the settings file\'s contents reached the agent');
    const leaked = Object.entries(PLANTED_SECRETS).filter(([name, secret]) => report.includes(name) || report.includes(secret)).map(([name]) => name);
    if (leaked.length) await fail(t, `the agent's env has ${leaked.join(', ')}`);
    if (!/^HOME=/m.test(report) || !/^PATH=/m.test(report)) await fail(t, 'env | sort printed no environment at all, so the secrets check proves nothing');
    await t.home.waitCard(/! ✓ done/, 20_000, "the Don't ask agent done");
    await t.home.command('/mode ask'); await t.ai.waitFor(/· ask ·/, 5000, 'ask on the bottom line');
  }),
  step('split', 'splits: Space marks two, v opens them side by side, Ctrl+\\ moves focus, /exit in one pane, Ctrl+\\ closes it', '"2 marked · v opens them side by side", two pane headers, the underlined (focused) header moving, "exited · exit 0"', async t => {
    await t.home.select('builder'); await t.home.emptyBar(); t.ai.write(' '); await t.ai.waitFor('1 marked · Space marks one more');
    await t.home.select('AI Term'); t.ai.write(' '); await t.ai.waitFor('2 marked · v opens them side by side');
    t.ai.write('v'); await t.ai.waitFor('^\\ next pane'); await t.ai.waitFor('each pane is its own agent in its own worktree');
    const focus = async () => (await t.ai.underlined()).join(' | ');
    const first = await focus();
    t.ai.write(KEY.ctrlBackslash); await sleep(500);
    const second = await focus();
    if (first === second || !/builder|AI Term/.test(first) || !/builder|AI Term/.test(second)) await fail(t, `Ctrl+\\ didn't move the focus (underlined header before: "${first}", after: "${second}")`);
    // /exit goes to the D57 agent (its worktree is clean, so x deletes it later without a typed name).
    if (!second.includes('AI Term')) { t.ai.write(KEY.ctrlBackslash); await sleep(500); }
    if (!(await focus()).includes('AI Term')) await fail(t, 'couldn\'t focus the AI Term pane');
    await sleep(300); await t.ai.type('/exit'); await t.ai.waitFor(/exited · exit 0/, 15_000, 'the pane saying exited · exit 0');
    await t.ai.waitFor('^\\ closes');
    t.ai.write(KEY.ctrlBackslash); await t.ai.waitGone('^\\ next pane', 10_000, 'the split');
    await t.ai.waitFor('LIVE-STUB', 10_000, 'builder full screen, the one pane left');
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.home.waitCard(/exited/, 10_000, 'AI Term exited');
  }),
  step('testbox', 'the test sandbox (D56): /test-cmd, /test with l switching 127.0.0.1, a test that reads the planted ~/.ssh file is blocked', '"no reads of ~/.ssh", "127.0.0.1: on for this project", and the card "✗ blocked by sandbox: ~/.ssh/known_hosts"', async t => {
    await t.home.command('/test-cmd sh -c "cat ~/.ssh/known_hosts"'); await t.ai.waitFor("✓ test command for"); await t.ai.waitFor("sh -c 'cat ~/.ssh/");
    await t.home.select('builder'); await t.home.command('/test');
    await t.ai.waitFor('Run tests for builder'); await t.ai.waitFor('no reads of ~/.ssh'); await t.ai.waitFor('127.0.0.1: off · l allows it');
    t.ai.write('l'); await t.ai.waitFor('127.0.0.1: on for this project · l turns it off');
    t.ai.write('l'); await t.ai.waitFor('127.0.0.1: off · l allows it');
    t.ai.write('y'); await t.ai.waitFor('◐ testing builder');
    // Cards use the full width with the preview hidden (p), so the whole line shows.
    await t.home.emptyBar(); t.ai.write('p'); await sleep(200);
    try { await t.home.waitCard('✗ blocked by sandbox: ~/.ssh/known_hosts', 60_000); } finally { await t.home.emptyBar(); t.ai.write('p'); await sleep(200); }
    if ((await t.ai.raw()).includes(FAKE_KNOWN_HOSTS.trim())) await fail(t, 'the planted known_hosts reached the screen');
    await t.home.command('/test-cmd none'); await t.ai.waitFor(/test command .*cleared|no test command/i, 5000, 'the test command cleared');
  }),
  step('commit', '/commit y commits in the agent\'s worktree only', '"y commits it in the agent\'s worktree, with your name", then "✓ committed <sha> in the agent\'s worktree"; your main branch unchanged', async t => {
    const main = await git(t.repo, 'rev-parse', 'main'), worktree = await worktreeOf(t, 'ai/ai-term');
    t.stub.addon({ result: { kind: 'commit', subject: 'LIVE: add made.txt', body: 'Written by the live suite.' } });
    await t.home.command('/commit builder'); await stubTarget(t);
    t.ai.write('y'); await t.ai.waitFor('Running in Ask mode');
    await t.ai.waitFor('y commits it in the agent\'s worktree, with your name', 60_000);
    t.ai.write('y'); await t.ai.waitFor(/✓ committed [0-9a-f]{7,} in the agent's worktree/, 15_000, '✓ committed <sha> in the agent\'s worktree');
    await t.home.close('Add-on'); await t.home.home();
    if (await git(worktree, 'log', '-1', '--format=%s%n%an') !== 'LIVE: add made.txt\nLive Suite') await fail(t, 'the worktree\'s last commit isn\'t the one /commit made, with your name');
    if (await git(t.repo, 'rev-parse', 'main') !== main) await fail(t, 'your main branch moved');
    if (await git(t.repo, 'status', '--porcelain') !== '') await fail(t, 'your checkout changed');
  }),
  step('deck', 'o and s on a /deck result: s saves to Downloads (the suite\'s own), o refuses an executable file before anything opens', '"s saves a copy to Downloads", "✓ saved a copy to", then "That file is executable"', async t => {
    t.stub.addon({ bash: "mkdir -p out/deck && printf '<!doctype html><title>LIVE deck</title><h1>LIVE deck</h1>' > out/deck/live.html && printf '<p>run me</p>' > out/deck/run.html && chmod +x out/deck/run.html",
      result: { kind: 'deck', summary: 'LIVE deck for the live suite', files: ['out/deck/live.html', 'out/deck/run.html'], todo: [] } });
    await t.home.command('/deck the live suite'); await stubTarget(t);
    t.ai.write('y'); await t.ai.waitFor('Running in Ask mode'); await t.home.close('Add-on');
    // The add-on agent asks before its command: you approve it inside, as with any Ask agent.
    await t.home.waitCard(/● waiting/, 30_000, '/deck waiting for you'); await t.home.select('/deck'); await t.home.emptyBar(); t.ai.write(KEY.enter);
    await t.ai.waitFor('allow bash'); t.ai.write('y'); await t.ai.waitFor('✓ allowed'); t.ai.write(KEY.ctrlE); await t.home.home();
    await t.home.waitCard(/✓ done/, 30_000);
    await t.home.command('/deck'); await t.ai.waitFor('LIVE deck for the live suite', 20_000); await t.ai.waitFor('› out/deck/live.html'); await t.ai.waitFor('s saves a copy to Downloads');
    t.ai.write('s'); await t.ai.waitFor('✓ saved a copy to');
    const saved = await readFile(join(t.world.downloads, 'live.html'), 'utf8').catch(() => '');
    if (!saved.includes('LIVE deck') || !/Content-Security-Policy/i.test(saved)) await fail(t, `Downloads (the suite's ${t.world.downloads}) has no live.html with its no-script policy`);
    t.ai.write(KEY.down); await t.ai.waitFor('› out/deck/run.html');
    t.ai.write('o'); await t.ai.waitFor("That file is executable; AI Term doesn't open or save it");
    if (existsSync(join(t.world.aiHome, 'opened'))) await fail(t, 'o made a copy to open of an executable file');
    await t.home.close('Add-on');
  }),
  step('dev', '/dev on a tiny local server: /dev-cmd, y starts it on its own 127.0.0.1 port, x stops it', '"▶ dev server for builder · http://127.0.0.1:<port>", the page answering LIVE-DEV-OK, then "stopped"', async t => {
    await t.home.command('/dev-cmd node server.js'); await t.ai.waitFor('✓ dev command for');
    await t.home.select('builder'); await t.home.command('/dev');
    await t.ai.waitFor('Dev server for builder'); await t.ai.waitFor('listens on 127.0.0.1 only'); await t.ai.waitFor('y starts it');
    t.ai.write('y');
    const shown = await t.ai.waitFor(/▶ dev server for builder · http:\/\/127\.0\.0\.1:(\d+)/, 20_000, '▶ dev server for builder · http://127.0.0.1:<port>');
    const port = Number(shown.match(/▶ dev server for builder · http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    await until(t, async () => (await localPage(port)) === 'LIVE-DEV-OK', `http://127.0.0.1:${port} answering LIVE-DEV-OK`, 20_000);
    await t.home.command('/dev'); await t.ai.waitFor('▶ running'); t.ai.write('x'); await t.ai.waitFor('dev server for builder stopped');
    await until(t, async () => (await localPage(port)) === null, `nothing listening on ${port} any more`, 15_000);
    await t.home.close('Dev server');
  }),
  step('brain', '/brain: the free local map of the repository', '"local map only · free", then "✓ brain for"', async t => {
    await t.home.command('/brain'); await t.ai.waitFor('local map only · free'); await t.ai.waitFor('first map');
    t.ai.write(KEY.enter); await t.ai.waitFor(/✓ brain for .*files/, 30_000, '✓ brain for <repo>: N files');
    await t.home.command('/brain show'); await t.ai.waitFor(/Brain · .* old/, 10_000, 'the Brain popup with its age'); await t.home.close('Brain');
  }),
  step('queue', '/queue: an agent queued "at HH:MM" starts by itself at that minute', '"✓ queued · /queue lists it", then "▶ started" in /queue and a new AI Term card', async t => {
    const at = nextMinute();
    await t.home.command('/queue add'); await t.ai.waitFor('Queue a new agent');
    for (let i = 0; i < 4; i++) { t.ai.write(KEY.down); await sleep(60); }
    await t.ai.waitFor('› first message'); await t.ai.type('LIVE queued hello', false); await sleep(100); t.ai.write(KEY.enter);
    await t.ai.waitFor('When does it start?'); await t.ai.type(`at ${at}`);
    await t.ai.waitFor('Its limit:'); await t.ai.type('5 turns $1'); await t.ai.waitFor('✓ queued · /queue lists it');
    await t.home.command('/queue'); await t.ai.waitFor(`at ${at}`); await t.home.close('Queue');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE queued hello')), `the queued agent starting at ${at} and sending its first message`, 140_000);
    await t.home.command('/queue'); await t.ai.waitFor('▶ started', 10_000); await t.home.close('Queue');
  }),
  step('find', '/find searches every agent\'s screen', '"Find “LIVE_SHELL_OK”" listing the shell', async t => {
    await t.home.command('/find LIVE_SHELL_OK'); await t.ai.waitFor('Find “LIVE_SHELL_OK”'); await t.ai.waitFor(/shell .*LIVE_SHELL_OK|LIVE_SHELL_OK/, 5000);
    t.ai.write(KEY.enter); await sleep(300); await t.home.close('Find');
    if (await t.home.selected() !== 'shell') await fail(t, '⏎ on the shell\'s match didn\'t show the shell in the preview');
  }),
  step('opencode', '/open code opens the selected agent\'s worktree in VS Code (a stand-in code command; /open itself would open Finder, so it isn\'t pressed)', '"opened … in VS Code"; code got -- and the worktree', async t => {
    const log = join(t.world.root, 'code-args.txt');
    await writeFile(join(t.world.bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
    await t.home.select('builder'); await t.home.command('/open code'); await t.ai.waitFor('in VS Code');
    const worktree = await worktreeOf(t, 'ai/ai-term');
    await until(t, async () => (await readFile(log, 'utf8').catch(() => '')) === `--\n${worktree}\n`, `code being given -- and ${worktree}`);
  }),
  step('retry', '/retry restarts a finished agent fresh in its worktree', '"✓ restarted AI Term in its worktree · its first message isn\'t resent"', async t => {
    await t.home.select('AI Term'); await t.home.command('/retry'); await t.ai.waitFor("✓ restarted AI Term in its worktree · its first message isn't resent");
    await t.home.waitCard(/AI Term +! (◐|✓|●)/, 20_000, 'AI Term running again');
  }),
  step('bisect', '/bisect from Part A on a Node repository whose test runner writes a cache inside node_modules', '"dependencies: node_modules cloned from your checkout", the planted commit as the first bad one; your node_modules unchanged', async t => {
    const { repo, bad, digest: before } = await bisectRepo(t.world);
    await t.home.command('/cd'); await t.ai.waitFor('Select folder'); await t.ai.type(repo, false); await sleep(100); t.ai.write(KEY.enter); await t.ai.waitGone('Select folder');
    await t.home.command('/bisect npm test'); await t.ai.waitFor('test: npm test'); await t.ai.waitFor('dependencies: node_modules cloned from your checkout'); await t.ai.waitFor('✓ test sandbox');
    t.ai.write('y'); await t.ai.waitFor('planted: break the state', 120_000); await t.ai.waitFor(bad.slice(0, 7));
    await t.home.close('Add-on');
    if (await treeDigest(join(repo, 'node_modules')) !== before) await fail(t, 'your node_modules changed during the bisect');
    await t.home.command('/cd'); await t.ai.waitFor('Select folder'); await t.ai.type(t.repo, false); await sleep(100); t.ai.write(KEY.enter); await t.ai.waitGone('Select folder');
  }),
  step('worktrees', 'x: a clean exited agent asks k/d (d deletes), one with work needs its branch name typed, k keeps', '"✓ nothing would be lost", "✓ deleted worktree and branch ai/ai-term-2", "! would be lost", "type ai/ai-term exactly to delete", "worktree kept"', async t => {
    // The clean one (D57's agent, back at its prompt after /retry): stopped, then x and d.
    await stop(t, 'AI Term');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/ai-term-2'); await t.ai.waitFor('✓ nothing would be lost'); await t.ai.waitFor('k keep · d delete');
    t.ai.write('d'); await t.ai.waitFor('✓ deleted worktree and branch ai/ai-term-2');
    // builder has a commit not in main and untracked work: only its exact branch name deletes it.
    await stop(t, 'builder');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/ai-term'); await t.ai.waitFor('! would be lost'); await t.ai.waitFor('type ai/ai-term and ⏎ to delete');
    await t.ai.type('ai/ai-term-2'); await t.ai.waitFor('type ai/ai-term exactly to delete');
    for (let i = 0; i < 'ai/ai-term-2'.length; i++) t.ai.write(KEY.backspace);
    await t.ai.type('ai/ai-term'); await t.ai.waitFor('✓ deleted worktree and branch ai/ai-term');
    // The stand-in Claude Code's clean worktree is kept with k.
    await stop(t, 'Claude Code');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/claude-code'); await t.ai.waitFor('k keep · d delete'); t.ai.write('k'); await t.ai.waitFor('worktree kept:');
    const branches = await git(t.repo, 'branch', '--format=%(refname:short)');
    if (/^ai\/ai-term(-2)?$/m.test(branches)) await fail(t, `a deleted agent's branch is still there: ${branches.replace(/\n/g, ' ')}`);
    if (!/^ai\/claude-code$/m.test(branches)) await fail(t, 'k didn\'t keep ai/claude-code');
  }),
  step('doctor', 'ai doctor checks this world: the daemon, the folder modes, the CLIs it finds (only the stand-in Claude Code), the sandbox', '"Daemon: running", "mode 0700", the stand-in claude, "codex: not found", "Sandbox: sandbox-exec"', async t => {
    const { code, stdout } = await aiCommand(t.world, ['doctor'], t.repo);
    // With the world's own home there's no login keychain to reach, so "Credential store" says unavailable here.
    for (const line of [/^Daemon: running/m, /: mode 0700$/m, existsSync(join(t.world.bin, 'claude')) ? new RegExp(`^claude: ${t.world.bin}/claude; version 2\\.1\\.302$`, 'm') : /^claude: not found/m, /^codex: not found/m, /^gh: not found/m, /^Sandbox: sandbox-exec/m])
      if (!line.test(stdout)) throw new LiveFailure(`ai doctor (exit ${code}) printed no line matching ${String(line)}`, stdout);
  }),
  step('exit', '/exit leaves the homepage; the daemon keeps running the agents', 'ai exits with 0; the daemon still answers', async t => {
    await t.home.command('/exit');
    const code = await Promise.race([t.ai.exited, sleep(10_000).then(() => -1)]);
    if (code !== 0) await fail(t, `ai exited with ${code}`);
    const { stdout } = await aiCommand(t.world, ['doctor'], t.repo);
    if (!/^Daemon: running/m.test(stdout)) throw new LiveFailure('the daemon stopped with the homepage', stdout);
  }),
];
// Stops an agent from the homepage: select it, s, y; then it's exited and selected.
async function stop(t: Tier1, title: string): Promise<void> {
  await t.home.select(title); await t.home.emptyBar();
  const card = await t.home.cards();
  if (!new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} +(! )?■ exited`).test(card)) { t.ai.write('s'); await t.ai.waitFor(`stop ${title}? y/n`); t.ai.write('y'); }
  await t.home.waitCard(new RegExp(`${title} +(! )?■`), 15_000, `${title} exited`);
}
async function localPage(port: number): Promise<string | null> {
  try { const reply = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2000) }); return await reply.text(); } catch { return null; }
}
// The next whole minute with at least 25 s to spare, as HH:MM on this Mac's clock.
function nextMinute(): string {
  const at = new Date(Date.now() + 60_000 + (60 - new Date().getSeconds() < 25 ? 60_000 : 0));
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}
// A Node repository with a planted bad commit (5 of 8) whose test runner, like Vitest, must write a cache inside
// node_modules; node_modules is installed, never committed.
async function bisectRepo(world: World): Promise<{ repo: string; bad: string; digest: string }> {
  const files: Record<string, string> = {
    '.gitignore': 'node_modules/\n', 'package.json': JSON.stringify({ name: 'live-bisect', private: true, scripts: { test: 'node test.js' } }),
    'test.js': ["const fs = require('node:fs');", "fs.mkdirSync('node_modules/.cache/live', { recursive: true }); fs.writeFileSync(`node_modules/.cache/live/${process.pid}.json`, '{}');",
      "process.exit(require('dep')(fs.readFileSync('state.txt', 'utf8').trim()) === '[ok]' ? 0 : 1);", ''].join('\n'), 'state.txt': 'ok\n' };
  const repo = await makeRepo(world, 'bisect', files);
  let bad = '';
  for (let n = 2; n <= 8; n++) {
    await writeFile(join(repo, 'state.txt'), n < 5 ? 'ok\n' : 'broken\n'); await writeFile(join(repo, `file${n}.txt`), `${n}\n`);
    await git(repo, 'add', '--', '.'); await git(repo, 'commit', '-qm', n === 5 ? 'planted: break the state' : `change ${n}`, '--');
    if (n === 5) bad = await git(repo, 'rev-parse', 'HEAD');
  }
  await mkdir(join(repo, 'node_modules', 'dep'), { recursive: true });
  await writeFile(join(repo, 'node_modules', 'dep', 'package.json'), JSON.stringify({ name: 'dep', main: 'index.js' }));
  await writeFile(join(repo, 'node_modules', 'dep', 'index.js'), "module.exports = s => '[' + s + ']';\n");
  return { repo, bad, digest: await treeDigest(join(repo, 'node_modules')) };
}
// Every entry's path, mode, size, link target and bytes, without following links.
async function treeDigest(folder: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    for (const name of (await readdir(dir)).sort()) {
      const path = join(dir, name), info = await lstat(path);
      hash.update(`${path.slice(folder.length)}\0${info.mode}\0${info.size}\0`);
      if (info.isSymbolicLink()) hash.update(await readlink(path)); else if (info.isDirectory()) await walk(path); else hash.update(await readFile(path));
    }
  };
  await walk(folder); return hash.digest('hex');
}
// An add-on popup's engine and key: e until it names AI Term's agent on the stub model (never a CLI or a real key).
async function stubTarget(t: Tier1): Promise<void> {
  await t.ai.waitFor('e engine/key', 15_000);
  for (let i = 0; i < 8; i++) {
    if (new RegExp(`ai-term · ${STUB_MODEL}`).test(await t.ai.text())) return;
    t.ai.write('e'); await sleep(250);
  }
  await fail(t, `e never reached AI Term's agent on ${STUB_MODEL}`);
}
// Waits for something the suite itself sees (the stub's log, a file), with the screen kept for the failure line.
async function until(t: Tier1, test: () => boolean | Promise<boolean>, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await test()) { if (Date.now() > deadline) await fail(t, `never saw ${what} within ${Math.round(timeoutMs / 1000)} s`); await sleep(100); }
}
// A stand-in for Claude Code: it passes AI Term's install and login checks, then shows a trust question and waits,
// never reporting in, as the real CLI does before you answer it. Only the suite's own bin folder holds it.
const FAKE_CLAUDE = `#!/bin/sh
case "$1" in
  --version) echo '2.1.302 (Claude Code)'; exit 0;;
  auth) echo '{"loggedIn":true,"authMethod":"claude.ai"}'; exit 0;;
esac
printf 'LIVE stand-in Claude Code\\n\\nDo you trust the files in this folder?\\n\\n> 1. Yes, proceed\\n  2. No, exit\\n'
exec /bin/sleep 600
`;
// The worktree folder of a branch, from git's own list in the repository.
async function worktreeOf(t: Tier1, branch: string): Promise<string> {
  const list = await git(t.repo, 'worktree', 'list', '--porcelain'), blocks = list.split('\n\n');
  const block = blocks.find(b => b.split('\n').includes(`branch refs/heads/${branch}`));
  const path = block?.split('\n').find(line => line.startsWith('worktree '))?.slice('worktree '.length);
  if (!path) throw new LiveFailure(`git lists no worktree on ${branch}`, list);
  return path;
}

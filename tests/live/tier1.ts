import { existsSync } from 'node:fs';
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageInfo from '../../package.json' with { type: 'json' };
import type { Cleanup } from './cleanup.js';
import { Home } from './home.js';
import type { Check } from './runner.js';
import { KEY, LiveFailure, sleep } from './screen.js';
import { STUB_MODEL, startStubOllama } from './stub-ollama.js';
import { aiCommand, endWorld, FAKE_KNOWN_HOSTS, git, makeRepo, makeWorld, startAi } from './world.js';
import { NO_LINUX_SANDBOX } from '../platform.js';
import { bisectRepo, FAKE_CLAUDE, waitAsk, fail, localPage, nextMinute, plain, rename, stop, stubTarget, textOf, treeDigest, until, waitBottom, worktreeOf, type Tier1 } from './tier1-helpers.js';

// Tier 1: no login, no key, no phone. Everything runs in the throwaway world, against the stub Ollama on 127.0.0.1.
export type { Tier1 } from './tier1-helpers.js';
// A tiny server for /dev: it answers on the port AI Term gives it, on 127.0.0.1 only.
const SERVER = "require('node:http').createServer((q, s) => s.end('LIVE-DEV-OK')).listen(Number(process.env.PORT), '127.0.0.1');\n";
// Fake secrets in the daemon's own environment (never real keys, never sk- shaped): an agent's command must see none.
export const PLANTED_SECRETS: Record<string, string> = { OPENAI_API_KEY: 'LIVESECRET-openai', ANTHROPIC_API_KEY: 'LIVESECRET-anthropic', AITERM_LIVE_TOKEN: 'LIVESECRET-aiterm', GITHUB_TOKEN: 'LIVESECRET-github' };
const KNOWN_HOSTS_TOKEN = FAKE_KNOWN_HOSTS.split(' ')[2]?.trim() ?? 'AAAAFAKEKEY';

// Every resource is handed to the cleanup as soon as it exists, so a failed setup or Ctrl+C removes it too.
// keep: --keep after a failure leaves the world (and its daemon) for a look.
export async function setUpTier1(cleanup: Cleanup, keep: () => boolean = () => false): Promise<Tier1> {
  const world = await makeWorld();
  cleanup.add('the temporary world and its daemon', async () => { if (keep()) return; const notes = await endWorld(world); if (notes.length) throw new Error(notes.join('; ')); });
  Object.assign(world.env, PLANTED_SECRETS);
  Object.freeze(world.env);
  const stub = await startStubOllama();
  cleanup.add('the stub Ollama', () => stub.close());
  const repo = await makeRepo(world, 'app', { 'README.md': '# app\n', 'server.js': SERVER });
  // Notifications off before the daemon first starts: a banner must never pop up on your screen during a run.
  await mkdir(world.aiHome, { recursive: true, mode: 0o700 });
  await writeFile(join(world.aiHome, 'settings.json'), JSON.stringify({ theme: 'graphite', notifications: false }), { mode: 0o600 });
  const ai = startAi(world, repo);
  cleanup.add('ai', () => ai.close());
  return { world, stub, repo, ai, home: new Home(ai) };
}

// What ai doctor says about the sandbox here (B34: Linux has bwrap, or none and why).
const SANDBOX_LINE = process.platform === 'darwin' ? /^Sandbox: sandbox-exec/m : NO_LINUX_SANDBOX ? /^Sandbox: none · don't ask needs/m : /^Sandbox: bwrap/m;
// The key that starts a dev server: y in its sandbox, a capital Y on Linux, where it runs without one.
const DEV_YES = process.platform === 'linux' ? 'Y' : 'y';
const step = (id: string, name: string, look: string, run: (t: Tier1) => Promise<void>): Check<Tier1> => ({ id, name, look, run });
// A test card line, with the preview hidden (p) so the card has the full width for the whole line.
async function testCard(t: Tier1, title: string, what: string): Promise<void> {
  await t.home.emptyBar(); t.ai.write('p'); await sleep(200);
  try { await t.home.waitStatus(title, new RegExp(what.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 60_000, what); }
  finally { await t.home.emptyBar(); t.ai.write('p'); await sleep(200); }
}
// /test on the selected agent, its plan shown; l switches 127.0.0.1 first when asked; y runs it.
async function runTest(t: Tier1, title: string, loopback: 'off' | 'on'): Promise<void> {
  await t.home.select(title); await t.home.command('/test'); await t.ai.waitFor(`Run tests for ${title}`);
  const shown = await t.ai.waitFor(/127\.0\.0\.1: (?:off · l allows it|on for this project · l turns it off)/);
  if (shown.includes('127.0.0.1: off') !== (loopback === 'off')) { t.ai.write('l'); await t.ai.waitFor(loopback === 'on' ? '127.0.0.1: on for this project · l turns it off' : '127.0.0.1: off · l allows it'); }
  t.ai.write('y'); await t.ai.waitFor(`◐ testing ${title}`);
}
async function cd(t: Tier1, folder: string): Promise<void> {
  await t.home.command('/cd'); await t.ai.waitFor('Select folder'); await t.ai.type(folder, false); await sleep(100); t.ai.write(KEY.enter); await t.ai.waitGone('Select folder');
}

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
    await t.home.close('Login'); await t.home.home();
  }),
  step('settings', '/settings: notifications off, then queue and dev servers switched on (b, y)', '"notifications: off (n)", "queue: on", "dev servers: on"', async t => {
    await t.home.command('/settings'); await t.ai.waitFor('notifications: off (n)');
    t.ai.write('b'); await t.ai.waitFor('queue: on');
    t.ai.write('y'); await t.ai.waitFor('dev servers: on');
    t.ai.write(KEY.esc); await t.ai.waitGone('dev servers: on'); await t.home.home();
  }),
  step('shell', 'a shell agent: /shell, ⏎ opens it full screen, a resize reaches it, Ctrl+E comes home, ⏎ goes back in', 'LIVE_SHELL_OK inside, "30 100" from stty size, the text in the preview, then LIVE_AGAIN after going back in', async t => {
    await t.home.command('/shell'); await t.home.waitCard(/SH +shell/, 20_000, 'a shell card');
    await t.home.attach('shell'); await sleep(400);
    await t.ai.type("printf 'LIVE_%s\\n' SHELL_OK"); await t.ai.waitFor('LIVE_SHELL_OK');
    t.ai.resize(100, 30); await sleep(300); await t.ai.type('stty size'); await t.ai.waitFor(/^30 100$/m, 10_000, 'stty size saying 30 100');
    t.ai.resize(120, 40); await sleep(300);
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.ai.waitFor('LIVE_SHELL_OK', 5000, 'the shell\'s text in the preview');
    await t.home.attach('shell'); await t.ai.waitFor('LIVE_SHELL_OK', 5000, 'the shell\'s earlier text, drawn again');
    await t.ai.type("printf 'LIVE_%s\\n' AGAIN"); await t.ai.waitFor('LIVE_AGAIN');
    t.ai.write(KEY.ctrlE); await t.home.home();
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
    await t.home.emptyBar(); await sleep(1500);
    if ((await t.home.cards()).includes('AI Term')) await fail(t, 'Esc in the start box started an agent');
  }),
  step('model', '/model picks the stub Ollama model for AI Term\'s agent', `the bottom line names ${STUB_MODEL} and ai term`, async t => {
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA');
    await t.ai.type(STUB_MODEL, false); await sleep(200); t.ai.write(KEY.enter);
    await waitBottom(t, new RegExp(`${STUB_MODEL} · ai term`), `${STUB_MODEL} · ai term`);
  }),
  step('agent', 'AI Term\'s agent in Ask: its own worktree and branch, a permission prompt, /send refused while it asks, y inside, the cost line', '"new worktree · ai/ai-term", "● allow bash", "is asking for permission", "✓ allowed", "· turn · … $0.0000"', async t => {
    await t.home.command('LIVE run: printf LIVE_ASK_OK > made.txt');
    await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('new worktree · ai/ai-term from'); await t.ai.waitFor(`${STUB_MODEL} · ai term · local · no key`);
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
    await t.home.waitStatus('AI Term', /● waiting/, 30_000, 'waiting for you');
    await t.home.command('/send AI Term hello'); await t.ai.waitFor('AI Term is asking for permission, go inside to answer');
    await t.home.attach('AI Term'); await t.ai.waitFor('allow bash'); await t.ai.waitFor('printf LIVE_ASK_OK > made.txt'); await t.ai.waitFor('y allows · n denies');
    t.ai.write('y'); await t.ai.waitFor('✓ allowed'); await t.ai.waitFor('LIVE-STUB: the command finished.');
    await t.ai.waitFor(/· turn · .*\$0\.0000/, 15_000, 'the turn line with its cost ($0.0000)');
    t.ai.write(KEY.ctrlE); await t.home.home();
    if (t.stub.userMessages.some(m => m.trim() === 'hello')) await fail(t, 'the refused /send reached the agent anyway');
    const worktree = await worktreeOf(t.repo, 'ai/ai-term');
    if (await textOf(join(worktree, 'made.txt')) !== 'LIVE_ASK_OK') await fail(t, `made.txt isn't in the agent's worktree (${worktree})`);
    if (existsSync(join(t.repo, 'made.txt'))) await fail(t, 'made.txt landed in your checkout instead of the worktree');
  }),
  step('send', '/send to an idle agent (one line, two pasted lines), a paste inside an agent, an unknown name refused', '"✓ sent to AI Term", "✓ sent to AI Term · 2 lines", both pasted lines in one message, "no agent is named nobody"', async t => {
    await t.home.waitStatus('AI Term', /✓ done/, 20_000, 'done');
    await t.home.command('/send AI Term LIVE hello idle'); await t.ai.waitFor('✓ sent to AI Term');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE hello idle')), 'the agent receiving "LIVE hello idle"');
    await t.home.waitStatus('AI Term', /✓ done/, 20_000, 'done with that message');
    await t.home.command('/send AI Term ', false); t.ai.paste('LIVE line one\nLIVE line two'); await sleep(150); t.ai.write(KEY.enter);
    await t.ai.waitFor('✓ sent to AI Term · 2 lines');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE line one') && m.includes('LIVE line two')), 'the agent receiving both pasted lines as one message');
    await t.home.waitStatus('AI Term', /✓ done/, 20_000, 'done with the pasted lines');
    // Pasted inside the agent: its own prompt takes both lines as one message.
    await t.home.attach('AI Term'); t.ai.paste('LIVE inside one\nLIVE inside two'); await sleep(200); t.ai.write(KEY.enter);
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE inside one') && m.includes('LIVE inside two')), 'the agent receiving the paste made inside it as one message');
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.home.waitStatus('AI Term', /✓ done/, 20_000, 'done with the paste');
    await t.home.command('/send nobody hi'); await t.ai.waitFor('no agent is named nobody');
    // Renamed, so the next AI Term agent can be told apart.
    await rename(t, 'AI Term', 'builder');
  }),
  step('asks', 'AI Term\'s agent in Ask: n denies a command, y approves an edit, Esc interrupts one that runs, Ctrl+K kills one, a read outside its folder is refused, /caps turns pauses it', '"✗ denied", approved.txt written after y, "■ interrupted", "killed: the request and 1 running command", "Path is outside the folder", "cap reached: 2 turns this run"', async t => {
    const toolResults = t.stub.toolResults.length;
    await t.home.command('/send builder LIVE run: echo LIVE_DENY_ME'); await t.home.waitStatus('builder', /● waiting/, 20_000, 'asking for permission');
    await t.home.attach('builder'); await waitAsk(t, 'echo LIVE_DENY_ME');
    t.ai.write('n'); await t.ai.waitFor('✗ denied');
    await until(t, () => t.stub.toolResults.slice(toolResults).some(r => r.includes('The user denied this')), 'the model being told the command was denied');
    // Back at its prompt: the last line on screen is an empty "›".
    const prompt = () => until(t, async () => /^› *$/.test((await t.ai.text()).split('\n').filter(line => line.trim()).at(-1) ?? ''), 'the agent back at its prompt');
    await prompt();
    // y approves an edit: the write waits for it, then the file is there.
    await t.ai.type('LIVE write: approved.txt LIVE_APPROVED_EDIT'); await waitAsk(t, 'approved.txt'); t.ai.write('y');
    await until(t, async () => (await textOf(join(await worktreeOf(t.repo, 'ai/ai-term'), 'approved.txt'))).trim() === 'LIVE_APPROVED_EDIT', 'approved.txt written in builder\'s worktree after y');
    await prompt();
    // Esc while an approved command runs ends the turn.
    await t.ai.type('LIVE run: sleep 30'); await waitAsk(t, 'sleep 30'); t.ai.write('y'); await until(t, async () => (await t.ai.text()).split('\n').filter(l => l.trim()).slice(-3).some(l => l.includes('✓ allowed')), 'sleep 30 allowed'); await sleep(1500);
    t.ai.write(KEY.esc); await t.ai.waitFor('■ interrupted', 10_000);
    // Ctrl+K kills the running command and the request.
    await prompt(); await t.ai.type('LIVE run: sleep 31'); await waitAsk(t, 'sleep 31'); t.ai.write('y'); await sleep(1500);
    t.ai.write(KEY.ctrlK); await t.ai.waitFor('killed: the request and 1 running command', 10_000);
    // Reads don't ask, but only inside its own folder.
    const reads = t.stub.toolResults.length;
    await prompt(); await t.ai.type('LIVE read: /etc/hosts');
    await until(t, () => t.stub.toolResults.slice(reads).some(r => r.includes('Path is outside the folder')), 'the read of /etc/hosts refused as outside the folder');
    await prompt();
    // /caps turns 2: this run has had more turns already, so the next message waits for you instead of asking the model.
    await t.ai.type('/caps turns 2'); await t.ai.waitFor(/caps: \d+\/2 turns/);
    const requests = t.stub.requests;
    await t.ai.type('LIVE hello caps'); await t.ai.waitFor('cap reached: 2 turns this run');
    if (t.stub.requests !== requests) await fail(t, 'the capped agent asked the model anyway');
    t.ai.write(KEY.esc); await sleep(300); await t.ai.type('/caps turns off'); await t.ai.waitFor('turns (no cap)');
    t.ai.write(KEY.ctrlE); await t.home.home();
  }),
  step('trust', '/send to an agent still at its trust prompt is refused (a stand-in Claude Code that never reports in)', '"Claude Code may be asking to trust its folder · go inside first"', async t => {
    await writeFile(join(t.world.bin, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA'); await t.ai.type('claude', false); await sleep(200);
    await t.ai.waitFor(/› .*[Cc]laude/, 5000, 'a Claude Code row in /model'); t.ai.write(KEY.enter);
    await waitBottom(t, /· claude code ·/, 'claude code');
    await t.home.command('LIVE trust me'); await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('new worktree · ai/claude-code');
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent'); await until(t, async () => (await t.home.card('Claude Code')) !== '', 'a Claude Code card');
    await t.home.command('/send Claude Code hello'); await t.ai.waitFor('Claude Code may be asking to trust its folder · go inside first');
  }),
  step('dontask', 'the agent bash sandbox (D57): a Don\'t ask agent (a second branch) can\'t read AI Term\'s settings, and its commands see no secrets', '"new worktree · ai/ai-term-2", "! don\'t ask"; the command\'s report says "blocked by sandbox: ~/.ai-term/settings.json"; env shows none of the planted secrets', async t => {
    await t.home.command('/model'); await t.ai.waitFor('OLLAMA'); await t.ai.type(STUB_MODEL, false); await sleep(200); t.ai.write(KEY.enter);
    await waitBottom(t, new RegExp(`${STUB_MODEL} · ai term`), `${STUB_MODEL} · ai term`);
    // B34: Linux without a working bubblewrap has no Don't ask; the homepage says why. The second agent still starts (in
    // Ask, a reply with no command), so the checks after this one find the same agents and branches.
    if (NO_LINUX_SANDBOX) {
      await t.home.command("/mode don't ask"); await t.ai.waitFor(/don't ask needs (bubblewrap|a sandbox)/, 5000, "the note saying don't ask needs a sandbox");
      await t.home.command('LIVE hello from a second agent');
      await t.ai.waitFor('Start a new agent'); await t.ai.waitFor('new worktree · ai/ai-term-2');
      t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
      await t.home.waitStatus('AI Term', /✓ done/, 20_000, 'done');
      const made = await git(t.repo, 'branch', '--format=%(refname:short)');
      if (!/^ai\/ai-term$/m.test(made) || !/^ai\/ai-term-2$/m.test(made)) await fail(t, `two AI Term agents should have two branches; git has: ${made.replace(/\n/g, ' ')}`);
      return;
    }
    await t.home.command("/mode don't ask"); await waitBottom(t, /don't ask/, "don't ask");
    const before = t.stub.toolResults.length;
    // By its absolute path in the world (security review: ~ is only as safe as HOME).
    await t.home.command(`LIVE run: cat ${t.world.aiHome}/settings.json; env | sort`);
    await t.ai.waitFor('Start a new agent'); await t.ai.waitFor("! don't ask"); await t.ai.waitFor('new worktree · ai/ai-term-2');
    t.ai.write(KEY.enter); await t.ai.waitGone('Start a new agent');
    await until(t, () => t.stub.toolResults.length > before, 'the command\'s report reaching the model', 30_000);
    const report = t.stub.toolResults.at(-1) ?? '';
    if (!report.includes('blocked by sandbox: ~/.ai-term/settings.json')) await fail(t, 'the agent\'s command read ~/.ai-term/settings.json, or its report doesn\'t say the sandbox blocked it');
    if (report.includes('"theme"')) await fail(t, 'the settings file\'s contents reached the agent');
    const leaked = Object.entries(PLANTED_SECRETS).filter(([name, secret]) => report.includes(name) || report.includes(secret)).map(([name]) => name);
    if (leaked.length) await fail(t, `the agent's env has ${leaked.join(', ')}`);
    if (!/^HOME=/m.test(report) || !/^PATH=/m.test(report)) await fail(t, 'env | sort printed no environment at all, so the secrets check proves nothing');
    await t.home.waitStatus('AI Term', /! ✓ done/, 20_000, "done, marked ! don't ask");
    const branches = await git(t.repo, 'branch', '--format=%(refname:short)');
    if (!/^ai\/ai-term$/m.test(branches) || !/^ai\/ai-term-2$/m.test(branches)) await fail(t, `two AI Term agents should have two branches; git has: ${branches.replace(/\n/g, ' ')}`);
    await t.home.command('/mode ask'); await waitBottom(t, /· ask ·/, 'ask');
  }),
  step('rename', 'r renames an agent, whatever letter the name starts with (s, x and d are homepage keys elsewhere)', 'the card named "sandboxed", not "andboxed"', async t => {
    await rename(t, 'AI Term', 'sandboxed');
  }),
  step('split', 'splits: Space marks two, v opens them side by side, Ctrl+\\ and clicks move focus, Ctrl+E and v reopen it, /exit in one pane, Ctrl+\\ closes it', '"2 marked · v opens them side by side", the underlined (focused) header moving, "exited · exit 0 sandboxed", then builder full screen', async t => {
    await t.home.select('builder'); await t.home.emptyBar(); t.ai.write(' '); await t.ai.waitFor('1 marked · Space marks one more');
    await t.home.select('sandboxed'); t.ai.write(' '); await t.ai.waitFor('2 marked · v opens them side by side');
    t.ai.write('v'); await t.ai.waitFor('^\\ next pane'); await t.ai.waitFor('each pane is its own agent in its own worktree');
    const focus = async () => (await t.ai.underlined()).join(' | ');
    const moveFocus = async () => { const before = await focus(); t.ai.write(KEY.ctrlBackslash); await until(t, async () => (await focus()) !== before, 'Ctrl+\\ moving the underlined (focused) header', 5000); return focus(); };
    const first = await focus(), second = await moveFocus();
    if (!/builder|sandboxed/.test(first) || !/builder|sandboxed/.test(second)) await fail(t, `the focused header names neither pane (before: "${first}", after: "${second}")`);
    // Ctrl+E from a split goes home; v with nothing marked opens the same split again.
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.home.emptyBar(); t.ai.write('v'); await t.ai.waitFor('^\\ next pane', 10_000, 'the split reopened by v');
    // A click in a pane focuses it; each pane's column comes from where its title sits in the header row.
    const header = (await t.ai.text()).split('\n').find(line => line.includes('builder') && line.includes('sandboxed')) ?? '';
    const clickOn = async (title: string) => {
      const x = header.indexOf(title) + 1; if (x < 1) await fail(t, `no pane header names ${title}`);
      t.ai.write(`\x1b[<0;${x};12M\x1b[<0;${x};12m`); await until(t, async () => (await focus()).includes(title), `a click in ${title}'s pane focusing it`, 5000);
    };
    await clickOn((await focus()).includes('builder') ? 'sandboxed' : 'builder'); await clickOn((await focus()).includes('builder') ? 'sandboxed' : 'builder');
    // Whichever pane the reopened split focused first, /exit goes to sandboxed (review: the two clicks end where they began).
    if (!(await focus()).includes('sandboxed')) await clickOn('sandboxed');
    if (!(await focus()).includes('sandboxed')) await fail(t, 'couldn\'t focus the sandboxed pane');
    await sleep(300); await t.ai.type('/exit'); await t.ai.waitFor(/exited · exit 0\s+sandboxed/, 15_000, 'the sandboxed pane saying exited · exit 0');
    await t.ai.waitFor('^\\ closes');
    t.ai.write(KEY.ctrlBackslash); await t.ai.waitGone('^\\ next pane', 10_000, 'the split');
    // builder full screen, the one pane left: no homepage, no split, its own prompt at the bottom.
    await until(t, async () => { const text = await t.ai.text(); return !/^ AI Term_/m.test(text) && /^› *$/.test(text.split('\n').filter(line => line.trim()).at(-1) ?? '') && text.includes('caps:'); }, 'builder full screen, the one pane left', 10_000);
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.home.waitStatus('sandboxed', /■ exited/, 10_000, 'exited');
    await t.home.command('/send sandboxed hi'); await t.ai.waitFor('sandboxed has exited · /retry restarts it');
  }),
  step('testbox', 'the test sandbox (D56): a test reading the planted ~/.ssh file is blocked; l switches 127.0.0.1 for a test that calls a local server', '"no reads of ~/.ssh", "✗ blocked by sandbox: ~/.ssh/known_hosts", "✗ blocked by sandbox: network" with 127.0.0.1 off, "✓ tests pass" with it on', async t => {
    await t.home.command(`/test-cmd cat ${t.world.home}/.ssh/known_hosts`); await t.ai.waitFor('✓ test command for');
    // B34: off macOS the plan says what that machine gives (no sandbox here, or 127.0.0.1 always the tests' own on Linux,
    // where l switches nothing); the runs below are sandbox-exec's.
    if (process.platform !== 'darwin') {
      await t.home.select('builder'); await t.home.command('/test'); await t.ai.waitFor('Run tests for builder');
      await t.ai.waitFor(NO_LINUX_SANDBOX ? "no sandbox: it runs with your user's rights" : "127.0.0.1: only the tests' own on Linux"); await t.home.close('Tests');
      await t.home.command('/test-cmd none'); await t.ai.waitFor(/test command .*cleared|no test command/i, 5000, 'the test command cleared');
      return;
    }
    await t.home.select('builder'); await t.home.command('/test'); await t.ai.waitFor('Run tests for builder'); await t.ai.waitFor('no reads of ~/.ssh'); await t.home.close('Tests');
    await runTest(t, 'builder', 'off'); await testCard(t, 'builder', '✗ blocked by sandbox: ~/.ssh/known_hosts');
    if ((await t.ai.text()).includes(KNOWN_HOSTS_TOKEN) || plain(t.ai.raw()).includes(KNOWN_HOSTS_TOKEN)) await fail(t, 'the planted known_hosts reached the screen');
    // The stub Ollama is a local service: reachable from a test only while the project allows 127.0.0.1.
    const port = new URL(t.stub.endpoint).port;
    await t.home.command(`/test-cmd node -e "require('node:http').get('http://127.0.0.1:${port}/api/tags', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', e => { console.error(e.message); process.exit(1); })"`);
    await t.ai.waitFor('✓ test command for');
    await runTest(t, 'builder', 'off'); await testCard(t, 'builder', '✗ blocked by sandbox: network');
    await runTest(t, 'builder', 'on'); await testCard(t, 'builder', '✓ tests pass');
    await t.home.select('builder'); await t.home.command('/test'); await t.ai.waitFor('127.0.0.1: on for this project'); t.ai.write('l'); await t.ai.waitFor('127.0.0.1: off · l allows it'); await t.home.close('Tests');
    await t.home.command('/test-cmd none'); await t.ai.waitFor(/test command .*cleared|no test command/i, 5000, 'the test command cleared');
  }),
  step('commit', '/commit y commits in the agent\'s worktree only', '"y commits it in the agent\'s worktree, with your name", then "✓ committed <sha> in the agent\'s worktree"; your main branch unchanged', async t => {
    const main = await git(t.repo, 'rev-parse', 'main'), worktree = await worktreeOf(t.repo, 'ai/ai-term');
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
    await t.home.waitStatus('/deck', /● waiting/, 30_000, 'waiting for you');
    await t.home.attach('/deck'); await t.ai.waitFor('y allows · n denies'); t.ai.write('y'); await t.ai.waitFor('✓ allowed');
    t.ai.write(KEY.ctrlE); await t.home.home(); await t.home.waitStatus('/deck', /✓ done/, 30_000, 'done');
    await t.home.command('/deck'); await t.ai.waitFor('LIVE deck for the live suite', 20_000); await t.ai.waitFor('› out/deck/live.html'); await t.ai.waitFor('s saves a copy to Downloads');
    t.ai.write('s'); await t.ai.waitFor('✓ saved a copy to');
    const saved = await textOf(join(t.world.downloads, 'live.html'));
    if (!saved.includes('LIVE deck') || !/Content-Security-Policy/i.test(saved)) await fail(t, `Downloads (the suite's ${t.world.downloads}) has no live.html with its no-script policy`);
    // o would hand an accepted file to /usr/bin/open (your browser): it's pressed only on a file that must be refused.
    const run = join(await worktreeOf(t.repo, 'ai/deck'), 'out', 'deck', 'run.html');
    if (((await stat(run)).mode & 0o111) === 0) await fail(t, 'out/deck/run.html isn\'t executable, so o would open it: not pressed');
    t.ai.write(KEY.down); await t.ai.waitFor('› out/deck/run.html');
    t.ai.write('o'); await t.ai.waitFor("That file is executable; AI Term doesn't open or save it");
    if (existsSync(join(t.world.aiHome, 'opened'))) await fail(t, 'o made a copy to open of an executable file');
    await t.home.close('Add-on');
  }),
  step('study', '/study pages with Space: one idea at a time, then the recap (a real Space key, which the panel once ignored)', '"Space next · 1/2", "Space next · 2/2", then the recap', async t => {
    t.stub.addon({ result: { kind: 'study', why: 'LIVE: worktrees let agents work apart.', chunks: [['LIVE idea one: a worktree is a second folder.', 'Check: where does it live?'], ['LIVE idea two: each has its own branch.', 'Check: which branch?']], recap: ['LIVE recap one', 'LIVE recap two', 'LIVE recap three'] } });
    await t.home.command('/study git worktrees'); await stubTarget(t);
    // The result comes into the open popup (closed, it can't be opened again: /study alone lists what's due today).
    t.ai.write('y'); await t.ai.waitFor('Running in Ask mode'); await t.ai.waitFor('LIVE idea one', 30_000); await t.ai.waitFor('Space next · 1/2');
    t.ai.write(' '); await t.ai.waitFor('LIVE idea two'); await t.ai.waitFor('Space next · 2/2');
    t.ai.write(' '); await t.ai.waitFor('LIVE recap three');
    await t.home.close('Add-on');
  }),
  step('dev', '/dev on a tiny local server: /dev-cmd, y starts it on its own 127.0.0.1 port, x stops it', '"▶ dev server for builder · http://127.0.0.1:<port>", the page answering LIVE-DEV-OK, then "stopped"', async t => {
    await t.home.command('/dev-cmd node server.js'); await t.ai.waitFor('✓ dev command for');
    await t.home.select('builder'); await t.home.command('/dev');
    // B34: on Linux a dev server runs without a sandbox (one there can't be reached from your browser): the plan says so
    // and only a capital Y runs it.
    await t.ai.waitFor('Dev server for builder');
    if (process.platform === 'linux') { await t.ai.waitFor('no sandbox: on Linux'); await t.ai.waitFor('Y (capital) runs it'); }
    else { await t.ai.waitFor('listens on 127.0.0.1 only'); await t.ai.waitFor('y starts it'); }
    t.ai.write(DEV_YES);
    const shown = await t.ai.waitFor(/▶ dev server for builder · http:\/\/127\.0\.0\.1:(\d+)/, 20_000, '▶ dev server for builder · http://127.0.0.1:<port>');
    const port = Number(shown.match(/▶ dev server for builder · http:\/\/127\.0\.0\.1:(\d+)/)?.[1]);
    await until(t, async () => (await localPage(port)) === 'LIVE-DEV-OK', `http://127.0.0.1:${port} answering LIVE-DEV-OK`, 20_000);
    await t.home.command('/dev'); await t.ai.waitFor('▶ running'); t.ai.write('x'); await t.ai.waitFor('dev server for builder stopped');
    await until(t, async () => (await localPage(port)) === null, `nothing listening on ${port} any more`, 15_000);
    await t.home.close('Dev server');
  }),
  step('devport', 'two agents\' /dev at once on one free port: the second y is refused', '"▶ dev server for builder", then in a second ai "Another agent\'s dev server just took that port" or "The dev server setup changed since it was shown"; no second server', async t => {
    const other = startAi(t.world, t.repo), second = new Home(other);
    try {
      await second.home();
      // Both plans show the same free port: nothing holds a port until its server runs.
      await second.select('/deck'); await second.command('/dev'); const plan = await other.waitFor(/Dev server for \/deck[\s\S]*http:\/\/127\.0\.0\.1:(\d+)/, 15_000, 'the /deck dev plan');
      await t.home.select('builder'); await t.home.command('/dev'); const mine = await t.ai.waitFor(/Dev server for builder[\s\S]*http:\/\/127\.0\.0\.1:(\d+)/, 15_000, 'the builder dev plan');
      const port = (text: string) => text.match(/in .* · http:\/\/127\.0\.0\.1:(\d+)/)?.[1];
      if (port(plan) !== port(mine)) await fail(t, `the two plans show different ports (${port(mine) ?? '?'} and ${port(plan) ?? '?'}), so nothing races`);
      t.ai.write(DEV_YES); await t.ai.waitFor(/▶ dev server for builder · http:\/\/127\.0\.0\.1:\d+/, 20_000);
      // Refused either way: the port is part of the plan you approved, so a plan whose port was just taken has changed.
      other.write(DEV_YES); await other.waitFor(/Another agent's dev server just took that port; run \/dev again|The dev server setup changed since it was shown; run \/dev again/, 15_000, 'the second y refused (port taken, or the plan changed)');
      if (/▶ dev/.test(await second.card('/deck'))) await fail(t, 'a second dev server started on the same port');
      await second.close('Dev server'); await second.command('/exit'); await Promise.race([other.exited, sleep(10_000)]);
      await t.home.command('/dev'); await t.ai.waitFor('▶ running'); t.ai.write('x'); await t.ai.waitFor('dev server for builder stopped'); await t.home.close('Dev server');
    } catch (error) { if (error instanceof LiveFailure && !error.screen.includes(await other.text())) throw new LiveFailure(error.message, `${error.screen}\n--- the second ai:\n${await other.text()}`); throw error; }
    finally { await other.close(); }
  }),
  step('brain', '/brain: the free local map of the repository (no model asked)', '"local map only · free", then "✓ brain for"; the stub got no request', async t => {
    const requests = t.stub.requests;
    await t.home.command('/brain'); await t.ai.waitFor('local map only · free'); await t.ai.waitFor('first map');
    t.ai.write(KEY.enter); await t.ai.waitFor(/✓ brain for .*files/, 30_000, '✓ brain for <repo>: N files');
    await t.home.command('/brain show'); await t.ai.waitFor(/Brain · .* old/, 10_000, 'the Brain popup with its age'); await t.home.close('Brain');
    if (t.stub.requests !== requests) await fail(t, 'the free local /brain asked a model');
  }),
  step('queue', '/queue: an agent queued "at HH:MM" starts by itself at that minute', '"✓ queued · /queue lists it", then the agent\'s first message and "▶ started" in /queue', async t => {
    const at = nextMinute();
    await t.home.command('/queue add'); await t.ai.waitFor('Queue a new agent');
    for (let i = 0; i < 4; i++) { t.ai.write(KEY.down); await sleep(60); }
    await t.ai.waitFor('› first message'); await t.ai.type('LIVE queued hello', false); await sleep(100); t.ai.write(KEY.enter);
    await t.ai.waitFor('When does it start?'); await t.ai.type(`at ${at}`);
    await t.ai.waitFor('Its limit:'); await t.ai.type('5 turns $1'); await t.ai.waitFor('✓ queued · /queue lists it');
    await t.home.command('/queue'); await t.ai.waitFor(`at ${at}`); await t.home.close('Queue');
    try { await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE queued hello')), `the queued agent starting at ${at} and sending its first message`, 150_000); }
    catch (error) { if (!(error instanceof LiveFailure)) throw error; await t.home.command('/queue'); await sleep(500); throw new LiveFailure(error.message, await t.ai.text()); }
    await t.home.command('/queue'); await t.ai.waitFor('▶ started', 10_000); await t.home.close('Queue');
  }),
  step('queueafter', '/queue after <agent>: an agent queued after builder starts when builder finishes its next turn', '"✓ queued", nothing started yet, then its first message once builder\'s turn ends', async t => {
    await t.home.command('/queue add'); await t.ai.waitFor('Queue a new agent');
    for (let i = 0; i < 4; i++) { t.ai.write(KEY.down); await sleep(60); }
    await t.ai.waitFor('› first message'); await t.ai.type('LIVE after builder hello', false); await sleep(100); t.ai.write(KEY.enter);
    await t.ai.waitFor('When does it start?'); await t.ai.type('after builder');
    await t.ai.waitFor('Its limit:'); await t.ai.type('5 turns $1'); await t.ai.waitFor('✓ queued · /queue lists it');
    await sleep(2000);
    if (t.stub.userMessages.some(m => m.includes('LIVE after builder hello'))) await fail(t, 'the queued agent started before builder finished a turn');
    await t.home.command('/send builder LIVE wake up'); await t.ai.waitFor('✓ sent to builder');
    await until(t, () => t.stub.userMessages.some(m => m.includes('LIVE after builder hello')), 'the agent queued after builder starting when builder finished', 60_000);
  }),
  step('find', '/find searches every agent\'s screen', '"Find “LIVE_SHELL_OK” · N", ⏎ shows the shell', async t => {
    await t.home.command('/find LIVE_SHELL_OK'); await t.ai.waitFor(/Find “LIVE_SHELL_OK” · [1-9]/, 10_000, 'Find “LIVE_SHELL_OK” with at least one match');
    t.ai.write(KEY.enter); await sleep(300); await t.home.close('Find');
    if (await t.home.selected() !== 'shell') await fail(t, '⏎ on the shell\'s match didn\'t show the shell in the preview');
  }),
  step('opencode', '/open code opens the selected agent\'s worktree in VS Code (a stand-in code command; /open itself would open Finder, so it isn\'t pressed)', '"opened … in VS Code"; code got -- and the worktree', async t => {
    const log = join(t.world.root, 'code-args.txt');
    // The path goes into the stand-in's single quotes: only plain path characters (security review).
    if (!/^[\w./-]+$/.test(log)) await fail(t, `the world's path has characters the stand-in code script can't quote: ${log}`);
    await writeFile(join(t.world.bin, 'code'), `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`, { mode: 0o755 });
    await t.home.select('builder'); await t.home.command('/open code'); await t.ai.waitFor('in VS Code');
    const worktree = await worktreeOf(t.repo, 'ai/ai-term');
    await until(t, async () => await textOf(log) === `--\n${worktree}\n`, `code being given -- and ${worktree}`);
  }),
  step('retry', '/retry restarts a finished agent fresh in its worktree', '"✓ restarted sandboxed in its worktree · its first message isn\'t resent", then its card running', async t => {
    await t.home.select('sandboxed'); await t.home.command('/retry'); await t.ai.waitFor("✓ restarted sandboxed in its worktree · its first message isn't resent");
    await t.home.waitStatus('sandboxed', /(◐|✓|●)/, 20_000, 'running again');
  }),
  step('bisect', '/bisect from Part A on a Node repository whose test runner writes a cache inside node_modules', '"dependencies: node_modules cloned from your checkout", the planted commit as the first bad one; your node_modules unchanged; no copy left', async t => {
    const { repo, bad, digest: before } = await bisectRepo(t.world), requests = t.stub.requests;
    await cd(t, repo);
    await t.home.command('/bisect npm test'); await t.ai.waitFor('test: npm test');
    // B34: without a sandbox nothing is cloned or linked into the copy, so this repository's tests can't run there: the
    // plan says so, asks for a capital Y, and Esc leaves everything as it was.
    if (NO_LINUX_SANDBOX) {
      await t.ai.waitFor('● no sandbox here'); await t.ai.waitFor('Y (capital) starts without a sandbox'); await t.ai.waitFor('the copy has only committed files');
      t.ai.write(KEY.esc); await t.ai.waitGone('Y (capital) starts without a sandbox');
      if (await treeDigest(join(repo, 'node_modules')) !== before) await fail(t, 'your node_modules changed');
      if ((await readdir(t.world.tmp)).some(name => name.startsWith('ai-term-clone-'))) await fail(t, 'a temporary copy was made though nothing ran');
      await cd(t, t.repo);
      return;
    }
    await t.ai.waitFor('dependencies: node_modules cloned from your checkout'); await t.ai.waitFor('✓ test sandbox');
    t.ai.write('y'); await t.ai.waitFor('planted: break the state', 120_000); await t.ai.waitFor(bad.slice(0, 7));
    await t.home.close('Add-on');
    if (await treeDigest(join(repo, 'node_modules')) !== before) await fail(t, 'your node_modules changed during the bisect');
    if (t.stub.requests !== requests) await fail(t, '/bisect asked a model');
    const left = (await readdir(t.world.tmp)).filter(name => name.startsWith('ai-term-clone-'));
    if (left.length) await fail(t, `the temporary copy is still there: ${left.join(', ')}`);
    await cd(t, t.repo);
  }),
  step('worktrees', 'x: a clean exited agent asks k/d (d deletes), one with work needs its branch name typed, k keeps', '"✓ nothing would be lost", "✓ deleted worktree and branch ai/ai-term-2", "! would be lost", "type ai/ai-term exactly to delete", "worktree kept"', async t => {
    // The clean one (D57's agent, back at its prompt after /retry): stopped, then x and d.
    await stop(t, 'sandboxed');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/ai-term-2'); await t.ai.waitFor('✓ nothing would be lost'); await t.ai.waitFor('k keep · d delete');
    t.ai.write('d'); await t.ai.waitFor('✓ deleted worktree and branch ai/ai-term-2');
    // builder has a commit not in main and untracked work: only its exact branch name deletes it.
    await stop(t, 'builder');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/ai-term'); await t.ai.waitFor('! would be lost'); await t.ai.waitFor('type ai/ai-term and ⏎ to delete');
    await t.ai.type('ai/ai-term-2'); await t.ai.waitFor('type ai/ai-term exactly to delete');
    for (let i = 0; i < 'ai/ai-term-2'.length; i++) t.ai.write(KEY.backspace);
    await t.ai.type('ai/ai-term'); await t.ai.waitFor(/✓ deleted worktree and branch ai\/ai-term(?!-)/, 15_000, '✓ deleted worktree and branch ai/ai-term');
    // The stand-in Claude Code's clean worktree is kept with k.
    await stop(t, 'Claude Code');
    t.ai.write('x'); await t.ai.waitFor('Worktree ai/claude-code'); await t.ai.waitFor('k keep · d delete'); t.ai.write('k'); await t.ai.waitFor('worktree kept:');
    const branches = await git(t.repo, 'branch', '--format=%(refname:short)'), list = await git(t.repo, 'worktree', 'list', '--porcelain');
    if (/^ai\/ai-term(-2)?$/m.test(branches) || /refs\/heads\/ai\/ai-term(-2)?$/m.test(list)) await fail(t, `a deleted agent's branch or worktree is still there: ${branches.replace(/\n/g, ' ')}`);
    if (!/^ai\/claude-code$/m.test(branches) || !existsSync(await worktreeOf(t.repo, 'ai/claude-code'))) await fail(t, 'k didn\'t keep ai/claude-code and its folder');
  }),
  step('clean', '/clean removes finished agents but keeps their worktrees; /worktrees lists them, ⏎ asks keep or delete', '"remove N finished agents? y/n", "kept 1 worktree · /worktrees reviews them", ai/deck and ai/claude-code in Worktrees, "✓ deleted worktree and branch ai/claude-code", "worktree kept"', async t => {
    await stop(t, '/deck');
    await t.home.command('/clean'); await t.ai.waitFor(/remove \d+ finished agents\? y\/n/); t.ai.write('y');
    await t.ai.waitFor(/removed \d+, 0 failed · kept 1 worktree · \/worktrees reviews them/, 15_000);
    if (existsSync(await worktreeOf(t.repo, 'ai/deck')) === false) await fail(t, '/clean deleted the /deck worktree');
    // Every worktree AI Term made: the queued agents' too, /deck's whose record /clean removed, and the one k kept.
    await t.home.command('/worktrees'); await t.ai.waitFor(/Worktrees \d+/, 10_000, 'the Worktrees popup');
    await t.ai.waitFor('ai/deck  ~/.ai-term/worktrees/'); await t.ai.waitFor('ai/claude-code  ~/.ai-term/worktrees/');
    const pick = async (branch: string) => { for (let i = 0; i < 4 && !new RegExp(`▎ ${branch.replace('/', '\\/')}  `).test(await t.ai.text()); i++) { t.ai.write(KEY.down); await sleep(200); } };
    await pick('ai/claude-code'); t.ai.write(KEY.enter); await t.ai.waitFor('✓ nothing would be lost'); await t.ai.waitFor('k keep · d delete');
    t.ai.write('d'); await t.ai.waitFor('✓ deleted worktree and branch ai/claude-code', 15_000);
    await t.ai.waitGone('ai/claude-code  ~/.ai-term/worktrees/', 10_000, 'the ai/claude-code row');
    await pick('ai/deck'); t.ai.write(KEY.enter); await t.ai.waitFor('! would be lost'); t.ai.write('k'); await t.ai.waitFor('worktree kept:');
    await t.home.close('Worktrees');
    const branches = await git(t.repo, 'branch', '--format=%(refname:short)');
    if (/^ai\/claude-code$/m.test(branches) || !/^ai\/deck$/m.test(branches)) await fail(t, `after d and k, git has: ${branches.replace(/\n/g, ' ')}`);
  }),
  step('doctor', 'ai doctor checks this world: the daemon, the folder modes, the CLIs it finds (only the stand-in Claude Code), the sandbox', '"Daemon: running", "mode 0700", the stand-in claude, "codex: not found", "Sandbox: sandbox-exec", "Credential store: unavailable", and the same lines in the /doctor popup', async t => {
    const { code, stdout } = await aiCommand(t.world, ['doctor'], t.repo);
    // The world's home has no login keychain: "unavailable" here also shows the run never reaches yours.
    for (const line of [/^Daemon: running/m, /: mode 0700$/m, existsSync(join(t.world.bin, 'claude')) ? new RegExp(`^claude: ${t.world.bin}/claude; version 2\\.1\\.302$`, 'm') : /^claude: not found/m, /^codex: not found/m, /^gh: not found/m, SANDBOX_LINE, /^Credential store: unavailable/m])
      if (!line.test(stdout)) throw new LiveFailure(`ai doctor (exit ${code}) printed no line matching ${String(line)}`, stdout);
    // /doctor on the homepage says the same.
    await t.home.command('/doctor'); await t.ai.waitFor('Daemon: running', 15_000);
    for (const line of stdout.split('\n').filter(l => /^(?:Daemon|codex|Sandbox|Credential store|gh|Notifier):/.test(l))) await t.ai.waitFor(line.slice(0, 60), 5000, `the Doctor popup saying "${line}"`);
    await t.home.close('Doctor');
  }),
  step('exit', '/exit leaves the homepage; the agents keep running', 'ai exits with 0; a new ai shows the shell still running', async t => {
    await t.home.command('/exit');
    const code = await Promise.race([t.ai.exited, sleep(10_000).then(() => -1)]);
    if (code !== 0) await fail(t, `ai exited with ${code}`);
    const again = startAi(t.world, t.repo), home = new Home(again);
    try { await home.home(); await until({ ...t, ai: again, home }, async () => /SH +shell +◐/.test(await home.cards()), 'the shell still running in a new ai'); await home.command('/exit'); await Promise.race([again.exited, sleep(10_000)]); }
    finally { await again.close(); }
  }),
];

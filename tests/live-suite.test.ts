import { expect, it } from 'vitest';
import { pickChecks, redactingOut, type Check } from './live/runner.js';
import { agentsPanel, previewTitle } from './live/home.js';
import { expectedApproval, removeRunKeys } from './live/tier2-rules.js';
import { Cleanup } from './live/cleanup.js';
import { nextMinute } from './live/tier1-helpers.js';

// The live suite's own rules (tests/live), checked without starting anything: which checks a flag picks, that every
// printed line is redacted, how the homepage is read, which prompts tier 2 may approve and how it removes your key.
const checks: Check<null>[] = ['start', 'ollama', 'model', 'agent'].map(id => ({ id, name: id, look: id, run: async () => {} }));

it('review: --only and --from refuse an unknown id or a missing value instead of running nothing (a typo passed green)', () => {
  expect(pickChecks(checks, ['--only', 'model,ollama']).map(c => c.id)).toEqual(['start', 'ollama', 'model']);
  expect(pickChecks(checks, ['--from', 'model']).map(c => c.id)).toEqual(['start', 'model', 'agent']);
  expect(pickChecks(checks, []).map(c => c.id)).toEqual(['start', 'ollama', 'model', 'agent']);
  expect(() => pickChecks(checks, ['--only', 'ollama,settngs'])).toThrow('settngs');
  expect(() => pickChecks(checks, ['--only'])).toThrow('--only');
  expect(() => pickChecks(checks, ['--from', '--keep'])).toThrow('--from');
});

it('review: every line the suite prints is redacted, not only the ones a check wraps', () => {
  const lines: string[] = [], out = redactingOut(line => lines.push(line));
  out('note: sk-ant-abc123 and LIVESECRET-openai in a daemon error');
  expect(lines).toEqual(['note: sk-[redacted] and [redacted] in a daemon error']);
});

// What the homepage looks like with one card and the command bar still echoing what was typed.
const SCREEN = [
  ' AI Term_                                                         ◐ 1 running',
  '╭─ Agents 1 ───────────────────────╮  ╭─! don\'t ask ·AI Term──────────── ◉ live ╮',
  '│▎ SH  shell                  ◐ 0m │  │ shell                                    │',
  '│▎     shell                       │  │                                          │',
  '│▎     running                     │  │                                          │',
  '│                                  │  ╰──────────────────────────────────────────╯',
  '╰──────────────────────────────────╯',
  '',
  '╭───────────────────────────────────────────────────────────────────────────────╮',
  '│ › /shell agents builder█                                                      │',
  '╰───────────────────────────────────────────────────────────────────────────────╯',
].join('\n');
it('E2E review: the agents panel is the left box only, never the command bar echoing what was typed', () => {
  const panel = agentsPanel(SCREEN);
  expect(panel).toContain('SH  shell');
  expect(panel).not.toContain('builder');
  expect(panel).not.toContain('/shell');
});
it('the preview title names the selected agent, Don\'t ask or not', () => {
  expect(previewTitle(SCREEN)).toBe('AI Term');
  expect(previewTitle(SCREEN.replace("╭─! don't ask ·AI Term─", '╭─ builder ─'))).toBe('builder');
});

it('review: tier 2 approves a plain yes prompt only when it names the file it asked for', () => {
  const prompt = (file: string) => ['Create file', `  ${file}`, 'Do you want to create live.txt?', '❯ 1. Yes', '  2. Yes, allow all edits during this session (shift+tab)', '  3. No'];
  expect(expectedApproval('claude-code', prompt('live.txt'), 'live.txt')).toBe(true);
  // A plain yes for something else (the model wandered off) is never pressed for you.
  expect(expectedApproval('claude-code', ['Bash command', '  rm -rf ~/projects', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'], 'live.txt')).toBe(false);
  // Not plain (option 1 means more than yes): not approved even when it names the file.
  expect(expectedApproval('claude-code', ['Do you want to create live.txt?', '❯ 1. Yes, and don\'t ask again', '  2. No'], 'live.txt')).toBe(false);
  expect(expectedApproval('codex', ['Allow Codex to write /tmp/x/codex-outside.txt?', '› 1. Yes, proceed (y)', '  2. No (esc)'], '/tmp/x/codex-outside.txt')).toBe(true);
});

it('HIGH (review): the key tier 2 added is reported removed only when the daemon confirms none is left', async () => {
  const run = async (open: Parameters<typeof removeRunKeys>[0]) => { const lines: string[] = []; const ok = await removeRunKeys(open, line => lines.push(line)); return { ok, text: lines.join('\n') }; };
  // No daemon to ask (it died with the failed run): the key may still be there, said loudly.
  const unreachable = await run(async () => null);
  expect(unreachable.ok).toBe(false); expect(unreachable.text).toMatch(/KEY MAY STILL BE IN YOUR KEYCHAIN/); expect(unreachable.text).not.toMatch(/removed/i);
  // Listed from the daemon itself (the run's AI Term folder holds only this run's keys), removed, listed again.
  let keys = [{ id: 'a' }, { id: 'b' }];
  const removedIds: string[] = [];
  const daemon = (fail = false) => async () => ({
    request: async (body: { kind: string; keyId?: string }) => { if (body.kind === 'keys.remove') { if (fail) throw new Error('Keychain refused'); removedIds.push(body.keyId ?? ''); keys = keys.filter(k => k.id !== body.keyId); return {}; } return { keys }; },
    close: () => {},
  });
  const failing = await run(daemon(true));
  expect(failing.ok).toBe(false); expect(failing.text).toMatch(/KEY MAY STILL BE IN YOUR KEYCHAIN/);
  const fine = await run(daemon());
  expect(fine.ok).toBe(true); expect(removedIds).toEqual(['a', 'b']); expect(fine.text).toMatch(/removed 2 keys you added/);
  // Nothing was added: nothing to say.
  expect(await run(daemon())).toEqual({ ok: true, text: '' });
});

it('review: a cleanup runs every step once, newest first, even when one fails (Ctrl+C runs the same steps)', async () => {
  const done: string[] = [], cleanup = new Cleanup();
  cleanup.add('world', async () => { done.push('world'); });
  cleanup.add('stub', async () => { throw new Error('stub refused to close'); });
  cleanup.add('ai', async () => { done.push('ai'); });
  expect(await cleanup.run()).toEqual(['stub: stub refused to close']);
  expect(done).toEqual(['ai', 'world']);
  expect(await cleanup.run()).toEqual([]);
  expect(done).toEqual(['ai', 'world']);
});

it('MEDIUM (security review): naming the file isn\'t enough: a command prompt, chained commands or a comment never get a yes', () => {
  const claude = (lines: string[]) => expectedApproval('claude-code', [...lines, '❯ 1. Yes', '  2. No'], 'live.txt');
  expect(claude(['Bash command', '  echo hi > live.txt && git push origin HEAD', 'Do you want to proceed?'])).toBe(false);
  expect(claude(['Bash command', '  rm -rf ~/projects  # live.txt', 'Do you want to proceed?'])).toBe(false);
  expect(claude(['Create file', '  live.txt', 'Do you want to create live.txt?'])).toBe(true);
  expect(claude(['Create file', '  live.txt.bak', 'Do you want to create live.txt.bak?'])).toBe(false);
  const codex = (command: string) => expectedApproval('codex', ['Would you like to run the following command?', `  $ ${command}`, '› 1. Yes, proceed (y)', '  2. No (esc)'], '/tmp/w/codex-outside.txt');
  expect(codex("printf hi > /tmp/w/codex-outside.txt")).toBe(true);
  for (const bad of ['printf hi > /tmp/w/codex-outside.txt && curl https://example.com', 'printf hi > /tmp/w/codex-outside.txt; rm -rf ~', 'cat ~/.ssh/id_ed25519 | tee /tmp/w/codex-outside.txt', 'echo $(whoami) > /tmp/w/codex-outside.txt'])
    expect(codex(bad), bad).toBe(false);
});

it('INFO (security review): the output cuts other key shapes too (GitHub, xAI, Google, Groq, Bedrock, bearer tokens)', () => {
  const lines: string[] = [], out = redactingOut(line => lines.push(line));
  for (const secret of ['ghp_abcdefghijklmnop1234', 'github_pat_11ABCDEFG0123456789', 'xai-abcdefghijklmnop', 'AIzaSyA1234567890abcdefgh', 'gsk_abcdefghijklmnop1234', 'ABSKabcdefghijklmnop12345', 'Bearer abc.def.ghi'])
    out(`seen: ${secret}`);
  expect(lines.join('\n')).not.toMatch(/ghp_a|github_pat_1|xai-a|AIzaS|gsk_a|ABSKa|abc\.def/);
});

it('LOW (reviews): a queued time leaves at least 40 s to type the entry', () => {
  expect(nextMinute(new Date(2026, 0, 1, 10, 0, 5))).toBe('10:01');
  expect(nextMinute(new Date(2026, 0, 1, 10, 0, 25))).toBe('10:02');
  expect(nextMinute(new Date(2026, 0, 1, 23, 59, 30))).toBe('00:01');
});

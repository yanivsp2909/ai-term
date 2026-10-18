import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ANSWER_ERRORS, answerKeys, answerRefusal, approvable, managerBackend, screenFingerprint, type RemoteManager } from '../src/daemon/remote/backend.js';
import type { SessionInfo } from '../src/shared/protocol.js';

// v1.0.8 /remote: what the phone may do with agents. Never a shell or a login session; every start is Ask in an offered
// folder; an answer goes only to the permission prompt the phone saw, never while you're attached on the Mac.
const now = new Date().toISOString();
const session = (over: Partial<SessionInfo>): SessionInfo => ({ id: randomUUID(), title: 'fixer', engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: '/work', permission: 'ask', status: 'waiting', statusDetail: 'permission', statusSince: now, exitCode: null, createdAt: now, lastOutputAt: null, ctxPercent: 40, lastActivity: null, ...over } as SessionInfo);
function manager(sessions: SessionInfo[]) {
  const calls: unknown[][] = [];
  const m: RemoteManager = {
    list: () => sessions, remoteScreen: async () => ({ lines: [], fingerprint: 'f'.repeat(64), waiting: null }),
    remoteAnswer: async (id, keys, fp) => { calls.push(['answer', id, keys(sessions.find(s => s.id === id)?.engine ?? 'shell'), fp]); },
    remoteFolders: async () => ['/work'], send: async () => { throw new Error('Agent is asking for permission'); }, stop: async () => { throw new Error('EACCES /secret/path'); },
    create: async request => { calls.push(['create', request]); return session({ title: 'Claude Code' }); },
  };
  return { m, calls };
}

it('the phone lists agents only, never shells or login sessions, with status, ctx % and usage but nothing else', () => {
  const agent = session({ taskUsage: { tokens: 900, costUsd: null } }), shell = session({ engine: 'shell', title: 'zsh' }), login = session({ login: true, title: 'login' });
  expect(managerBackend(manager([agent, shell, login]).m).agents()).toEqual([{ id: agent.id, title: 'fixer', engine: 'claude-code', status: 'waiting', detail: 'permission', ctx: 40, tokens: 900, costUsd: null, waiting: 'permission', dontAsk: false }]);
});

it('each engine is answered with its own keys; a shell never', () => {
  expect([answerKeys('claude-code', true), answerKeys('claude-code', false), answerKeys('codex', true), answerKeys('codex', false), answerKeys('ai-term', true), answerKeys('ai-term', false)]).toEqual(['1', '\x1b', 'y', '\x1b', 'y', 'n']);
  expect(() => answerKeys('shell', true)).toThrow(ANSWER_ERRORS[1]);
});

it('approval spoofing: an answer goes only to the prompt the phone saw, only for a permission prompt, never while you are attached', () => {
  const fp = screenFingerprint('id', now, ['Bash command', 'rm -rf build']);
  expect(screenFingerprint('id', now, ['Bash command', 'rm -rf /'])).not.toBe(fp);
  expect(screenFingerprint('id', new Date(Date.now() + 1000).toISOString(), ['Bash command', 'rm -rf build'])).not.toBe(fp);
  expect(answerRefusal({ attached: false, waiting: 'permission', current: fp, given: fp, approvable: true })).toBeNull();
  expect(answerRefusal({ attached: true, waiting: 'permission', current: fp, given: fp, approvable: true })).toBe(ANSWER_ERRORS[0]);
  expect(answerRefusal({ attached: false, waiting: 'question', current: fp, given: fp, approvable: true })).toBe(ANSWER_ERRORS[1]);
  expect(answerRefusal({ attached: false, waiting: null, current: fp, given: fp, approvable: true })).toBe(ANSWER_ERRORS[1]);
  expect(answerRefusal({ attached: false, waiting: 'permission', current: fp, given: 'a'.repeat(64), approvable: true })).toBe(ANSWER_ERRORS[2]);
  expect(answerRefusal({ attached: false, waiting: 'permission', current: fp, given: fp, approvable: false })).toBe(ANSWER_ERRORS[5]);
});

it('a start is Ask in an offered folder; known refusals reach the phone and anything else is one fixed line', async () => {
  const agent = session({ engine: 'codex' }), { m, calls } = manager([agent]), backend = managerBackend(m);
  await backend.answer(agent.id, true, 'f'.repeat(64));
  await expect(backend.start({ engine: 'claude-code', folder: '/elsewhere', message: 'hi' })).rejects.toThrow(ANSWER_ERRORS[3]);
  await backend.start({ engine: 'claude-code', folder: '/work', message: 'hi' });
  expect(calls).toEqual([['answer', agent.id, 'y', 'f'.repeat(64)], ['create', { engine: 'claude-code', model: null, auth: { kind: 'account' }, cwd: '/work', permission: 'ask', firstMessage: 'hi' }]]);
  await expect(backend.send(agent.id, 'x')).rejects.toThrow('Agent is asking for permission');
  await expect(backend.stop(agent.id)).rejects.toThrow("That didn't work on your Mac · try it there");
});

it('LOW (TS review): only a plain yes/no tool prompt can be approved from the phone; any other option 1 is refused', () => {
  expect(approvable('claude-code', ['Bash command', '  npm test', 'Do you want to proceed?', '❯ 1. Yes', '  2. Yes, and don\'t ask again for npm test', '  3. No, and tell Claude what to do differently (esc)'])).toBe(true);
  expect(approvable('claude-code', ['Would you like to proceed?', '❯ 1. Yes, and auto-accept edits', '  2. Yes, and manually approve edits', '  3. No, keep planning'])).toBe(false);
  expect(approvable('claude-code', ['Do you trust the files in this folder?', '❯ 1. Yes, proceed', '  2. No, exit'])).toBe(false);
  expect(approvable('codex', ['Allow command?', '› 1. Yes, proceed (y)', '  2. No (esc)'])).toBe(true);
  expect(approvable('codex', ['Something else', '› 1. Continue'])).toBe(false);
  expect(approvable('ai-term', ['bash: npm test', '  y allows · n denies · Esc denies and stops'])).toBe(true);
  expect(approvable('ai-term', ['bash: long', '  Space shows the next page'])).toBe(false);
});

it('MEDIUM (security review): an agent in Don\'t ask is shown as such and takes no message from the phone', async () => {
  const agent = session({ permission: 'dontAsk' }), backend = managerBackend(manager([agent]).m);
  expect(backend.agents()[0]).toMatchObject({ dontAsk: true });
  await expect(backend.send(agent.id, 'run it')).rejects.toThrow(ANSWER_ERRORS[4]);
});

it('MEDIUM (gate): only the live prompt counts: an earlier "1. Yes" line can\'t vouch for a later prompt whose option 1 means more', () => {
  expect(approvable('claude-code', ['  1. Yes', 'Ready to code?', ' ❯ 1. Yes, and bypass permissions', ' 2. Yes, manually approve edits', ' 3. No'])).toBe(false);
  expect(approvable('claude-code', ['1. Yes, and auto-accept', 'Bash command', 'Do you want to proceed?', '❯ 1. Yes', '  2. No'])).toBe(true);
  expect(approvable('codex', ['› 1. Yes, proceed (y)', 'later', '› 1. Always allow (a)'])).toBe(false);
  expect(approvable('ai-term', ['  y allows · n denies · Esc denies and stops', 'more output after the prompt', 'Space shows the next page'])).toBe(false);
});

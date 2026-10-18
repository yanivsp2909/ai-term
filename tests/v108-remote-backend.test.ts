import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { ANSWER_ERRORS, answerKeys, answerRefusal, managerBackend, screenFingerprint, type RemoteManager } from '../src/daemon/remote/backend.js';
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
  expect(managerBackend(manager([agent, shell, login]).m).agents()).toEqual([{ id: agent.id, title: 'fixer', engine: 'claude-code', status: 'waiting', detail: 'permission', ctx: 40, tokens: 900, costUsd: null, waiting: 'permission' }]);
});

it('each engine is answered with its own keys; a shell never', () => {
  expect([answerKeys('claude-code', true), answerKeys('claude-code', false), answerKeys('codex', true), answerKeys('codex', false), answerKeys('ai-term', true), answerKeys('ai-term', false)]).toEqual(['1', '\x1b', 'y', '\x1b', 'y', 'n']);
  expect(() => answerKeys('shell', true)).toThrow(ANSWER_ERRORS[1]);
});

it('approval spoofing: an answer goes only to the prompt the phone saw, only for a permission prompt, never while you are attached', () => {
  const fp = screenFingerprint('id', now, ['Bash command', 'rm -rf build']);
  expect(screenFingerprint('id', now, ['Bash command', 'rm -rf /'])).not.toBe(fp);
  expect(screenFingerprint('id', new Date(Date.now() + 1000).toISOString(), ['Bash command', 'rm -rf build'])).not.toBe(fp);
  expect(answerRefusal({ attached: false, waiting: 'permission', current: fp, given: fp })).toBeNull();
  expect(answerRefusal({ attached: true, waiting: 'permission', current: fp, given: fp })).toBe(ANSWER_ERRORS[0]);
  expect(answerRefusal({ attached: false, waiting: 'question', current: fp, given: fp })).toBe(ANSWER_ERRORS[1]);
  expect(answerRefusal({ attached: false, waiting: null, current: fp, given: fp })).toBe(ANSWER_ERRORS[1]);
  expect(answerRefusal({ attached: false, waiting: 'permission', current: fp, given: 'a'.repeat(64) })).toBe(ANSWER_ERRORS[2]);
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

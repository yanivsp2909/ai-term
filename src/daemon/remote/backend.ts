import { createHash } from 'node:crypto';
import type { SessionInfo } from '../../shared/protocol.js';
import type { RemoteAgent, RemoteScreen, RemoteStart } from '../../shared/remote.js';
import { RemoteRefusal, type RemoteBackend } from './http.js';

// v1.0.8 /remote: what the phone may do, mapped onto the session manager. Agents only: a shell would run whatever the
// phone sends, so shells and login sessions never appear. Refusals the phone should read are passed on as they are;
// anything else becomes one fixed line.
export const ANSWER_ERRORS = ['Agent is open on your Mac · answer it there', "The agent isn't asking for permission now", 'The prompt changed · look at it again', 'Pick one of the folders shown', "This agent runs in Don't ask · send to it on your Mac", "This prompt can't be answered from the phone · answer it on your Mac"] as const;
const PASSED = new Set<string>([...ANSWER_ERRORS, 'Session not found', 'Agent has exited', 'Agent is open in a session', 'Agent is asking for permission', 'Agent is asking a question', 'Agent is running a tool',
  'Agent has not reported its status yet', 'Agent is printing too fast to check', 'Agent does not accept pasted lines', 'Text pasted but not sent; go inside', 'Agent is busy with another send', 'Agent is being handed off',
  'Invalid send request', 'claude not found in PATH', 'codex not found in PATH', 'Engine is not logged in', 'Engine login status unavailable', 'Add-on CLI runs require a confirmed subscription login']);
// The keys that answer each engine's own permission prompt: Claude Code's "1. Yes" or Esc; Codex's y or Esc; AI Term's
// agent's y or n.
export function answerKeys(engine: SessionInfo['engine'], yes: boolean): string {
  if (engine === 'claude-code') return yes ? '1' : '\x1b';
  if (engine === 'codex') return yes ? 'y' : '\x1b';
  if (engine === 'ai-term') return yes ? 'y' : 'n';
  throw new RemoteRefusal(ANSWER_ERRORS[1]);
}
// The only prompts the phone may answer: a plain yes-or-no permission prompt whose yes is exactly the key it sends
// (review: Claude Code's plan exit, its folder trust and other prompts also have an option 1 that means more than yes,
// such as auto-accepting every edit). Only the live prompt counts, the last one on the screen (gate: an earlier line
// could vouch for a later prompt): Claude Code's last option 1 must be "1. Yes" alone; Codex's a Yes marked (y); AI
// Term's agent must end on its last page, which says y allows.
export function approvable(engine: SessionInfo['engine'], lines: readonly string[]): boolean {
  const lastOne = [...lines].reverse().find(line => /^\s*(?:[❯>›]\s*)?1\.\s/.test(line));
  if (engine === 'claude-code') return !!lastOne && /^\s*(?:[❯>›]\s*)?1\.\s*Yes\s*$/.test(lastOne);
  if (engine === 'codex') return !!lastOne && /^\s*(?:[❯>›]\s*)?1\.\s*Yes\b[^()]*\(y\)\s*$/.test(lastOne);
  if (engine === 'ai-term') return /\by allows · n denies\b/.test([...lines].reverse().find(line => line.trim()) ?? '');
  return false;
}
// What the phone saw, and when the agent's status last changed: an answer counts only for exactly that screen.
export const screenFingerprint = (id: string, since: string, lines: readonly string[]): string => createHash('sha256').update(JSON.stringify([id, since, lines])).digest('hex');
// Whether an answer may go to the agent now: not while you're attached on the Mac, only to a permission prompt, and only
// for the screen the phone saw. Returns the refusal, or null.
export function answerRefusal(state: { attached: boolean; waiting: RemoteScreen['waiting']; current: string; given: string; approvable: boolean }): string | null {
  if (state.attached) return ANSWER_ERRORS[0];
  if (state.waiting !== 'permission') return ANSWER_ERRORS[1];
  if (state.current !== state.given) return ANSWER_ERRORS[2];
  return state.approvable ? null : ANSWER_ERRORS[5];
}
export interface RemoteManager {
  list(): SessionInfo[];
  remoteScreen(id: string): Promise<RemoteScreen>;
  remoteAnswer(id: string, keys: (engine: SessionInfo['engine']) => string, fingerprint: string): Promise<void>;
  remoteFolders(): Promise<string[]>;
  send(id: string, text: string): Promise<void>;
  stop(id: string): Promise<void>;
  create(request: { engine: 'claude-code' | 'codex'; model: null; auth: { kind: 'account' }; cwd: string; permission: 'ask'; firstMessage: string }): Promise<SessionInfo>;
}
const passed = async <T>(work: () => Promise<T>): Promise<T> => {
  try { return await work(); } catch (error) { if (error instanceof RemoteRefusal) throw error; throw new RemoteRefusal(error instanceof Error && PASSED.has(error.message) ? error.message : "That didn't work on your Mac · try it there"); }
};
export function managerBackend(manager: RemoteManager): RemoteBackend {
  const visible = (s: SessionInfo) => s.engine !== 'shell' && !s.login;
  return {
    agents: () => manager.list().filter(visible).map((s): RemoteAgent => ({ id: s.id, title: s.title, engine: s.engine, status: s.status, detail: s.statusDetail ?? '', ctx: s.ctxPercent ?? null, tokens: s.taskUsage?.tokens ?? null, costUsd: s.taskUsage?.costUsd ?? null,
      waiting: s.status === 'waiting' && (s.statusDetail === 'permission' || s.statusDetail === 'question') ? s.statusDetail : null, dontAsk: s.permission === 'dontAsk' })),
    folders: () => manager.remoteFolders(),
    screen: id => passed(() => manager.remoteScreen(id)),
    answer: (id, yes, fingerprint) => passed(() => manager.remoteAnswer(id, engine => answerKeys(engine, yes), fingerprint)),
    // An agent in Don't ask runs whatever a message leads to without asking: the phone may watch and stop it, not steer it.
    send: (id, text) => passed(() => { if (manager.list().find(s => s.id === id)?.permission === 'dontAsk') throw new RemoteRefusal(ANSWER_ERRORS[4]); return manager.send(id, text); }),
    stop: id => passed(() => manager.stop(id)),
    // Ask, always: the phone has no other choice to send, and this line is the only one that starts an agent from it.
    start: request => passed(async () => {
      if (!(await manager.remoteFolders()).includes(request.folder)) throw new RemoteRefusal(ANSWER_ERRORS[3]);
      const made = await manager.create({ engine: request.engine, model: null, auth: { kind: 'account' }, cwd: request.folder, permission: 'ask', firstMessage: request.message });
      return { id: made.id, title: made.title };
    }),
  };
}
export type { RemoteStart };

import type { SessionInfo, Status, TaskUsage } from '../../shared/protocol.js';
import type { TestResult } from '../../shared/test-run.js';
import { compactTokens } from './usage-panel.js';
import { ownLoginLabel, engineLabel } from '../../shared/models.js';
import { keyAuthLabel } from '../../shared/providers.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { ColorName } from './theme.js';
// design.md status marks. The card says "done"; the top line counts the same agents as "to review".
export const marks: Record<Status, [string, ColorName, string]> = { starting: ['◐', 'status-running', 'starting'], running: ['◐', 'status-running', 'running'], waiting: ['●', 'status-waiting', 'waiting'], done: ['✓', 'status-done', 'done'], exited: ['■', 'status-idle', 'exited'], error: ['✗', 'status-error', 'failed'] };
const QUIET_AFTER_MS = 10000, CTX_WARN = 85, MIN_NAME = 4, CTX_GAP = 2;
// Below this text width a card keeps only name, status and auth: ctx and activity go before the status word does.
const NARROW = 20;
export interface Styled { text: string; color: ColorName }
export interface CardText { status: Styled & { bold: boolean }; model: string; ctx: Styled | null; activity: Styled | null; auth: string; line3: string }
function compact(ms: number, unit: 's' | 'm'): string { const minutes = Math.floor(ms / 60000); return unit === 's' && ms < 60000 ? `${Math.floor(ms / 1000)}s` : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
export function age(session: SessionInfo, now: number): string { return compact(Math.max(0, now - Date.parse(session.statusSince)), 'm'); }
// Quiet means no output, tool or status change for 10 s while running. lastOutputAt reaches the client at most every 5 s (output-clock.ts).
export function quietSince(session: SessionInfo): number | null {
  if (session.status !== 'running' || session.engine === 'shell') return null;
  const times = [session.lastOutputAt, session.lastActivity?.at, session.statusSince].map(time => time ? Date.parse(time) : NaN).filter(Number.isFinite);
  // Unreadable times mean no quiet label at all, never an "Infinity" label or a NaN timer.
  return times.length ? Math.max(...times) : null;
}
export function quietSeconds(session: SessionInfo, now: number): number | null { const since = quietSince(session); return since === null || now - since < QUIET_AFTER_MS ? null : Math.floor((now - since) / 1000); }
// One redraw at the next 10 s crossing, then once a second while a card shows quiet; null when nothing will change.
export function nextCardTick(sessions: readonly SessionInfo[], now: number): number | null {
  let next: number | null = null;
  for (const session of sessions) {
    const since = quietSince(session); if (since === null) continue;
    // Past a minute the label counts minutes, so it only needs a redraw at the next minute.
    const elapsed = now - since, wait = elapsed < QUIET_AFTER_MS ? QUIET_AFTER_MS - elapsed : elapsed < 60000 ? 1000 - elapsed % 1000 : 60000 - elapsed % 60000;
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}
function activity(session: SessionInfo, now: number): Styled | null {
  if (session.handoffTo) return { text: `handed off → ${session.handoffTo}`, color: 'ink-3' };
  // A question that needs you comes first; then an account limit (D53), over the usual activity. Nothing switches by itself.
  if (session.status !== 'waiting' && session.limit && !['exited', 'error'].includes(session.status)) return { text: `⏸ limit${session.limit.resets ? ` · resets ${session.limit.resets}` : ''}`, color: 'status-waiting' };
  if (session.status === 'waiting') return { text: session.statusDetail === 'permission' || session.statusDetail === 'question' ? `asks: ${session.statusDetail}` : session.statusDetail, color: 'status-waiting' };
  // design.md: done reads `+N −M · ready to review` once the daemon has counted the worktree's changes (v0.7.1).
  // v0.7.4: the project's tests, once they ran (or ask to), take the place of "ready to review"; a failure is red.
  if (session.status === 'done') {
    const stat = session.diffStat, change = stat ? (stat.files ? `+${stat.added} −${stat.removed}` : 'no changes') : null, tests = session.tests ? testsText(session.tests) : null;
    return { text: [change, tests?.text ?? 'ready to review'].filter(Boolean).join(' · '), color: tests?.color ?? 'ink-3' };
  }
  if (session.status === 'error') return { text: session.exitCode !== null && !session.statusDetail.startsWith('exit ') ? `exit ${session.exitCode} · ${session.statusDetail}` : session.statusDetail, color: 'status-error' };
  if (session.status !== 'running') return null;
  const quiet = quietSince(session);
  if (quiet !== null && now - quiet >= QUIET_AFTER_MS) return { text: `quiet ${compact(now - quiet, 's')}`, color: 'ink-3' };
  return session.lastActivity ? { text: session.lastActivity.tool, color: 'ink-3' } : null;
}
export function testsText(tests: TestResult): Styled {
  switch (tests.state) {
    case 'running': return { text: '◐ testing', color: 'status-running' };
    case 'pass': return { text: '✓ tests pass', color: 'status-done' };
    case 'fail': return { text: tests.failing === null ? '✗ tests fail' : `✗ ${tests.failing} failing`, color: 'status-error' };
    case 'timeout': return { text: '✗ tests timed out', color: 'status-error' };
    case 'error': return { text: "✗ tests couldn't start", color: 'status-error' };
    case 'ask': return { text: '? test setup changed · /test', color: 'status-waiting' };
  }
}
// Text for one agent card whose text area is `width` cells. Debug shells keep their v0.1 activity line.
// D55: at 85% context a card says so once it gets there, in place of its activity, while the agent isn't waiting on you.
// AI Term's agent has /clear; the CLIs have /compact. /settings turns it off.
export const CONTEXT_WARN_PERCENT = 85;
function contextWarning(session: SessionInfo): Styled | null {
  if (session.ctxPercent === null || session.ctxPercent < CONTEXT_WARN_PERCENT || !['running', 'done'].includes(session.status)) return null;
  return { text: `context ${Math.round(session.ctxPercent)}% · ${session.engine === 'ai-term' ? '/clear' : '/compact'} or start fresh`, color: 'status-waiting' };
}
// Cost per task (v0.6.1, D55): dollars for API-key sessions, tokens on a subscription (it bills the plan, not a key).
export function taskCostText(usage: TaskUsage | undefined): string | null {
  if (!usage) return null;
  if (usage.costUsd === null) return usage.tokens > 0 ? `${compactTokens(usage.tokens)} tok` : null;
  if (usage.costUsd === 0 && usage.tokens === 0) return null;
  const dollars = usage.costUsd < 0.005 ? '<$0.01' : `$${usage.costUsd.toFixed(2)}`;
  return dollars + (usage.unknownPrice ? '+?' : '');
}
export function cardText(session: SessionInfo, now: number, width: number, options: { contextWarning?: boolean; taskCost?: boolean } = {}): CardText {
  const [glyph, color, word] = marks[session.status], shell = session.engine === 'shell', narrow = width < NARROW;
  const dontAsk = session.permission === 'dontAsk' ? '! ' : '', withAge = `${dontAsk}${glyph} ${shell ? '' : word + ' '}${age(session, now)}`;
  const status = { text: !shell && textWidth(withAge) + 1 + MIN_NAME > width ? `${dontAsk}${glyph} ${word}` : withAge, color, bold: session.status === 'waiting' };
  const baseModel = shell ? 'shell' : `${session.model ?? 'CLI default'} · ${engineLabel(session.engine)}`;
  const withBranch=baseModel+(session.branch?` · ${session.branch}`:'');
  const model=textWidth(withBranch)<=width?withBranch:baseModel;
  // Full `ctx NN%` when it fits beside the whole model text; else the mockup's bare `NN%`; else none. The model is never clipped for it.
  const percent = session.ctxPercent === null || shell || narrow ? null : `${Math.round(session.ctxPercent)}%`;
  const ctxText = percent === null ? null : [`ctx ${percent}`, percent].find(text => textWidth(model) + CTX_GAP + text.length <= width) ?? null;
  const ctx = ctxText ? { text: ctxText, color: (session.ctxPercent ?? 0) >= CTX_WARN ? 'status-waiting' as const : 'ink-3' as const } : null;
  const login = session.auth.kind === 'key' ? (session.auth.provider === 'ollama' ? keyAuthLabel('ollama', '') : `API key ····${session.auth.last4}`) : shell ? '' : session.auth.profile ? ownLoginLabel(session.authMethod).replace(/^own login/, `account ${session.auth.profile}`) : ownLoginLabel(session.authMethod), cost = options.taskCost === false ? null : taskCostText(session.taskUsage);
  const auth = cost && login ? `${login} · ${cost}` : login;
  if (shell) return { status, model, ctx, activity: null, auth, line3: session.statusDetail === word ? word : `${word} · ${session.statusDetail}` };
  if(session.worktreeNote)return {status,model,ctx,activity:null,auth,line3:session.worktreeNote};
  const act = narrow ? null : (options.contextWarning !== false ? contextWarning(session) : null) ?? activity(session, now), joined = act && auth ? `${act.text} · ${auth}` : null;
  return { status, model, ctx, activity: act, auth, line3: act ? (joined && textWidth(joined) <= width ? joined : act.text) : auth };
}

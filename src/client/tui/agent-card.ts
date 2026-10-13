import type { SessionInfo, Status } from '../../shared/protocol.js';
import { ownLoginLabel } from '../../shared/models.js';
import { textWidth } from '../../shared/unicode-width.js';
import type { ColorName } from './theme.js';
// design.md status marks. The card says "done"; the top line counts the same agents as "to review".
export const marks: Record<Status, [string, ColorName, string]> = { starting: ['◐', 'status-running', 'starting'], running: ['◐', 'status-running', 'running'], waiting: ['●', 'status-waiting', 'waiting'], done: ['✓', 'status-done', 'done'], exited: ['■', 'status-idle', 'exited'], error: ['✗', 'status-error', 'failed'] };
const QUIET_AFTER_MS = 10000, CTX_WARN = 85, MIN_NAME = 4, MIN_MODEL = 10;
// Below this text width a card keeps only name, status and auth: ctx and activity go before the status word does.
const NARROW = 20;
export interface Styled { text: string; color: ColorName }
export interface CardText { status: Styled & { bold: boolean }; model: string; ctx: Styled | null; activity: Styled | null; auth: string; line3: string }
function compact(ms: number, unit: 's' | 'm'): string { const minutes = Math.floor(ms / 60000); return unit === 's' && ms < 60000 ? `${Math.floor(ms / 1000)}s` : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`; }
export function age(session: SessionInfo, now: number): string { return compact(Math.max(0, now - Date.parse(session.statusSince)), 'm'); }
// Quiet means no output, tool or status change for 10 s while running. lastOutputAt reaches the client at most every 5 s (output-clock.ts).
export function quietSince(session: SessionInfo): number | null {
  if (session.status !== 'running' || session.engine === 'shell') return null;
  return Math.max(...[session.lastOutputAt, session.lastActivity?.at, session.statusSince].map(time => time ? Date.parse(time) : -Infinity).filter(Number.isFinite));
}
export function quietSeconds(session: SessionInfo, now: number): number | null { const since = quietSince(session); return since === null || now - since < QUIET_AFTER_MS ? null : Math.floor((now - since) / 1000); }
// One redraw at the next 10 s crossing, then once a second while a card shows quiet; null when nothing will change.
export function nextCardTick(sessions: readonly SessionInfo[], now: number): number | null {
  let next: number | null = null;
  for (const session of sessions) {
    const since = quietSince(session); if (since === null) continue;
    const elapsed = now - since, wait = elapsed < QUIET_AFTER_MS ? QUIET_AFTER_MS - elapsed : 1000 - elapsed % 1000;
    next = next === null ? wait : Math.min(next, wait);
  }
  return next;
}
function activity(session: SessionInfo, now: number): Styled | null {
  if (session.status === 'waiting') return { text: session.statusDetail === 'permission' || session.statusDetail === 'question' ? `asks: ${session.statusDetail}` : session.statusDetail, color: 'status-waiting' };
  if (session.status === 'done') return { text: 'ready to review', color: 'ink-3' };
  if (session.status === 'error') return { text: session.exitCode !== null && !session.statusDetail.startsWith('exit ') ? `exit ${session.exitCode} · ${session.statusDetail}` : session.statusDetail, color: 'status-error' };
  if (session.status !== 'running') return null;
  const quiet = quietSince(session);
  if (quiet !== null && now - quiet >= QUIET_AFTER_MS) return { text: `quiet ${compact(now - quiet, 's')}`, color: 'ink-3' };
  return session.lastActivity ? { text: session.lastActivity.tool, color: 'ink-3' } : null;
}
// Text for one agent card whose text area is `width` cells. Debug shells keep their v0.1 activity line.
export function cardText(session: SessionInfo, now: number, width: number): CardText {
  const [glyph, color, word] = marks[session.status], shell = session.engine === 'shell', narrow = width < NARROW;
  const dontAsk = session.permission === 'dontAsk' ? '! ' : '', withAge = `${dontAsk}${glyph} ${shell ? '' : word + ' '}${age(session, now)}`;
  const status = { text: !shell && textWidth(withAge) + 1 + MIN_NAME > width ? `${dontAsk}${glyph} ${word}` : withAge, color, bold: session.status === 'waiting' };
  const model = shell ? 'shell' : `${session.model ?? 'CLI default'} · ${session.engine === 'codex' ? 'codex' : 'claude code'}`;
  const ctxText = session.ctxPercent === null || shell ? null : `ctx ${Math.round(session.ctxPercent)}%`;
  const ctx = ctxText && !narrow && MIN_MODEL + 1 + ctxText.length <= width ? { text: ctxText, color: (session.ctxPercent ?? 0) >= CTX_WARN ? 'status-waiting' as const : 'ink-3' as const } : null;
  const auth = session.auth.kind === 'key' ? `API key ····${session.auth.last4}` : shell ? '' : ownLoginLabel(session.authMethod);
  if (shell) return { status, model, ctx, activity: null, auth, line3: session.statusDetail === word ? word : `${word} · ${session.statusDetail}` };
  const act = narrow ? null : activity(session, now), joined = act && auth ? `${act.text} · ${auth}` : null;
  return { status, model, ctx, activity: act, auth, line3: act ? (joined && textWidth(joined) <= width ? joined : act.text) : auth };
}

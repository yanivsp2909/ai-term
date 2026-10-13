import type { SessionInfo } from '../shared/protocol.js';
type StatusPair = Pick<SessionInfo, 'status' | 'statusDetail'>;
export type NotificationAlert = { kind: 'waiting'; reason: 'permission' | 'question' | 'turn failed' | null } | { kind: 'done' };
// The helper refuses bodies over 200 Unicode scalars; the name keeps room for the longest change text.
const MAX_NAME = 60;
// D42: always when an agent starts waiting (permission, question, turn failed); done only when nobody is attached to it.
// One notification per transition: the same status and reason again is not a new one. Nothing when the setting is off.
export function notificationFor(previous: StatusPair, next: StatusPair, attached: boolean, enabled: boolean): NotificationAlert | null {
  if (!enabled || previous.status === next.status && previous.statusDetail === next.statusDetail) return null;
  if (next.status === 'waiting') {
    const reason = next.statusDetail === 'permission' || next.statusDetail === 'question' ? next.statusDetail : next.statusDetail.startsWith('turn failed') ? 'turn failed' : null;
    return { kind: 'waiting', reason };
  }
  return next.status === 'done' && previous.status !== 'done' && !attached ? { kind: 'done' } : null;
}
// Whitespace becomes one space and every other control, format or private-use character goes, as the helper requires.
function notificationName(title: string): string {
  const clean = title.replace(/[\s\p{Zl}\p{Zp}]+/gu, ' ').replace(/\p{C}/gu, '').replace(/ +/g, ' ').trim(), points = [...clean];
  if (!points.length) return 'agent';
  return points.length > MAX_NAME ? points.slice(0, MAX_NAME - 1).join('') + '…' : clean;
}
// Only the agent's name and what changed: never the failure text, prompts, replies, tool input or paths.
export function notificationBody(title: string, alert: NotificationAlert): string {
  return `${notificationName(title)} · ${alert.kind === 'done' ? 'done' : alert.reason ? `waiting: ${alert.reason}` : 'waiting'}`;
}

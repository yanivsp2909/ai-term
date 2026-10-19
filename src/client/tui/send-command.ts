import { MAX_SEND_BYTES, type SessionInfo } from '../../shared/protocol.js';
import { cleanSendText } from '../../shared/validate.js';

export const SEND_TOO_LONG = 'too long to send (16 KB): go inside and paste';
const USAGE = '/send <agent> <text> · Tab completes the name';
// `/send <agent> <text>` (D50). Names may hold spaces, so the longest agent name the text starts with wins; it must
// match exactly and be followed by a space or newline. The text keeps its newlines and loses every other control.
export function parseSend(input: string, sessions: readonly SessionInfo[]): { session: SessionInfo; text: string } | { note: string } {
  if (!input.startsWith('/send ')) return { note: USAGE };
  const rest = input.slice('/send '.length);
  const named = sessions.filter(s => rest.startsWith(s.title) && (rest.length === s.title.length || /\s/.test(rest[s.title.length] ?? '')));
  const longest = Math.max(-1, ...named.map(s => s.title.length)), matches = named.filter(s => s.title.length === longest);
  const [session] = matches;
  if (!session) return { note: rest.trim() ? `no agent is named ${rest.trim().split(/\s/)[0] ?? ''} · Tab completes names` : USAGE };
  if (matches.length > 1) return { note: `${matches.length} agents are named ${session.title} · r renames one` };
  const text = cleanSendText(rest.slice(session.title.length + 1));
  if (!text.trim()) return { note: USAGE };
  if (Buffer.byteLength(text) > MAX_SEND_BYTES) return { note: SEND_TOO_LONG };
  return { session, text };
}
// Checked here for an instant answer and again by the daemon, which has the final word.
export function sendRefusal(session: SessionInfo): string | null {
  if (['exited', 'error'].includes(session.status)) return `${session.title} has exited · /retry restarts it`;
  if (session.status === 'waiting' && session.statusDetail === 'permission') return `${session.title} is asking for permission, go inside to answer`;
  if (session.status === 'waiting' && session.statusDetail === 'question') return `${session.title} is asking a question, go inside to answer`;
  return null;
}
// The daemon's fixed reasons, said with the agent's name.
export function sendFailure(title: string, reason: string): string {
  const notes: Record<string, string> = {
    'Agent is asking for permission': `${title} is asking for permission, go inside to answer`,
    'Agent is asking a question': `${title} is asking a question, go inside to answer`,
    'Agent has exited': `${title} has exited · /retry restarts it`,
    'Agent is open in a session': `${title} is open in a session or split · type there`,
    'Agent has not reported its status yet': `${title} may be asking to trust its folder · go inside first`,
    // Part B: Cursor, Gemini and Copilot CLI report no status, so /send can't tell what they are showing.
    "This CLI reports no status; open it (⏎) and type there": `${title} reports no status, so /send can't tell what it shows · open it (⏎) and type there`,
    'Agent does not accept pasted lines': `${title} doesn't accept pasted lines · send one line or go inside`,
    'Text pasted but not sent; go inside': `${title} started asking something · text pasted but not sent, go inside`,
    'Agent is busy with another send': `${title} is still taking the last /send`,
    'Agent is printing too fast to check': `${title} is printing too fast to check · try again`,
    'Agent is running a tool': `${title} is running a tool and may ask permission · try again when it finishes`,
  };
  return Object.hasOwn(notes, reason) ? notes[reason] ?? reason : reason;
}

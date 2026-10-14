// v0.6.4 (D53): a CLI that hit its account's usage limit says so on its screen. Only these whole phrases count, so a reply
// that merely mentions limits never does. Claude Code: "5-hour limit reached ∙ resets 3pm", "Claude usage limit reached.
// Your limit will reset at 7:30 pm"; Codex: "You've hit your usage limit. … try again at 3:45 PM" (or "in 2 hours").
const PHRASES = [/\b(?:usage|5-hour|weekly|opus|session) limit reached\b/i, /\byou(?:'|’)ve hit your usage limit\b/i];
const TIME = /\b(?:resets?(?: at)?|reset at|try again at) (\d{1,2}(?::\d{2})?\s?(?:am|pm)?)/i;
export function parseLimit(screen: string): { resets: string | null } | null {
  for (const line of screen.split('\n')) {
    if (!PHRASES.some(phrase => phrase.test(line))) continue;
    return { resets: clock(line.match(TIME)?.[1]) };
  }
  return null;
}
// "3pm" → "15:00", "7:30 pm" → "19:30", "15:45" stays; anything else is no time at all.
function clock(text: string | undefined): string | null {
  const m = text?.trim().match(/^(\d{1,2})(?::(\d{2}))?\s?(am|pm)?$/i);
  if (!m) return null;
  let hours = Number(m[1]); const minutes = Number(m[2] ?? '0'), half = m[3]?.toLowerCase();
  if (half && (hours < 1 || hours > 12)) return null;
  if (half === 'pm' && hours < 12) hours += 12; if (half === 'am' && hours === 12) hours = 0;
  if (!half && !m[2]) return null;
  return hours < 24 && minutes < 60 ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}` : null;
}

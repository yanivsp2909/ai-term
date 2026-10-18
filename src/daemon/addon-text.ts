import { cutText } from '../shared/text-cut.js';

// Text AI Term hands an add-on as data. quoted() marks every line as quoted (`> `), so text written by other people (an
// issue, a PR, a web page) reads as a quotation, not as part of the prompt. fitEscaped() cuts it by the size it has inside
// the prompt (JSON-escaped: quotes and backslashes double), with a line saying it was cut.
export const quoted = (text: string): string => text.replace(/\r/g, '').split('\n').map(line => `> ${line}`).join('\n');
// A fact or label from repository text (a file name, an import): control characters replaced and cut by bytes, so it
// is always one plain line the popup accepts (at most 300 bytes; follow-up review).
export function factText(text: string, bytes = 240): string {
  let out = '';
  for (const char of text.replace(/[\p{C}]/gu, '?')) { if (Buffer.byteLength(out + char) > bytes) return `${out}…`; out += char; }
  return out;
}
export function fitEscaped(text: string, bytes: number): string {
  const fits = (value: string) => Buffer.byteLength(JSON.stringify(value)) <= bytes;
  if (fits(text)) return text;
  let room = text.length, cut: string;
  do { room = Math.floor(room * 0.9); cut = `${cutText(text, room)}\n(cut here: the rest didn't fit)`; } while (room > 0 && !fits(cut));
  return cut;
}

import type { ModelMessage } from 'ai';

// v0.7.4 /compact: the older part of AI Term's agent conversation becomes one summary written by its own model, so later
// requests carry less context. The last KEEP_TURNS user turns (with everything that answered them) stay word for word.
export const KEEP_TURNS = 2, COMPACT_OUTPUT_TOKENS = 2_000, COMPACT_OUTPUT_LOW = 300, COMPACT_SOURCE_CHARS = 200_000, TOOL_RESULT_CHARS = 2_000;
export const COMPACT_INSTRUCTIONS = 'Summarize the conversation above so it can replace it: the goal, what was decided and done (name real files, commands and results), what is left, and open questions. Be concise and concrete. Never include secrets, keys or tokens.';
// Older turns end where the KEEP_TURNS-th user message from the end starts; null when there is nothing older.
export function splitHistory(history: readonly ModelMessage[], keep = KEEP_TURNS): { older: ModelMessage[]; kept: ModelMessage[]; turns: number } | null {
  const starts = history.flatMap((message, index) => message.role === 'user' ? [index] : []);
  if (starts.length <= keep) return null;
  const cut = starts[starts.length - keep] ?? history.length;
  return { older: history.slice(0, cut), kept: history.slice(cut), turns: starts.length - keep };
}
// The older turns as plain text: tool calls and results become short lines (no tool parts, so any provider accepts the
// request without tool definitions); past COMPACT_SOURCE_CHARS the oldest text goes first.
export function renderTurns(messages: readonly ModelMessage[]): string {
  const lines: string[] = [];
  for (const message of messages) {
    if (typeof message.content === 'string') { lines.push(`${message.role}: ${message.content}`); continue; }
    for (const part of message.content) {
      if (part.type === 'text') lines.push(`${message.role}: ${part.text}`);
      else if (part.type === 'tool-call') lines.push(`${message.role} used ${part.toolName}: ${JSON.stringify(part.input).slice(0, 400)}`);
      else if (part.type === 'tool-result') { const output = JSON.stringify(part.output); lines.push(`result of ${part.toolName}: ${output.length > TOOL_RESULT_CHARS ? `${output.slice(0, TOOL_RESULT_CHARS)}…` : output}`); }
    }
  }
  const text = lines.join('\n');
  return text.length > COMPACT_SOURCE_CHARS ? `(earlier text cut)\n${text.slice(text.length - COMPACT_SOURCE_CHARS)}` : text;
}
export function compactPrompt(older: readonly ModelMessage[]): string { return `<conversation>\n${renderTurns(older)}\n</conversation>\n\n${COMPACT_INSTRUCTIONS}`; }
// The new start of the conversation: the summary as a user message, acknowledged, then the kept turns.
export function compactedHistory(summary: string, kept: readonly ModelMessage[]): ModelMessage[] {
  return [{ role: 'user', content: `Summary of our earlier conversation (from /compact):\n${summary}` }, { role: 'assistant', content: 'Understood; I will continue from this summary.' }, ...kept];
}

import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { redactSecrets } from '../shared/redact.js';
import { EXPORT_ENTRY_CHARS, EXPORT_MAX_ENTRIES, EXPORT_TRANSCRIPT_CHARS, type ExportEntry, type SessionExport } from '../shared/session-export.js';
import { isFsError } from '../shared/paths.js';

// v0.7.1 /export: AI Term's agent writes its transcript (src/agent/transcript.ts) into the daemon's private session
// folder. It is read here only, through no symlink, at most 8 MiB, one JSON object per line; a line that isn't one is
// skipped. Every string is redacted again (the agent already redacted its own key) and capped.
const READ_BYTES = 8 * 1024 * 1024;
const cut = (value: string) => value.length > EXPORT_ENTRY_CHARS ? value.slice(0, EXPORT_ENTRY_CHARS) + '…' : value;
function entry(raw: unknown): ExportEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>, at = typeof r.at === 'string' && Number.isFinite(Date.parse(r.at)) ? r.at : null;
  if (!at || at.length > 40) return null;
  const make = (kind: ExportEntry['kind'], label: string, text: unknown) => typeof text === 'string' ? { at, kind, label: label.slice(0, 80), text: cut(redactSecrets(text)) } : null;
  const tool = typeof r.tool === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(r.tool) ? r.tool : 'tool';
  switch (r.kind) {
    case 'user': return make('user', 'you', r.text);
    case 'assistant': return make('assistant', 'agent', r.text);
    case 'note': return make('note', 'note', r.text);
    case 'tool-call': return make('tool-call', tool, r.input);
    case 'tool-result': return make('tool-result', `${tool} · ${r.ok === true ? 'ok' : 'failed'}`, r.output);
    case 'model': return make('model', 'model', r.model);
    default: return null;
  }
}
export async function readTranscript(path: string): Promise<{ entries: ExportEntry[]; truncated: boolean }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let raw: string, more: boolean;
  try {
    const info = await file.stat();
    if (!info.isFile()) throw new Error('Transcript is not a file');
    const buffer = Buffer.alloc(Math.min(info.size, READ_BYTES)), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    raw = buffer.subarray(0, bytesRead).toString('utf8'); more = info.size > bytesRead;
  } finally { await file.close(); }
  const entries: ExportEntry[] = [];
  let chars = 0, truncated = more;
  for (const line of raw.split('\n')) {
    if (!line) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(line); } catch { continue; }
    const next = entry(parsed);
    if (!next) continue;
    if (entries.length >= EXPORT_MAX_ENTRIES || chars + next.text.length > EXPORT_TRANSCRIPT_CHARS) { truncated = true; break; }
    entries.push(next); chars += next.text.length;
  }
  return { entries, truncated };
}

// No transcript file yet (the agent never wrote one) is an empty conversation, not a capped one.
export async function transcriptFor(path: string): Promise<{ entries: ExportEntry[]; truncated: boolean }> {
  try { return await readTranscript(path); } catch (error) { if (isFsError(error, 'ENOENT')) return { entries: [], truncated: false }; throw error; }
}
// Names the agent chose (its title, branch) and paths can carry a secret too.
export function redactExportMeta(data: SessionExport): SessionExport {
  return { ...data, title: redactSecrets(data.title), cwd: redactSecrets(data.cwd), ...(data.branch ? { branch: redactSecrets(data.branch) } : {}), model: data.model === null ? null : redactSecrets(data.model) };
}
// The answer is one protocol frame (4 MiB): sized by its JSON bytes, not characters (escapes and CJK grow it). The
// screen text keeps its end, then the conversation drops entries from its end, until it fits 3 MiB.
const FRAME_BUDGET = 3 * 1024 * 1024;
export function fitExport(data: SessionExport): SessionExport {
  let out = data;
  const size = () => Buffer.byteLength(JSON.stringify(out));
  while (size() > FRAME_BUDGET && out.text.length > 0) out = { ...out, text: out.text.slice(Math.ceil(out.text.length / 4)), truncated: true };
  while (size() > FRAME_BUDGET && out.transcript?.length) out = { ...out, transcript: out.transcript.slice(0, Math.floor(out.transcript.length * 3 / 4)), transcriptTruncated: true };
  return out;
}

import type { Engine } from './protocol.js';

// v0.7.1 /export: what the daemon hands the client for one session's HTML file. Text only, already redacted
// (src/shared/redact.ts), each part capped so the answer fits one protocol frame. The client builds and saves the page.
export interface ExportEntry { at: string; kind: 'user' | 'assistant' | 'note' | 'tool-call' | 'tool-result' | 'model'; label: string; text: string }
export interface SessionExport { title: string; engine: Engine; model: string | null; cwd: string; branch?: string; createdAt: string; exportedAt: string; text: string; truncated: boolean; transcript: ExportEntry[] | null; transcriptTruncated?: boolean }
// The screen text keeps its end; the transcript its start (the conversation reads from the top), each about 1 MiB.
export const EXPORT_TEXT_CHARS = 1_000_000, EXPORT_TRANSCRIPT_CHARS = 1_000_000, EXPORT_ENTRY_CHARS = 64 * 1024, EXPORT_MAX_ENTRIES = 5_000;
const KINDS: readonly ExportEntry['kind'][] = ['user', 'assistant', 'note', 'tool-call', 'tool-result', 'model'];
const date = (v: unknown) => typeof v === 'string' && v.length <= 40 && Number.isFinite(Date.parse(v));
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;
function isEntry(v: unknown): v is ExportEntry {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const e = v as Record<string, unknown>;
  return Object.keys(e).length === 4 && date(e.at) && KINDS.includes(e.kind as ExportEntry['kind']) && text(e.label, 80) && text(e.text, EXPORT_ENTRY_CHARS + 1);
}
export function validateSessionExport(value: unknown): SessionExport {
  const d = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
  const keys = ['title', 'engine', 'model', 'cwd', 'branch', 'createdAt', 'exportedAt', 'text', 'truncated', 'transcript', 'transcriptTruncated'];
  if (!d || Object.keys(d).some(k => !keys.includes(k)) || !text(d.title, 200) || !['shell', 'claude-code', 'codex', 'ai-term'].includes(String(d.engine)) || !(d.model === null || text(d.model, 200))
    || !text(d.cwd, 4096) || d.branch !== undefined && !text(d.branch, 200) || !date(d.createdAt) || !date(d.exportedAt) || !text(d.text, EXPORT_TEXT_CHARS + 1) || typeof d.truncated !== 'boolean'
    || !(d.transcript === null || Array.isArray(d.transcript) && d.transcript.length <= EXPORT_MAX_ENTRIES && d.transcript.every(isEntry)) || d.transcriptTruncated !== undefined && typeof d.transcriptTruncated !== 'boolean') throw new Error('Invalid export');
  return d as unknown as SessionExport;
}

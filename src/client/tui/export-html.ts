import type { SessionExport } from '../../shared/session-export.js';
import { engineLabel } from '../../shared/models.js';
import { createTheme } from './theme.js';

// v0.7.1 /export: one self-contained HTML page. Everything from the session is escaped text; no script, no link, no
// outside request (a Content-Security-Policy says so too). Colors come from the design tokens through the theme module:
// graphite for dark, light for light, by the reader's system setting.
// Controls (but new lines and tabs) and bidi overrides go first: reordered text could make the page say something the
// session didn't (Trojan Source); then HTML escaping.
// eslint-disable-next-line no-control-regex -- removing controls is the point.
const escape = (text: string) => text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
function palette(name: 'graphite' | 'light'): string {
  const c = createTheme(name).colors;
  return `--bg:${c.bg};--surface:${c.surface};--line:${c.line};--ink:${c.ink};--ink-2:${c['ink-2']};--ink-3:${c['ink-3']};--accent:${c.accent};`;
}
export function exportHtml(data: SessionExport): string {
  const title = escape(data.title), meta = [engineLabel(data.engine), data.model ?? 'CLI default', data.cwd, data.branch].filter((part): part is string => !!part).map(escape).join(' · ');
  const transcript = data.transcript === null ? '' : `<h2>Conversation</h2>${data.transcript.length ? data.transcript.map(entry => `<section class="entry ${entry.kind}"><div class="label">${escape(entry.label)} · ${escape(entry.at)}</div><pre>${escape(entry.text)}</pre></section>`).join('') : '<p class="note">no transcript</p>'}${data.transcriptTruncated ? '<p class="note">the rest of the conversation is not included (capped)</p>' : ''}`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>${title} · AI Term export</title>
<style>
:root{${palette('graphite')}color-scheme:dark}
@media (prefers-color-scheme: light){:root{${palette('light')}color-scheme:light}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
main{max-width:1100px;margin:0 auto}h1{font-size:18px;margin:0 0 4px}h2{font-size:15px;margin:28px 0 8px;color:var(--ink-2)}
.meta,.note,.label{color:var(--ink-3)}.label{font-size:12px;margin-bottom:4px}
pre{margin:0;padding:12px;background:var(--surface);border:1px solid var(--line);border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}
.entry{margin:10px 0}.entry.user pre{border-left:3px solid var(--accent)}
</style></head>
<body><main>
<h1>${title}</h1>
<div class="meta">${meta}</div>
<div class="meta">started ${escape(data.createdAt)} · exported ${escape(data.exportedAt)} · keys and tokens removed</div>
${transcript}
<h2>Screen</h2>${data.truncated ? '<p class="note">earlier output is not included (capped)</p>' : ''}
<pre>${escape(data.text)}</pre>
</main></body></html>
`;
}

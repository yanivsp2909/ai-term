import { EXTENSION_DESCRIPTION_CHARS, type ExtensionKind } from '../../shared/extensions.js';
import { cutText } from '../../shared/text-cut.js';

const clean = (s: string) => s.replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').trim();
// The shared CLI format needs scalar name/description/model fields and YAML block descriptions. Other metadata is
// ignored, never interpreted as tool permissions. Unsupported or broken frontmatter is skipped rather than guessed.
export function parseExtension(text: string, kind: ExtensionKind, fallback: string): { name: string; description: string; body: string; model?: string } {
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n'), values: Record<string, string> = {};
  let body = text;
  if (lines[0] === '---') {
    const end = lines.indexOf('---', 1);
    if (end < 0) throw new Error('malformed frontmatter');
    const seen = new Set<string>();
    for (let n = 1; n < end; n++) {
      const line = lines[n] ?? '';
      if (!line.trim() || line.trimStart().startsWith('#')) continue;
      const field = line.match(/^([A-Za-z][\w-]*):(?:\s+(.*))?$/);
      if (!field || seen.has(field[1] ?? '')) throw new Error('malformed frontmatter');
      const key = field[1] ?? '', raw = (field[2] ?? '').trim(); seen.add(key);
      let value = raw;
      if (/^[|>][+-]?$/.test(raw)) {
        const block: string[] = [];
        while (n + 1 < end && (/^\s/.test(lines[n + 1] ?? '') || !(lines[n + 1] ?? '').trim())) block.push((lines[++n] ?? '').trim());
        value = block.join(' ');
      } else if (!raw) {
        // Nested metadata maps/lists are irrelevant to these three fields.
        while (n + 1 < end && /^\s/.test(lines[n + 1] ?? '')) n++;
      } else if (raw.startsWith('"')) {
        const parsed: unknown = JSON.parse(raw); if (typeof parsed !== 'string') throw new Error('malformed frontmatter'); value = parsed;
      } else if (raw.startsWith("'")) {
        if (!raw.endsWith("'") || raw.length < 2) throw new Error('malformed frontmatter'); value = raw.slice(1, -1).replace(/''/g, "'");
      } else if (raw.startsWith('[') && !raw.endsWith(']') || raw.startsWith('{') && !raw.endsWith('}')) throw new Error('malformed frontmatter');
      if (['name', 'description', 'model'].includes(key)) {
        if (/^[[{]/.test(raw)) throw new Error('metadata must be text');
        values[key] = clean(value);
      }
    }
    body = lines.slice(end + 1).join('\n');
  } else if (kind === 'skill') throw new Error('skill needs frontmatter');
  const name = values.name || fallback;
  if (values.model && values.model.length > 240) throw new Error('model metadata too long');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(name) || !body.trim() || kind === 'skill' && (!values.name || !values.description)) throw new Error('invalid extension');
  return { name, description: cutText(values.description ?? '', EXTENSION_DESCRIPTION_CHARS), body, ...(values.model ? { model: values.model } : {}) };
}

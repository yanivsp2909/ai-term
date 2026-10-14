import { EXTENSION_DESCRIPTION_CHARS } from '../../shared/extensions.js';

// Codex agent definitions are data, never executable settings. Only the three text fields are interpreted.
export function parseCodexAgent(text: string, fallback: string): { name: string; description: string; body: string; model?: string } {
  const fields: Record<string, string> = {}, lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let n = 0; n < lines.length; n++) {
    const line = (lines[n] ?? '').trim(); if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([A-Za-z_][\w-]*)\s*=\s*(.*)$/); if (!match) throw new Error('unsupported TOML');
    const key = match[1] ?? '', raw = match[2] ?? ''; let value: unknown;
    if (raw.startsWith('"""') || raw.startsWith("'''")) {
      const quote = raw.slice(0, 3); let rest = raw.slice(3);
      while (!rest.includes(quote) && n + 1 < lines.length) rest += '\n' + (lines[++n] ?? '');
      const end = rest.indexOf(quote); if (end < 0 || rest.slice(end + 3).trim() && !rest.slice(end + 3).trim().startsWith('#')) throw new Error('unsupported TOML');
      value = rest.slice(0, end).replace(/^\n/, '');
      if (quote === '"""') value = JSON.parse('"' + String(value).replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t').replace(/(?<!\\)"/g, '\\"') + '"') as unknown;
    } else if (raw.startsWith('"')) value = JSON.parse(raw) as unknown;
    else if (/^'[^']*'$/.test(raw)) value = raw.slice(1, -1);
    else if (['name', 'description', 'instructions', 'developer_instructions'].includes(key)) throw new Error('text expected');
    // Non-text operational fields are ignored; they never grant tools, models or permissions.
    if (!['name', 'description', 'instructions', 'developer_instructions'].includes(key)) continue;
    if (typeof value !== 'string' || Object.hasOwn(fields, key)) throw new Error('invalid TOML field');
    fields[key] = value;
  }
  const name = fields.name || fallback, body = fields.instructions ?? fields.developer_instructions ?? '';
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(name) || !body.trim()) throw new Error('invalid agent');
  return { name, description: (fields.description ?? '').replace(/[\p{C}]/gu, ' ').replace(/\s+/g, ' ').slice(0, EXTENSION_DESCRIPTION_CHARS), body };
}

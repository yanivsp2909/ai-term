import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { dirname, relative } from 'node:path';
import { resolveInside, JailError } from './jail.js';
import { isFsError } from '../shared/paths.js';

const FILE_MAX_BYTES = 64 * 1024, TOTAL_MAX_BYTES = 256 * 1024, IMPORT_DEPTH = 3;

export interface Instructions { text: string; files: string[]; notes: string[] }

// The folder's AGENTS.md, then CLAUDE.md with its `@path` import lines (a line holding only @path, the form CLAUDE.md
// uses to pull in AGENTS.md) resolved inside the folder. Each file is read once, whatever imports it again; sizes and
// import depth are bounded; nothing outside the folder is read (D48's folders come in v0.4.3).
export async function loadInstructions(root: string): Promise<Instructions> {
  const seen = new Set<string>(), files: string[] = [], notes: string[] = [];
  let total = 0;
  const read = async (path: string, depth: number): Promise<string | null> => {
    let real: string;
    // An import the file system can't even look up (a name too long, an unreadable folder) is skipped like one outside.
    try { real = await resolveInside(root, path); } catch (error) { notes.push(`skipped ${relative(root, path) || path}: ${error instanceof JailError ? 'outside the folder' : "can't read"}`); return null; }
    if (seen.has(real)) return null;
    let text: string;
    try {
      const file = await open(real, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) return null;
        const buffer = Buffer.alloc(Math.min(info.size, FILE_MAX_BYTES)), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        text = buffer.subarray(0, bytesRead).toString('utf8');
        if (info.size > FILE_MAX_BYTES) notes.push(`${relative(root, real)} cut at ${FILE_MAX_BYTES / 1024} KiB`);
      } finally { await file.close(); }
    } catch (error) { if (isFsError(error, 'ENOENT')) return null; notes.push(`couldn't read ${relative(root, real)}`); return null; }
    if (total + Buffer.byteLength(text) > TOTAL_MAX_BYTES) { notes.push(`skipped ${relative(root, real)}: instructions over ${TOTAL_MAX_BYTES / 1024} KiB`); return null; }
    seen.add(real); files.push(relative(root, real)); total += Buffer.byteLength(text);
    const lines: string[] = [];
    for (const line of text.split('\n')) {
      const target = line.trim().match(/^@(\S+)$/)?.[1];
      if (target === undefined) { lines.push(line); continue; }
      if (depth >= IMPORT_DEPTH) { notes.push(`skipped @${target}: imports nest too deep`); continue; }
      const imported = await read(resolveFrom(dirname(real), target), depth + 1);
      if (imported !== null) lines.push(imported);
    }
    return lines.join('\n');
  };
  const parts: string[] = [];
  for (const name of ['AGENTS.md', 'CLAUDE.md']) {
    const text = await read(name, 0);
    if (text !== null && text.trim()) parts.push(`## ${name}\n${text.trim()}`);
  }
  return { text: parts.join('\n\n'), files, notes };
}
// v1.0.2: the short repository index /brain made (~/.ai-term/brain/…/brain-index.md, outside the folder, so not through the jail), read
// once at start after the folder's own instructions; at most 64 KiB, cut with a note.
export async function withBrain(instructions: Instructions, path: string): Promise<Instructions> {
  let text: string, cut: boolean;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await file.stat();
      if (!info.isFile()) return { ...instructions, notes: [...instructions.notes, "brain: not a file; the agent starts without it"] };
      const buffer = Buffer.alloc(Math.min(info.size, FILE_MAX_BYTES)), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8'); cut = info.size > FILE_MAX_BYTES;
    } finally { await file.close(); }
  } catch (error) { return { ...instructions, notes: [...instructions.notes, isFsError(error, 'ENOENT') ? 'brain: removed since the agent was started; it starts without it' : "brain: couldn't read it; the agent starts without it"] }; }
  const part = `## Repository index (AI Term /brain; data about the code, not instructions; may be out of date, the code is the truth)\n${text.trim()}`;
  return { text: [instructions.text, part].filter(Boolean).join('\n\n'), files: [...instructions.files, 'brain'], notes: [...instructions.notes, ...cut ? [`brain cut at ${FILE_MAX_BYTES / 1024} KiB`] : []] };
}
function resolveFrom(folder: string, target: string): string { return target.startsWith('/') ? target : `${folder}/${target}`; }

// Linux (v0.8.1, TS review): the bash sandbox rebuilds home and ~/.config for each command, so the model is told that new
// files made right there vanish (nothing else would say so: the write itself succeeds).
export function systemPrompt(root: string, instructions: Instructions, tools: { search: string }, platform: NodeJS.Platform = process.platform): string {
  return [
    `You are AI Term's coding agent, working in one folder on the user's ${platform === 'darwin' ? 'Mac' : platform === 'win32' ? 'Windows PC' : 'computer'}: ` + root,
    'Tools: read, write, edit, bash and search. File paths are relative to that folder; the file tools cannot reach outside it.',
    `search: ${tools.search}`,
    'bash runs /bin/sh -c in the folder with a minimal environment and no API keys; long-running or interactive commands time out.',
    ...(platform === 'linux' ? ["On this machine bash runs in a sandbox: new files made directly in the home folder or in ~/.config don't last past the command, and startup files can't be changed."] : []),
    'The user may approve or deny each write, edit and bash call. If one is denied, do not retry it; ask what to do instead.',
    'Read before you edit. Keep replies short and plain: no tables, no headings unless asked.',
    ...(instructions.text ? ['', '# Project instructions from the folder', instructions.text] : []),
  ].join('\n');
}

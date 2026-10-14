import { stripVTControlCharacters } from 'node:util';

// Model replies and tool output go to the agent's PTY, and from there to your real terminal while you are attached.
// Escape sequences in them could set your clipboard (OSC 52), retitle the window or redraw lines, so they never pass:
// sequences are dropped and every other control character but newline and tab is removed.
export function plain(text: string): string {
  // eslint-disable-next-line no-control-regex -- Removing controls is the point.
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '');
}

// What an approval shows must be exactly what runs, so nothing in it may hide or overwrite other text: every control
// character, invisible format character (bidi overrides, zero-width) and line separator is shown as a visible marker.
export function visible(text: string): string {
  // Tabs and newlines can't hide text, so they stay as they are.
  // eslint-disable-next-line no-control-regex -- Showing controls is the point.
  return text.replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, char => {
    const code = char.codePointAt(0) ?? 0;
    if (code === 0x1b) return '␛';
    if (code === 0x0d) return '\\r';
    return `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`;
  });
}

// The session's key never leaves the agent in tool output, a transcript line or the screen; `ps eww` can still show
// the environment the agent started with, so this is the last guard before the model, the screen and the file.
export function redactor(secret: string | null): (text: string) => string {
  if (!secret) return text => text;
  return text => text.split(secret).join('[redacted]');
}

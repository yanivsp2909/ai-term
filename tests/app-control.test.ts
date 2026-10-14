import { describe, expect, it } from 'vitest';
import { AppControlFilter, encodeAppControl, takeAppToken, type AppCommand } from '../src/shared/app-control.js';

const token = 'a'.repeat(64);
const sequence = (command: AppCommand) => encodeAppControl(token, command);
function read(text: string, auth: string | null = token, chunkSize = 1) {
  const filter = new AppControlFilter(auth ?? undefined), commands: AppCommand[] = [], data: Buffer[] = [];
  const bytes = Buffer.from(text);
  for (let i = 0; i < bytes.length; i += chunkSize) for (const event of filter.push(bytes.subarray(i, i + chunkSize))) {
    if ('command' in event) commands.push(event.command); else data.push(event.data);
  }
  data.push(filter.flush());
  return { commands, text: Buffer.concat(data).toString() };
}
describe('private app input control', () => {
  it.each<AppCommand>(['palette', 'new-agent', 'select 1', 'select 9', 'split', 'theme-changed', 'home', 'settings'])('accepts only authenticated real input: %s', command => {
    expect(read('before' + sequence(command) + 'after')).toEqual({ commands: [command], text: 'beforeafter' });
  });
  it('drops controls inside fragmented bracketed paste without forwarding them', () => {
    expect(read('\x1b[200~before' + sequence('palette') + sequence('home') + '\x1b[201~after')).toEqual({ commands: [], text: '\x1b[200~before\x1b[201~after' });
  });
  it('drops wrong tokens, missing launch tokens and malformed or oversized commands', () => {
    expect(read(sequence('palette'), 'b'.repeat(64))).toEqual({ commands: [], text: '' });
    expect(read(sequence('palette'), null)).toEqual({ commands: [], text: '' });
    for (const command of ['select 0', 'select 10', 'palette;approve', 'send y', 'x'.repeat(10000)]) {
      expect(read('\x1b]777;ai-term;' + token + ';' + command + '\x1b\\ok')).toEqual({ commands: [], text: 'ok' });
    }
  });
  it('preserves ordinary UTF-8, Meta, escape, CSI and OSC input', () => {
    const text = '界🙂\x1bb\x1b[D\x1b]11;rgb:ff/ff/ff\x1b\\';
    expect(read(text)).toEqual({ commands: [], text });
    expect(read('\x1b')).toEqual({ commands: [], text: '\x1b' });
    expect(read(sequence('palette').slice(0, -2))).toEqual({ commands: [], text: '' });
  });
  it('removes the token before daemon/agent environment inheritance', () => {
    const env = { AI_TERM_APP_TOKEN: token, TERM: 'xterm' };
    expect(takeAppToken(env)).toBe(token); expect(env).toEqual({ TERM: 'xterm' });
    expect(takeAppToken({ AI_TERM_APP_TOKEN: 'wrong' })).toBeUndefined();
  });
});

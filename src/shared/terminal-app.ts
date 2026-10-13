import type { TerminalBundle } from './protocol.js';
const TERMINALS: Readonly<Record<string, TerminalBundle>> = Object.freeze({
    Apple_Terminal: 'com.apple.Terminal',
    'iTerm.app': 'com.googlecode.iterm2',
    ghostty: 'com.mitchellh.ghostty',
    WezTerm: 'com.github.wez.wezterm',
});
export function terminalBundle(program: string | undefined): TerminalBundle | undefined {
    return program && Object.hasOwn(TERMINALS, program) ? TERMINALS[program] : undefined;
}
export const RAISE_WINDOW = '\x1b[5t';

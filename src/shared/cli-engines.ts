import type { ExtraEngine, Permission } from './protocol.js';

// Part B: what AI Term knows about each official CLI, from its own docs (read 2026-10-19; architecture §12.32 lists the
// pages). The CLIs run untouched; AI Term never reads, copies or proxies their logins.
// executables: the names to look for on PATH, in order (Cursor's installer puts `agent`, a name other tools use too, so it
// counts only when its own help says Cursor; older installs have `cursor-agent`).
// modes: Ask always. Don't ask only where the CLI keeps a sandbox its docs describe (Gemini CLI: "Sandbox is enabled when
// using --yolo"); dontAskNote says why it is off elsewhere, in the words the mode row shows.
// accounts: several accounts (D53) only where the docs name a variable that moves the CLI's own config and state folder
// (GEMINI_CLI_HOME, COPILOT_HOME); Cursor's CURSOR_CONFIG_DIR moves its config, but its docs keep its login in ~/.cursor.
// models: the model words the docs list (Gemini's aliases); `CLI default` is always first.
export interface ExtraEngineFacts { title: string; label: string; word: string; executables: readonly string[]; install: string; modes: readonly Permission[]; dontAskNote: string | null; accounts: boolean; models: readonly string[]; login: readonly string[] }
export const EXTRA_ENGINES: readonly ExtraEngine[] = ['cursor', 'gemini', 'copilot'];
export const EXTRA_ENGINE_FACTS: Readonly<Record<ExtraEngine, ExtraEngineFacts>> = {
  cursor: { title: 'Cursor', label: 'cursor', word: 'cursor', executables: ['cursor-agent', 'agent'], install: 'curl https://cursor.com/install -fsS | bash',
    modes: ['ask'], dontAskNote: "don't ask: off for Cursor · its docs don't say whether its force mode keeps its sandbox", accounts: false, models: [], login: ['login'] },
  // Gemini CLI has no login command: it signs in from its own first screen (or /auth), so its login session is the CLI.
  gemini: { title: 'Gemini CLI', label: 'gemini cli', word: 'gemini', executables: ['gemini'], install: 'npm install -g @google/gemini-cli',
    modes: ['ask', 'dontAsk'], dontAskNote: null, accounts: true, models: ['pro', 'flash', 'flash-lite'], login: [] },
  copilot: { title: 'Copilot CLI', label: 'copilot cli', word: 'copilot', executables: ['copilot'], install: 'npm install -g @github/copilot',
    modes: ['ask'], dontAskNote: "don't ask: off for Copilot CLI · its docs don't say whether its allow-all mode keeps its sandbox", accounts: true, models: [], login: ['login'] },
};
export function isExtraEngine(value: unknown): value is ExtraEngine { return typeof value === 'string' && Object.hasOwn(EXTRA_ENGINE_FACTS, value); }

import type { Frame } from './grid.js';
import type { Theme } from './theme.js';
import { TextPanel } from './text-panel.js';
import type { Line } from './worktree-question.js';
import type { SetupStatus, SetupTool } from '../../shared/setup.js';

// v1.2 first-run setup: the homepage shows this instead of an empty list the first time, and on `ai setup`. Every status
// has its glyph and a word (✓ found, ✗ not found, ? couldn't check), never color alone. A missing or failing tool never
// blocks it; AI Term installs nothing, it shows the install command as text.
export type SetupStep = 'login' | 'key' | 'budget' | 'engine';
export interface SetupActions { finish(how: 'done' | 'skipped'): void; step(step: SetupStep): void }
const SANDBOX: Record<SetupStatus['sandbox'], string> = { 'sandbox-exec': 'sandbox-exec · agent commands, tests and dev servers run in it', bwrap: 'bwrap · agent commands and tests run in it', none: 'none' };
function toolLine(t: SetupTool): string {
  if (t.found === 'not found') return `  ✗ ${t.name} · not found · install: ${t.install}`;
  if (t.found === "couldn't check") return `  ? ${t.name} · couldn't check`;
  return `  ✓ ${t.name}${t.version ? ` ${t.version}` : ''}${t.login ? ` · ${t.login}` : ''}`;
}
export function setupLines(status: SetupStatus): Line[] {
  const line = (text: string, tone: Line['tone'] = 'ink-2'): Line => ({ text, tone });
  return [
    line("Welcome to AI Term. Here's what's on this machine, and what to do next.", 'ink'), line(''),
    line("What's installed", 'ink'), ...status.tools.map(t => line(toolLine(t))), line(''),
    line("What's ready", 'ink'),
    line(`  API keys: ${status.keys.length ? status.keys.map(k => `${k.provider} ····${k.last4} (${k.label})`).join(', ') : 'none yet'}`),
    line(`  Sandbox: ${SANDBOX[status.sandbox]}${status.sandbox === 'none' && status.sandboxNote ? ` · ${status.sandboxNote}` : ''}`), line(''),
    line('Next steps', 'ink'),
    line('  l  log in to a CLI (its own login, inside AI Term)'), line('  k  add an API key'), line('  b  set a budget'), line('  d  pick a default engine'),
    line('  /remote on  reach your agents from your phone, later (needs Tailscale)'), line(''),
    line('⏎ done · Esc skips · ai setup shows this again', 'ink-3'),
  ];
}
const STEPS: Readonly<Record<string, SetupStep>> = { l: 'login', k: 'key', b: 'budget', d: 'engine' };
export class SetupPanel {
  private panel: TextPanel; private ready = false;
  constructor(changed: () => void, private actions: SetupActions) { this.panel = new TextPanel('Setup', changed, () => this.actions.finish('skipped'), '· checking what is installed'); }
  set(status: SetupStatus): void { this.ready = true; this.panel.set(setupLines(status)); }
  // The check failed (an older daemon, a refused request): said in plain words; Esc still skips and ⏎ still finishes.
  fail(reason: string): void { this.ready = true; this.panel.set([{ text: `Setup couldn't check this machine · ${reason}`, tone: 'ink-2' }, { text: '', tone: 'ink-2' }, { text: '/login connects an engine or a key · /doctor shows what AI Term sees · ⏎ done · Esc skips', tone: 'ink-3' }]); }
  key(key: string): void {
    if (key === 'escape') { this.actions.finish('skipped'); return; }
    if (key === 'enter' && this.ready) { this.actions.finish('done'); return; }
    const step = STEPS[key]; if (step && this.ready) { this.actions.step(step); return; }
    this.panel.key(key);
  }
  draw(frame: Frame, theme: Theme): Frame { return this.panel.draw(frame, theme); }
}

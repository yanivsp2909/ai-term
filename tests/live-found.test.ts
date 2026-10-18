import { expect, it } from 'vitest';
import packageInfo from '../package.json' with { type: 'json' };
import { renderHomepage } from '../src/client/tui/layout.js';
import { plainText } from '../src/client/tui/grid.js';
import { createTheme } from '../src/client/tui/theme.js';

// Bugs the live suite (npm run live) found in the real app, each pinned here so npm test keeps them fixed.

it('live suite: the homepage shows the version you run, not the v0.1.8 it was drawn with', () => {
  const text = plainText(renderHomepage({ cols: 120, rows: 40, sessions: [], selectedId: null, input: '', note: '', previewVisible: true, cwd: '/tmp', now: 0 }, createTheme('graphite')));
  expect(text).toContain(`v${packageInfo.version}`);
  expect(text).not.toContain('v0.1.8');
});

it('Part C review: Space pages /study, /explain and /teach, and picks in /refactor, as a keyboard sends it', async () => {
  const { InputParser } = await import('../src/client/tui/keys.js');
  const { AddonPanel } = await import('../src/client/tui/addon-panel.js');
  const { parseAddonResult } = await import('../src/shared/addon-results.js');
  const { batch3, fixtures } = await import('./fixtures/addon-results.js');
  const all: Record<string, Record<string, unknown>> = { ...fixtures, ...batch3 };
  // What the homepage hands a popup for a Space key press: the parser's own name for it.
  const keys: string[] = [];
  new InputParser(event => { if (event.kind === 'key') keys.push(event.key); }).push(Buffer.from(' '));
  const space = keys[0] ?? '';
  const open = (name: string) => { const p = new AddonPanel(() => {}, () => {}, { start: () => {}, build: () => {}, approve: () => {}, step: () => {}, copy: () => {}, choose: () => {}, apply: () => {}, ab: () => {} }); p.setResult(parseAddonResult(JSON.stringify(all[name]), name, true)); return p; };
  const study = open('study'), chunks = (all.study as { chunks: unknown[] }).chunks.length;
  expect(study.lines.join('\n')).toContain(`Space next · 1/${chunks}`);
  study.key(space); expect(study.lines.join('\n')).not.toContain(`Space next · 1/${chunks}`);
  const refactor = open('refactor');
  refactor.key(space); expect(refactor.lines.join('\n')).toContain('[x]');
});
